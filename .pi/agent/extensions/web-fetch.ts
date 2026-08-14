/**
 * web-fetch extension for pi — single self-contained file.
 *
 * Fetch a URL and extract content as markdown, text, or raw HTML.
 *
 * Security / robustness (see REFACTOR_PLAN.md §2.2):
 *   - WF-1: every hop (initial URL and each redirect) is validated twice —
 *     URL-level checks (http/https, no credentials, no private/loopback
 *     literals) and DNS-level checks (all resolved addresses must be global
 *     unicast; IPv4-mapped private IPv6 is refused). Connections are pinned
 *     to the validated address set via a custom `lookup`, eliminating the
 *     DNS-rebinding window between check and connect.
 *   - WF-2: one composite abort signal covers fetch → redirects/retries →
 *     header validation → body streaming → cleanup. The timeout timer and
 *     parent-cancel listener stay armed until the body is fully read.
 *   - WF-3: byte-capped downloads are reported as captured *prefixes*; the
 *     output never claims to be the full content when the real total length
 *     is unknown.
 *   - WF-4: `max_chars` is clamped to a hard ceiling at schema and runtime.
 *   - WF-5: every Response is owned by try/finally; replaced/redirected
 *     responses have their bodies cancelled and error bodies are read with
 *     a cap before cancellation.
 *   - Extras: charset/BOM/<meta charset> handling, binary magic-byte/NUL
 *     detection, relative links resolved against the final URL, structured
 *     error classification, URL sanitization, temp-file quota/TTL, and
 *     request merging with a short-TTL success cache.
 *
 * (The §6 "mature HTML parser + Readability + turndown" upgrade would need
 * npm dependencies and is intentionally not included — this file stays a
 * single distributable unit with zero third-party deps.)
 */

import { chmod, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { createBrotliDecompress, createGunzip, inflate as zlibInflate, inflateRaw as zlibInflateRaw } from "node:zlib"
import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { Readable } from "node:stream"
import { Type, StringEnum } from "@earendil-works/pi-ai"
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, defineTool, getMarkdownTheme, keyHint, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Container, Markdown, Text } from "@earendil-works/pi-tui"

// ── Limits ───────────────────────────────────────────────────────────────────

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB captured body cap
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_MAX_CHARS = 50_000
// WF-4: hard cap for max_chars — several multiples of pi's 50KB inline limit,
// but never unbounded (schema enforces this too, runtime re-clamps).
const HARD_MAX_CHARS = 200_000
const MAX_REDIRECTS = 5
// HTML→Markdown conversion only processes this many source characters. The
// inline output cap is 50k, so converting more source than ~5x the cap is
// wasted synchronous work on the event loop; oversized bodies spill the
// captured raw prefix to a temp file instead.
const CONVERT_SOURCE_CAP = 250_000
const ERROR_BODY_MAX_CHARS = 2_000
const FETCH_TEMP_DIR_PREFIX = "pi-web-fetch-"
const MERGE_CACHE_TTL_MS = 10_000
const ARTIFACT_QUOTA_BYTES = 64 * 1024 * 1024
const ARTIFACT_MAX_FILE_BYTES = 32 * 1024 * 1024
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000

const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
const FALLBACK_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

const BINARY_CONTENT_TYPE_PREFIXES = ["image/", "video/", "audio/"]
const BINARY_CONTENT_TYPES = new Set([
	"application/pdf",
	"application/zip",
	"application/x-zip-compressed",
	"application/gzip",
	"application/x-gzip",
	"application/x-tar",
	"application/octet-stream",
])

// ── Error classification / URL sanitization ──────────────────────────────────

type WebErrorCode =
	| "invalid_url"
	| "ssrf_blocked"
	| "dns_failed"
	| "timeout"
	| "aborted"
	| "http"
	| "too_large"
	| "unsupported_type"
	| "protocol"
	| "too_many_redirects"

class WebToolError extends Error {
	readonly code: WebErrorCode

	constructor(code: WebErrorCode, message: string) {
		super(message)
		this.name = "WebToolError"
		this.code = code
	}
}

const SENSITIVE_QUERY_PATTERN = /(token|key|auth|passw(or)?d|secret|sig(nature)?|credential|session)/i

/** Strip credentials from a URL for display/logging. */
function sanitizeUrl(raw: string): string {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		return raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i, (m) => m.slice(0, m.indexOf("//") + 2))
	}
	parsed.username = ""
	parsed.password = ""
	parsed.hash = ""
	for (const key of [...parsed.searchParams.keys()]) {
		if (SENSITIVE_QUERY_PATTERN.test(key)) parsed.searchParams.set(key, "[redacted]")
	}
	return parsed.toString()
}

/** Short, safe summary of an HTTP error body (never leaks echoed credentials). */
function sanitizeHttpBody(body: string, maxChars = 500): string {
	let text = body.replace(/("?)(authorization|api[_-]?key|access[_-]?token|password|secret)\1?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1$2$1: "[redacted]"`)
	// eslint-disable-next-line no-control-regex
	text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
	if (text.length <= maxChars) return text.trim()
	return `${text.slice(0, maxChars).trimEnd()}... [truncated]`
}

/** Parse a Retry-After header (seconds or HTTP date) into seconds. */
function parseRetryAfter(header: string | null): number | undefined {
	if (!header) return undefined
	const trimmed = header.trim()
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number.parseInt(trimmed, 10)
		return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
	}
	const date = Date.parse(trimmed)
	if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000))
	return undefined
}

/** Classify an unknown thrown value, preserving WebToolError codes. */
function asWebToolError(error: unknown, fallbackCode: WebErrorCode = "http"): WebToolError {
	if (error instanceof WebToolError) return error
	if (error instanceof Error) {
		const message = error.message
		if (/aborted/i.test(message)) return new WebToolError("aborted", message)
		if (/timed? ?out/i.test(message)) return new WebToolError("timeout", message)
		if (/too (large|big)/i.test(message)) return new WebToolError("too_large", message)
		if (/redirect/i.test(message)) return new WebToolError("too_many_redirects", message)
		if (/private|loopback|ssrf|refus/i.test(message)) return new WebToolError("ssrf_blocked", message)
		return new WebToolError(fallbackCode, message)
	}
	return new WebToolError(fallbackCode, String(error))
}

// ── URL / DNS validation and address pinning (WF-1) ──────────────────────────

const SUPPORTED_HTTP_PROTOCOLS = new Set(["http:", "https:"])

function isPrivateOrLoopbackIpv4(raw: string): boolean {
	const v4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (!v4) return false
	const octets = v4.slice(1).map(Number)
	if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
	const [a, b] = octets
	if (a === 0 || a === 10 || a === 127) return true
	if (a >= 224) return true // multicast (224-239) and reserved (240-255)
	if (a === 169 && b === 254) return true // link-local / APIPA
	if (a === 172 && b >= 16 && b <= 31) return true // private
	if (a === 192 && b === 168) return true // private
	if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
	if (a === 192 && (b === 0 || b === 0x7f || (b === 88 && octets[2] === 99))) return true // documentation
	if (a === 198 && (b === 18 || b === 19 || (b === 51 && octets[2] === 100))) return true // benchmarking
	if (a === 203 && b === 0 && octets[2] === 113) return true // documentation
	if (a === 192 && b === 31 && octets[2] === 196) return true // AS112
	return false
}

function isPrivateOrLoopbackIpv6(raw: string): boolean {
	let addr = raw.toLowerCase().replace(/^\[|\]$/g, "")
	if (addr.includes(".")) {
		// IPv4-mapped or IPv4-compatible: validate the embedded IPv4.
		const parts = addr.split(":")
		return isPrivateOrLoopbackIpv4(parts[parts.length - 1] ?? "")
	}
	if (!addr.includes(":") || isIP(addr) !== 6) return false
	if (addr === "::" || addr === "::1") return true
	const first = Number.parseInt(addr.split(":")[0] ?? "", 16)
	if (Number.isFinite(first)) {
		if (first >= 0xfe80 && first <= 0xfebf) return true // link-local fe80::/10
		if (first >= 0xfc00 && first <= 0xfdff) return true // unique-local fc00::/7
		if (first >= 0xff00) return true // multicast ff00::/8
		if (first >= 0xfec0) return true // deprecated site-local fec0::/10
		if (addr.startsWith("2001:db8")) return true // documentation 2001:db8::/32
		if (first === 0x3fff) return true // documentation 3fff::/20
		if (first === 0x0064) return true // NAT64 64:ff9b::/96 — can encode private IPv4
		if (first === 0x2002) return true // 6to4 2002::/16 — embeds arbitrary IPv4
	}
	return false
}

function isPrivateOrLoopbackHostname(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
	if (h === "localhost" || h.endsWith(".localhost")) return true
	if (h.includes(":")) return isPrivateOrLoopbackIpv6(h)
	return isPrivateOrLoopbackIpv4(h)
}

/**
 * Parse and assert a URL is http(s), credential-free, and not a
 * private/loopback literal. DNS is resolved separately (see below) before
 * connecting — both checks run for every hop.
 */
function parseAndAssertHttpUrl(raw: string): URL {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		throw new WebToolError("invalid_url", `Invalid URL: ${raw}`)
	}
	if (!SUPPORTED_HTTP_PROTOCOLS.has(parsed.protocol)) {
		throw new WebToolError("invalid_url", `Unsupported URL protocol: ${parsed.protocol}. Only http and https are supported.`)
	}
	if (parsed.username || parsed.password) {
		throw new WebToolError("invalid_url", "URLs with embedded credentials (user:pass@) are not supported.")
	}
	if (isPrivateOrLoopbackHostname(parsed.hostname)) {
		throw new WebToolError("ssrf_blocked", `Refusing to fetch private/loopback address: ${parsed.hostname}`)
	}
	return parsed
}

interface ValidatedAddress {
	address: string
	family: 4 | 6
}

/** Resolve `host` and validate every returned address is global unicast. */
async function resolveValidatedAddresses(host: string): Promise<ValidatedAddress[]> {
	let results: Array<{ address: string; family: number }>
	try {
		results = await lookup(host, { all: true, verbatim: true })
	} catch (error) {
		throw new WebToolError("dns_failed", `DNS lookup failed for ${host}: ${error instanceof Error ? error.message : String(error)}`)
	}
	const validated: ValidatedAddress[] = []
	for (const result of results) {
		const family = result.family === 6 ? 6 : 4
		const blocked = family === 6 ? isPrivateOrLoopbackIpv6(result.address) : isPrivateOrLoopbackIpv4(result.address)
		if (blocked) {
			throw new WebToolError("ssrf_blocked", `Refusing to fetch ${host}: DNS resolves to non-global address ${result.address}`)
		}
		validated.push({ address: result.address, family })
	}
	if (validated.length === 0) {
		throw new WebToolError("dns_failed", `DNS lookup returned no addresses for ${host}`)
	}
	return validated
}

type LookupOptions = { all?: boolean; family?: number | "IPv4" | "IPv6"; hints?: number } | null | undefined

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void

/**
 * Pin outgoing connections to the pre-validated address set. The socket
 * connects to exactly the addresses we validated — the check and the
 * connect can no longer disagree (no DNS-rebinding window).
 *
 * Node's http agent requests `all: true` (array form) for connect-multiple;
 * both callback shapes are supported. Round-robin across validated
 * addresses keeps multi-address hosts working.
 */
function pinnedLookup(validated: readonly ValidatedAddress[]) {
	let index = 0
	return (_hostname: string, options: LookupOptions, callback: LookupCallback): void => {
		if (validated.length === 0) {
			callback(Object.assign(new Error("no validated addresses"), { code: "ENOTFOUND" }), "")
			return
		}
		if (options?.all) {
			callback(null, validated.map((v) => ({ address: v.address, family: v.family })))
			return
		}
		const next = validated[index % validated.length]
		index += 1
		callback(null, next.address, next.family)
	}
}

// ── Fetch over node:http/https with pinned addresses (WF-1) ──────────────────

/** Perform one GET with every connection pinned to pre-validated addresses. */
async function fetchOncePinned(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ response: Response; declaredLength?: number }> {
	const parsed = parseAndAssertHttpUrl(url)
	const host = parsed.hostname
	const validated = await resolveValidatedAddresses(host)
	if (signal.aborted) throw new WebToolError("aborted", "aborted")

	return new Promise<{ response: Response; declaredLength?: number }>((resolve, reject) => {
		const transport = parsed.protocol === "https:" ? httpsRequest : httpRequest
		const request = transport(
			{
				hostname: host,
				port: parsed.port || undefined,
				path: parsed.pathname + parsed.search,
				method: "GET",
				headers,
				signal,
				lookup: pinnedLookup(validated) as (hostname: string, options: LookupOptions, callback: LookupCallback) => void,
				servername: parsed.protocol === "https:" ? host : undefined,
			},
			(msg: IncomingMessage) => {
				const declared = parseDeclaredLength(msg.headers["content-length"])
				const encoding = String(msg.headers["content-encoding"] ?? "").toLowerCase()
				const responseHeaders = new Headers()
				for (const [key, value] of Object.entries(msg.headers)) {
					if (value === undefined) continue
					const lower = key.toLowerCase()
					// After decompression these no longer describe the body.
					if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") continue
					if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v)
					else responseHeaders.set(key, String(value))
				}

				const makeResponse = (bodyStream: Readable): { response: Response; declaredLength?: number } => ({
					response: new Response(Readable.toWeb(bodyStream) as ReadableStream, {
						status: msg.statusCode ?? 200,
						statusText: msg.statusMessage ?? "",
						headers: responseHeaders,
					}),
					// The declared length only pre-checks when the body is NOT
					// re-encoded (decompressed) on our side.
					declaredLength: encoding ? undefined : declared,
				})

				if (encoding === "deflate") {
					// Some servers send raw (unwrapped) deflate despite the header.
					// Buffer the compressed body (capped) and try the zlib wrapper
					// first, falling back to raw inflate on header mismatch.
					decompressDeflate(msg).then(
						(buffer) => resolve(makeResponse(Readable.from(buffer))),
						(error) => reject(error instanceof Error ? error : new Error(String(error))),
					)
					return
				}

				let bodyStream: Readable = msg
				if (encoding === "gzip" || encoding === "x-gzip") bodyStream = msg.pipe(createGunzip())
				else if (encoding === "br") bodyStream = msg.pipe(createBrotliDecompress())
				resolve(makeResponse(bodyStream))
			},
		)
		request.on("error", (error: NodeJS.ErrnoException) => {
			if (signal.aborted) {
				reject(signal.reason instanceof Error ? signal.reason : new WebToolError("aborted", "aborted"))
			} else if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
				reject(new WebToolError("dns_failed", `DNS lookup failed for ${sanitizeUrl(url)}: ${error.message}`))
			} else {
				const detail = error.message || error.code || "unknown network error"
				reject(new WebToolError("http", `Request to ${sanitizeUrl(url)} failed: ${detail}`))
			}
		})
		request.end()
	})
}

function parseDeclaredLength(header: string | string[] | undefined): number | undefined {
	if (header === undefined) return undefined
	const raw = Array.isArray(header) ? header[0] : header
	const length = Number.parseInt(raw ?? "", 10)
	return Number.isFinite(length) && length >= 0 ? length : undefined
}

/** Decompress a "deflate" body, falling back to raw deflate (no zlib wrapper). */
async function decompressDeflate(msg: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of msg) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
		size += buffer.byteLength
		if (size > MAX_RESPONSE_SIZE) {
			msg.destroy()
			throw new WebToolError("too_large", `Compressed response exceeds ${formatSize(MAX_RESPONSE_SIZE)}`)
		}
		chunks.push(buffer)
	}
	const compressed = Buffer.concat(chunks)
	return await new Promise<Buffer>((resolve, reject) => {
		zlibInflate(compressed, (error, out) => {
			if (!error) return resolve(out)
		zlibInflateRaw(compressed, (rawError, rawOut) => {
			if (!rawError) return resolve(rawOut)
			reject(new WebToolError("http", `Failed to decompress deflate response: ${rawError.message}`))
		})
		})
	})
}

function isRedirect(response: Response): boolean {
	return response.status >= 300 && response.status < 400 && response.headers.has("location")
}

/**
 * Manual redirect chain. Every hop is re-validated (URL + DNS pin) before
 * connecting, so a redirect cannot smuggle the request to a private host or
 * a rebinding domain. Replaced responses are cancelled (WF-5).
 */
async function fetchFollowingRedirects(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string; declaredLength?: number }> {
	let currentUrl = url
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		parseAndAssertHttpUrl(currentUrl)
		const { response, declaredLength } = await fetchOncePinned(currentUrl, headers, signal)
		if (!isRedirect(response)) return { response, finalUrl: currentUrl, declaredLength }

		const location = response.headers.get("location")
		if (!location) return { response, finalUrl: currentUrl, declaredLength }
		if (redirects === MAX_REDIRECTS) {
			await response.body?.cancel()
			throw new WebToolError("too_many_redirects", `Too many redirects (>${MAX_REDIRECTS})`)
		}
		// Parse BEFORE cancelling, and if the Location is malformed still
		// release the response — otherwise its socket leaks (WF-5 fix).
		let nextUrl: URL
		try {
			nextUrl = new URL(location, currentUrl)
		} catch {
			await response.body?.cancel()
			throw new WebToolError("invalid_url", `Redirect to invalid Location "${location.slice(0, 120)}"`)
		}
		await response.body?.cancel()
		currentUrl = nextUrl.toString()
	}
	throw new WebToolError("too_many_redirects", `Too many redirects (>${MAX_REDIRECTS})`)
}

// ── HTML entity decoding ─────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
	nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
	ndash: "–", mdash: "—", lsquo: "\u2018", rsquo: "\u2019",
	ldquo: "\u201C", rdquo: "\u201D", hellip: "\u2026", copy: "\u00A9",
	reg: "\u00AE", trade: "\u2122",
}

function codePointToString(value: number): string {
	try {
		return String.fromCodePoint(value)
	} catch {
		return ""
	}
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_, n) => codePointToString(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => codePointToString(parseInt(n, 16)))
		.replace(/&(\w+);/g, (m, name) => NAMED_ENTITIES[name] || m)
}

// ── Charset detection / decoding (charset/BOM/<meta charset>) ─────────────────

function normalizeCharsetLabel(label: string): string {
	const normalized = label.trim().toLowerCase().replace(/["']/g, "")
	if (normalized === "utf8") return "utf-8"
	if (normalized === "latin1" || normalized === "iso-8859-1" || normalized === "latin-1") return "windows-1252"
	return normalized
}

/** BOM sniff: returns the implied label, or undefined when no BOM. */
function sniffBomLabel(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8"
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
	return undefined
}

function sniffMetaCharset(bytes: Uint8Array): string | undefined {
	const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024)).toString("latin1")
	const direct = head.match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)
	if (direct) return normalizeCharsetLabel(direct[1]!)
	const content = head.match(/<meta\b[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i)
	if (content) return normalizeCharsetLabel(content[1]!)
	return undefined
}

/** Charset precedence: BOM → content-type header → <meta charset> → utf-8. */
function detectCharset(bytes: Uint8Array, contentType: string): string {
	// A BOM is authoritative: a mislabelled header must not turn a UTF-16
	// document into a NUL-filled "binary" false positive.
	const bom = sniffBomLabel(bytes)
	if (bom) return bom
	const header = contentType.match(/charset\s*=\s*["']?([\w-]+)/i)
	if (header) return normalizeCharsetLabel(header[1]!)
	const meta = sniffMetaCharset(bytes)
	if (meta) return meta
	return "utf-8"
}

/** Decode with the detected charset; unknown labels fall back to lenient UTF-8. */
function decodeBytes(bytes: Uint8Array, charset: string): string {
	try {
		return new TextDecoder(charset).decode(bytes)
	} catch {
		return new TextDecoder("utf-8").decode(bytes)
	}
}

// ── Binary detection (magic bytes / NUL) ─────────────────────────────────────

function assertSupportedContentType(contentType: string): void {
	const type = contentType.split(";")[0]?.trim().toLowerCase()
	if (!type) return
	if (BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix)) || BINARY_CONTENT_TYPES.has(type)) {
		throw new WebToolError("unsupported_type", `Unsupported content type: ${contentType}. web-fetch supports text-like content only.`)
	}
}

/** Magic-byte + NUL sniffing catches binary payloads mislabeled as text. */
function looksBinary(bytes: Uint8Array, text: string): boolean {
	const head = bytes.subarray(0, Math.min(bytes.length, 512))
	const signatures: Array<number[]> = [
		[0x89, 0x50, 0x4e, 0x47], // PNG
		[0xff, 0xd8, 0xff], // JPEG
		[0x42, 0x4d], // BMP
		[0x25, 0x50, 0x44, 0x46], // %PDF
		[0x50, 0x4b, 0x03, 0x04], // ZIP (also docx/pptx)
		[0x50, 0x4b, 0x05, 0x06],
		[0x50, 0x4b, 0x07, 0x08],
		[0x7f, 0x45, 0x4c, 0x46], // ELF
		[0xca, 0xfe, 0xba, 0xbe], // Mach-O
		[0x1f, 0x8b], // gzip
		[0x00, 0x00, 0x01, 0x00], // ICO
		[0xd0, 0xcf, 0x11, 0xe0], // OLE2 (doc/xls)
	]
	if (signatures.some((sig) => sig.every((byte, i) => head[i] === byte))) return true
	const ascii = Buffer.from(head.buffer, head.byteOffset, Math.min(head.byteLength, 16)).toString("latin1")
	if (/^(GIF8|RIFF....WEBP|OggS|fLaC|ID3|MThd|ftyp)/.test(ascii)) return true
	// NUL bytes in the decoded prefix are a strong binary signal.
	return text.slice(0, 1024).includes("\u0000")
}

// ── HTML extraction / conversion ─────────────────────────────────────────────

const SKIP_TAGS = new Set(["script", "style", "noscript", "iframe", "object", "embed", "svg", "math"])

function stripSkippedTags(html: string): string {
	let text = html
	for (const tag of SKIP_TAGS) {
		text = text.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ")
		text = text.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ")
	}
	return text
}

function extractTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
	if (!match) return undefined
	const title = decodeEntities(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
	return title || undefined
}

function plainTextLength(html: string): number {
	return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).length
}

function extractReadableHTML(html: string): string {
	const withoutChrome = stripSkippedTags(html)
		.replace(/<(header|nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<div\b[^>]*(?:class|id)=["'][^"']*(?:Header|footer|Footer|navigation|Navigation|menu|Menu|flash|Flash|feedback|Feedback)[^"']*["'][^>]*>[\s\S]*?<\/div>/g, " ")

	const patterns = [
		/<article\b[^>]*>[\s\S]*?<\/article>/gi,
		/<main\b[^>]*>[\s\S]*?<\/main>/gi,
		/<div\b[^>]*(?:class|id)=["'][^"']*(?:post-content|entry-content|article-content|post-body|markdown-body|readme|content__default)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
	]
	let best = ""
	let bestLength = 0
	for (const pattern of patterns) {
		for (const match of withoutChrome.matchAll(pattern)) {
			const candidate = match[0]
			const length = plainTextLength(candidate)
			if (length > bestLength) {
				best = candidate
				bestLength = length
			}
		}
	}
	return bestLength >= 200 ? best : withoutChrome
}

function extractTextFromHTML(html: string): string {
	let text = extractReadableHTML(html)
	text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|header|footer|nav)>/gi, "\n")
	text = text.replace(/<br\s*\/?>/gi, "\n")
	text = text.replace(/<[^>]+>/g, " ")
	return decodeEntities(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * Resolve a link against the final fetched URL. Only http(s) targets without
 * userinfo survive; javascript:/data: and unparseable links are dropped
 * (text is kept, href is removed).
 */
function resolveLink(href: string, baseUrl: string | undefined): string | undefined {
	if (!href || !baseUrl) return undefined
	const trimmed = href.trim()
	if (!trimmed || trimmed.startsWith("#")) return undefined
	try {
		const resolved = new URL(trimmed, baseUrl)
		if (!SUPPORTED_HTTP_PROTOCOLS.has(resolved.protocol)) return undefined
		resolved.username = ""
		resolved.password = ""
		return resolved.toString()
	} catch {
		return undefined
	}
}

function convertHTMLToMarkdown(html: string, baseUrl: string | undefined): string {
	let md = extractReadableHTML(html)

	// Remove metadata/link tags entirely.
	md = md.replace(/<(meta|link)\b[^>]*\/?>/gi, "")

	// Convert headings.
	md = md.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
	md = md.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
	md = md.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
	md = md.replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
	md = md.replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
	md = md.replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")

	// Convert links: <a href="url">text</a> → [text](url); unsafe targets drop the href.
	md = md.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
		const resolved = resolveLink(href, baseUrl)
		return resolved ? `[${text}](${resolved})` : text
	})

	// Convert images: <img src="url" alt="text"> → ![text](url).
	md = md.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*\/?>/gi, (_m, alt: string, src: string) => {
		const resolved = resolveLink(src, baseUrl)
		return resolved ? `![${alt}](${resolved})` : `![${alt}]()`
	})
	md = md.replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, (_m, src: string, alt: string) => {
		const resolved = resolveLink(src, baseUrl)
		return resolved ? `![${alt}](${resolved})` : `![${alt}]()`
	})
	md = md.replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, (_m, src: string) => {
		const resolved = resolveLink(src, baseUrl)
		return resolved ? `![](${resolved})` : "![]()"
	})

	// Convert code blocks.
	md = md.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
	md = md.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
	md = md.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")

	// Convert emphasis.
	md = md.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
	md = md.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
	md = md.replace(/<del\b[^>]*>([\s\S]*?)<\/del>/gi, "~~$1~~")

	// Convert lists.
	md = md.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
	md = md.replace(/<\/?[ou]l\b[^>]*>/gi, "\n")

	// Convert paragraphs and line breaks.
	md = md.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n")
	md = md.replace(/<br\b[^>]*\/?>/gi, "\n")
	md = md.replace(/<hr\b[^>]*\/?>/gi, "\n---\n")
	md = md.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, content) => {
		return content.replace(/^/gm, "> ")
	})

	// Convert tables (basic).
	md = md.replace(/<th\b[^>]*>([\s\S]*?)<\/th>/gi, "| $1 ")
	md = md.replace(/<td\b[^>]*>([\s\S]*?)<\/td>/gi, "| $1 ")
	md = md.replace(/<\/tr>/gi, "|\n")

	// Remove remaining HTML tags.
	md = md.replace(/<[^>]+>/g, "")
	md = decodeEntities(md)
	md = md.replace(/\n{3,}/g, "\n\n")
	md = md.replace(/[ \t]+/g, " ")
	return md.trim()
}

// ── Streaming body read (WF-2 keeps the signal armed through this phase) ─────

/**
 * Read a response stream up to `MAX_RESPONSE_SIZE` bytes. A `Content-Length`
 * over the cap rejects immediately without consuming the stream; a stream
 * that grows past the cap is cut short (`truncatedByBytes`) rather than
 * rejected, so a server that under-reports still yields a bounded usable
 * body. Only actually-dropped bytes count as truncation.
 */
async function readBodyCapped(
	response: Response,
	maxBytes: number,
	declaredLength?: number,
): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
	if (declaredLength !== undefined && declaredLength > maxBytes) {
		await response.body?.cancel()
		throw new WebToolError(
			"too_large",
			`Response too large (declared ${formatSize(declaredLength)}; limit is ${formatSize(maxBytes)})`,
		)
	}

	if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

	const chunks: Uint8Array[] = []
	let total = 0
	let truncatedByBytes = false
	const reader = response.body.getReader()
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			const remaining = maxBytes - total
			if (value.byteLength > remaining) {
				chunks.push(value.subarray(0, remaining))
				total += remaining
				truncatedByBytes = true
				break
			}
			chunks.push(value)
			total += value.byteLength
		}
	} finally {
		// Best-effort cleanup: after a completed or capped read, release the
		// socket; the bytes we need are already collected.
		await reader.cancel().catch(() => {})
	}

	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { bytes, truncatedByBytes }
}

/** Read a bounded error-body prefix, then cancel the stream (WF-5). */
async function readErrorBody(response: Response): Promise<string> {
	if (response.body === null) return ""
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			const remaining = Math.max(0, ERROR_BODY_MAX_CHARS * 4 - total)
			if (value.byteLength > remaining) {
				chunks.push(value.subarray(0, remaining))
				total += remaining
				break
			}
			chunks.push(value)
			total += value.byteLength
		}
	} finally {
		await reader.cancel().catch(() => {})
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder("utf-8").decode(bytes)
}

// ── Spill / truncation (WF-3: captured-prefix semantics) ─────────────────────

function extensionForFormat(format: string): string {
	if (format === "html") return "html"
	if (format === "markdown") return "md"
	return "txt"
}

/** Spill kinds for footers and result details. */
type SpillKind = "markdown" | "text" | "html" | "captured-raw-html" | "captured-raw-text"

function spillLabel(kind: SpillKind): string {
	switch (kind) {
		case "captured-raw-html":
			return "Captured raw HTML (prefix)"
		case "captured-raw-text":
			return "Captured raw text (prefix)"
		default:
			return "Full content"
	}
}

/**
 * Complete-conversion truncation footer: the full converted output exists
 * and was spilled — real totals are known.
 */
function formatCompleteTruncationFooter(totalChars: number, maxChars: number, tempFile: string, kind: SpillKind): string {
	return `\n...[truncated]\n\n[Content truncated: showing ${maxChars.toLocaleString()} of ${totalChars.toLocaleString()} chars. ${spillLabel(kind)} saved to: ${tempFile}]`
}

/**
 * WF-3: captured-prefix footer. The download stopped at the byte/source cap,
 * so the "total" is only the captured prefix — the real total length is
 * unknown and the wording must not claim completeness.
 */
function formatCapturedTruncationFooter(capturedBytes: number, maxChars: number, tempFile: string, kind: SpillKind): string {
	return (
		`\n...[truncated]\n\n[Content truncated: showing ${maxChars.toLocaleString()} chars of the captured ` +
		`${formatSize(capturedBytes)} prefix. Remaining content not downloaded — true total length unknown. ` +
		`${spillLabel(kind)} saved to: ${tempFile}]`
	)
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// ── Temp-file manager (quota/TTL/atomic, cleaned on session shutdown) ────────

interface SpillResult {
	path: string
	bytes: number
	complete: boolean
}

/** Session-scoped spill directory with TTL, quota, atomic writes, mode 0600. */
class ArtifactManager {
	private rootPromise: Promise<string> | undefined
	private disposed = false

	async spill(fileName: string, content: string): Promise<SpillResult> {
		if (this.disposed) throw new WebToolError("aborted", "spill manager is disposed")
		const buffer = Buffer.from(content, "utf8")
		const capped = buffer.byteLength > ARTIFACT_MAX_FILE_BYTES
		const bytes = capped ? ARTIFACT_MAX_FILE_BYTES : buffer.byteLength

		const root = await this.ensureRoot()
		await this.sweepExpired(root)

		const safeName = fileName.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "content.txt"
		// M3 fix: every spill gets a unique file name — two truncated fetches
		// in one session must not overwrite each other's temp file.
		const dot = safeName.lastIndexOf(".")
		const stem = dot > 0 ? safeName.slice(0, dot) : safeName
		const ext = dot > 0 ? safeName.slice(dot) : ""
		const uniqueName = `${stem}-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`
		const finalPath = join(root, uniqueName)
		const tmpPath = join(root, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		try {
			await writeFile(tmpPath, buffer.subarray(0, bytes), { flag: "wx", mode: 0o600 })
			await chmod(tmpPath, 0o600)
			await rename(tmpPath, finalPath)
		} catch (error) {
			await rm(tmpPath, { force: true }).catch(() => {})
			throw error
		}
		await this.enforceQuota(root)
		return { path: finalPath, bytes, complete: !capped }
	}

	async cleanup(): Promise<void> {
		this.disposed = true
		const pending = this.rootPromise
		this.rootPromise = undefined
		const root = await pending?.catch(() => undefined)
		if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
	}

	private ensureRoot(): Promise<string> {
		// M8 fix: cache the promise, not the value — concurrent spills must not
		// race two mkdtemp calls and orphan one temp dir.
		if (!this.rootPromise) {
			this.rootPromise = (async () => {
				const root = await mkdtemp(join(tmpdir(), FETCH_TEMP_DIR_PREFIX))
				await chmod(root, 0o700).catch(() => {})
				return root
			})()
			this.rootPromise.catch(() => {
				this.rootPromise = undefined
			})
		}
		return this.rootPromise
	}

	private async sweepExpired(root: string): Promise<void> {
		const cutoff = Date.now() - ARTIFACT_TTL_MS
		for (const entry of await readdir(root).catch(() => [] as string[])) {
			if (entry.startsWith(".tmp-")) continue
			try {
				const info = await stat(join(root, entry))
				if (info.mtimeMs < cutoff) await rm(join(root, entry), { force: true })
			} catch {
				// Missing/racing file: nothing to do.
			}
		}
	}

	private async enforceQuota(root: string): Promise<void> {
		let total = 0
		const metas: Array<{ path: string; bytes: number; mtimeMs: number }> = []
		for (const entry of await readdir(root).catch(() => [] as string[])) {
			if (entry.startsWith(".tmp-")) continue
			const entryPath = join(root, entry)
			try {
				const info = await stat(entryPath)
				total += info.size
				metas.push({ path: entryPath, bytes: info.size, mtimeMs: info.mtimeMs })
			} catch {
				// ignore
			}
		}
		metas.sort((a, b) => a.mtimeMs - b.mtimeMs) // oldest first
		for (const meta of metas) {
			if (total <= ARTIFACT_QUOTA_BYTES) break
			await rm(meta.path, { force: true }).catch(() => {})
			total -= meta.bytes
		}
	}
}

/** Remove leftover temp dirs from previous (possibly crashed) sessions. */
async function sweepStaleArtifactRoots(): Promise<void> {
	const cutoff = Date.now() - ARTIFACT_TTL_MS
	for (const entry of await readdir(tmpdir()).catch(() => [] as string[])) {
		if (!entry.startsWith(FETCH_TEMP_DIR_PREFIX)) continue
		const entryPath = join(tmpdir(), entry)
		try {
			const info = await stat(entryPath)
			if (info.isDirectory() && info.mtimeMs < cutoff) await rm(entryPath, { recursive: true, force: true })
		} catch {
			// ignore
		}
	}
}

// ── Request scheduler (semaphore + per-host limit + merge + short-TTL cache) ──

interface PendingTask {
	host: string
	run: () => Promise<unknown>
	resolve: (value: unknown) => void
	reject: (error: unknown) => void
}

/** One shared in-flight request. Callers attach/detach individually. */
interface Flight {
	promise: Promise<unknown>
	controller: AbortController
	callers: Set<AbortSignal>
}

export interface ScheduleOptions {
	/** Caller's composite signal (user cancellation). Detaching never kills the flight while another caller waits. */
	signal?: AbortSignal
	/** Flight deadline in ms, armed when the request leaves the queue (queue wait does not burn the timeout). */
	timeoutMs?: number
}

class RequestScheduler {
	private readonly maxConcurrent = 4
	private readonly perHostLimit = 2
	private readonly maxCacheEntries = 50
	private active = 0
	private activeByHost = new Map<string, number>()
	private queue: PendingTask[] = []
	private flights = new Map<string, Flight>()
	private cache = new Map<string, { value: unknown; expiresAt: number }>()

	private static hostOf(key: string): string {
		try {
			return new URL(key).hostname.toLowerCase()
		} catch {
			return key
		}
	}

	/**
	 * Share identical in-flight keys; serve fresh cached successes only.
	 * M4 fix: a merged caller gets its own cancellation — aborting it only
	 * detaches; the shared flight dies when the last caller leaves (or its
	 * own deadline hits), so one caller can never kill another's request.
	 */
	schedule<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, opts?: ScheduleOptions): Promise<T> {
		const cached = this.cacheGet<T>(key)
		if (cached !== undefined) return Promise.resolve(cached)
		const existing = this.flights.get(key)
		if (existing) return this.attach(existing, opts?.signal) as Promise<T>

		const controller = new AbortController()
		const callers = new Set<AbortSignal>()
		const flight: Flight = { promise: Promise.resolve(null!), controller, callers }

		const promise = new Promise<T>((resolve, reject) => {
			this.queue.push({
				host: RequestScheduler.hostOf(key),
				run: () => {
					// Abandoned while queued (every caller left) — settle without running.
					if (controller.signal.aborted) {
						return Promise.reject(controller.signal.reason ?? new Error("aborted"))
					}
					// Flight-level deadline: armed at dequeue so queue wait never
					// burns the caller's timeout, and a hung flight can't outlive
					// the last interested caller.
					let timedOut = false
					let flightTimer: ReturnType<typeof setTimeout> | undefined
					if (opts?.timeoutMs) {
						flightTimer = setTimeout(() => {
							timedOut = true
							controller.abort(new WebToolError("timeout", `Request timed out after ${opts.timeoutMs}ms`))
						}, opts.timeoutMs)
					}
					const clear = () => clearTimeout(flightTimer)
					return Promise.resolve()
						.then(() => fn(controller.signal))
						.then((value) => {
							this.cacheSet(key, value)
							return value
						})
						.finally(clear)
						.catch((error: unknown) => {
							// A timeout abort can surface as a bare AbortError; normalize.
							if (timedOut && !(error instanceof WebToolError)) {
								throw new WebToolError("timeout", `Request timed out after ${opts?.timeoutMs}ms`)
							}
							throw error
						})
				},
				resolve: resolve as (value: unknown) => void,
				reject,
			})
		})
		flight.promise = promise
		promise.then(
			() => this.finishFlight(key, flight),
			() => this.finishFlight(key, flight),
		)
		this.flights.set(key, flight)
		this.pump()
		return this.attach(flight, opts?.signal) as Promise<T>
	}

	private finishFlight(key: string, flight: Flight): void {
		if (this.flights.get(key) === flight) this.flights.delete(key)
	}

	/**
	 * A caller's view of a flight: resolves with the flight result, or
	 * rejects as soon as THIS caller aborts — without killing the flight
	 * while other callers still want it.
	 */
	private attach(flight: Flight, callerSignal?: AbortSignal): Promise<unknown> {
		if (!callerSignal) return flight.promise
		if (callerSignal.aborted) {
			return Promise.reject(callerSignal.reason instanceof Error ? callerSignal.reason : new Error("aborted"))
		}
		return new Promise<unknown>((resolve, reject) => {
			const detach = () => {
				callerSignal.removeEventListener("abort", onCallerAbort)
				flight.callers.delete(callerSignal)
			}
			const onCallerAbort = () => {
				detach()
				// Last caller out kills the flight — nobody needs the result.
				if (flight.callers.size === 0) flight.controller.abort(callerSignal.reason)
				reject(callerSignal.reason instanceof Error ? callerSignal.reason : new Error("aborted"))
			}
			flight.callers.add(callerSignal)
			callerSignal.addEventListener("abort", onCallerAbort, { once: true })
			flight.promise.then(
				(value) => {
					detach()
					resolve(value)
				},
				(error) => {
					detach()
					reject(error)
				},
			)
		})
	}

	dispose(): void {
		for (const task of this.queue) task.reject(new Error("scheduler disposed"))
		this.queue = []
		// Interrupt in-flight requests too, not just queued ones.
		for (const flight of this.flights.values()) flight.controller.abort(new Error("scheduler disposed"))
		this.flights.clear()
		this.cache.clear()
	}

	private pump(): void {
		while (this.queue.length > 0 && this.active < this.maxConcurrent) {
			const index = this.queue.findIndex((task) => (this.activeByHost.get(task.host) ?? 0) < this.perHostLimit)
			if (index === -1) break
			const task = this.queue.splice(index, 1)[0]
			if (!task) break
			this.active += 1
			this.activeByHost.set(task.host, (this.activeByHost.get(task.host) ?? 0) + 1)
			task
				.run()
				.then(task.resolve, task.reject)
				.finally(() => {
					this.active -= 1
					this.activeByHost.set(task.host, (this.activeByHost.get(task.host) ?? 1) - 1)
					if (this.activeByHost.get(task.host) === 0) this.activeByHost.delete(task.host)
					this.pump()
				})
		}
	}

	private cacheGet<T>(key: string): T | undefined {
		const entry = this.cache.get(key)
		if (!entry) return undefined
		if (entry.expiresAt <= Date.now()) {
			this.cache.delete(key)
			return undefined
		}
		this.cache.delete(key)
		this.cache.set(key, entry) // refresh recency
		return entry.value as T
	}

	private cacheSet(key: string, value: unknown): void {
		this.cache.delete(key)
		this.cache.set(key, { value, expiresAt: Date.now() + MERGE_CACHE_TTL_MS })
		while (this.cache.size > this.maxCacheEntries) {
			const oldest = this.cache.keys().next().value
			if (oldest === undefined) break
			this.cache.delete(oldest)
		}
	}
}

// ── Fetch orchestration ──────────────────────────────────────────────────────

interface FetchPlan {
	fetchUrl: string
	fallbackUrl?: string
	note?: string
}

function planFetchUrl(raw: string): FetchPlan {
	const parsed = parseAndAssertHttpUrl(raw)
	const host = parsed.hostname.toLowerCase()
	if (host !== "github.com" && host !== "www.github.com") return { fetchUrl: raw }

	const segments = parsed.pathname.split("/").filter(Boolean)
	if (segments.length >= 5 && segments[2] === "blob") {
		const [owner, repo, _blob, ref, ...pathParts] = segments
		if (owner && repo && ref && pathParts.length > 0) {
			return {
				fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, "")}/${ref}/${pathParts.join("/")}`,
				note: "github_blob_raw",
			}
		}
	}

	if (segments.length === 2) {
		const [owner, repo] = segments
		return {
			fetchUrl: `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, "")}/HEAD/README.md`,
			fallbackUrl: raw,
			note: "github_repo_readme",
		}
	}

	return { fetchUrl: raw }
}

interface FetchDetails {
	url: string
	effective_url: string
	format: string
	title?: string
	content_type: string
	charset: string
	/** Captured body bytes (may be less than the real total). */
	captured_bytes: number
	/** Declared Content-Length of the final response, when present. */
	declared_length?: number
	/** Whether the captured bytes are the complete response body. */
	complete: boolean
	/** Total chars of the converted output (only meaningful when complete). */
	total_chars?: number
	truncated: boolean
	source_truncated: boolean
	spill_kind?: SpillKind
	full_output_path?: string
	/** Which bound the inline output first ("lines" | "bytes" | null). */
	truncated_by?: "lines" | "bytes" | null
	note?: string
}

async function executeFetch(
	fetchPlan: FetchPlan,
	format: string,
	maxChars: number,
	signal: AbortSignal,
	artifacts: ArtifactManager,
): Promise<{ content: string; details: FetchDetails }> {
	const fetchUrl = fetchPlan.fetchUrl
	parseAndAssertHttpUrl(fetchUrl)

	let response: Response | undefined
	let finalUrl = fetchUrl
	let declaredLength: number | undefined
	try {
		let result = await fetchFollowingRedirects(fetchUrl, buildRequestHeaders(format), signal)
		response = result.response
		finalUrl = result.finalUrl
		declaredLength = result.declaredLength

		// Retry with alternate browser UA if blocked by Cloudflare bot detection.
		if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
			await response.body?.cancel()
			response = undefined
			result = await fetchFollowingRedirects(fetchUrl, buildRequestHeaders(format, FALLBACK_UA), signal)
			response = result.response
			finalUrl = result.finalUrl
			declaredLength = result.declaredLength
		}

		// GitHub README fallback shares the same deadline/signal.
		if (!response.ok && fetchPlan.fallbackUrl) {
			await readErrorBody(response)
			response = undefined
			result = await fetchFollowingRedirects(fetchPlan.fallbackUrl, buildRequestHeaders(format), signal)
			response = result.response
			finalUrl = result.finalUrl
			declaredLength = result.declaredLength
		}

		if (!response.ok) {
			const status = response.status
			const errorBody = await readErrorBody(response)
			let hint = ""
			if (status === 429 || status === 503) {
				const retryAfter = parseRetryAfter(response.headers.get("retry-after"))
				hint = retryAfter !== undefined ? ` Retry after ${retryAfter}s.` : ""
			}
			throw new WebToolError(
				"http",
				`HTTP ${status}${response.statusText ? ` ${response.statusText}` : ""}.${hint}${errorBody.trim() ? ` Body: ${sanitizeHttpBody(errorBody)}` : ""}`,
			)
		}

		// Reject binary content before consuming the stream: a type we
		// cannot render should not cost the download.
		const contentType = response.headers.get("content-type") || ""
		assertSupportedContentType(contentType)

		const { bytes, truncatedByBytes } = await readBodyCapped(response, MAX_RESPONSE_SIZE, declaredLength)
		response = undefined // body fully consumed by the capped reader

		const charset = detectCharset(bytes, contentType)
		const body = decodeBytes(bytes, charset)
		const capturedBytes = bytes.byteLength
		if (looksBinary(bytes, body)) {
			throw new WebToolError("unsupported_type", "Unsupported content type: binary payload detected (magic bytes or NULs). web-fetch supports text-like content only.")
		}

		const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml")
		const title = isHtml ? extractTitle(body) : undefined

		// Bound conversion work: convert only a source prefix; when the page
		// is larger, spill the captured raw prefix instead of converting it all.
		const sourceCut = body.length > CONVERT_SOURCE_CAP
		const convertSource = sourceCut ? body.slice(0, CONVERT_SOURCE_CAP) : body
		let output: string
		switch (format) {
			case "markdown":
				output = isHtml ? convertHTMLToMarkdown(convertSource, finalUrl) : body
				break
			case "text":
				output = isHtml ? extractTextFromHTML(convertSource) : body
				break
			case "html":
				output = body
				break
			default:
				output = body
		}

		const outputCutRaw = output.length > maxChars
		// WF-4: whatever max_chars allows, the inline output is also bounded
		// by pi's byte+line limits (whichever hits first) so context is never
		// flooded regardless of handler-level schema bypasses.
		const bounded = truncateHead(output.slice(0, maxChars), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES })
		const outputCut = outputCutRaw || bounded.truncated
		const truncated = outputCut || sourceCut || truncatedByBytes
		const complete = !sourceCut && !truncatedByBytes
		let fullOutputPath: string | undefined
		let spillKind: SpillKind | undefined
		let content = bounded.content
		if (truncated) {
			if (!complete) {
				// WF-3: the full converted text is unavailable — the page
				// exceeded the conversion or byte cap. Spill the captured
				// prefix and say so explicitly; never claim "full".
				spillKind = isHtml ? "captured-raw-html" : "captured-raw-text"
				const spill = await artifacts.spill(`content.${spillKind === "captured-raw-html" ? "html" : "txt"}`, body)
				fullOutputPath = spill.path
				content = bounded.content + formatCapturedTruncationFooter(capturedBytes, maxChars, fullOutputPath, spillKind)
			} else {
				spillKind = format === "markdown" ? "markdown" : format === "html" ? "html" : "text"
				const spill = await artifacts.spill(`content.${extensionForFormat(format)}`, output)
				fullOutputPath = spill.path
				content = bounded.content + formatCompleteTruncationFooter(output.length, maxChars, fullOutputPath, spillKind)
			}
		}

		return {
			content,
			details: {
				url: sanitizeUrl(fetchUrl),
				effective_url: sanitizeUrl(finalUrl),
				format,
				title,
				content_type: contentType,
				charset,
				captured_bytes: capturedBytes,
				declared_length: declaredLength,
				complete,
				total_chars: complete ? output.length : undefined,
				truncated,
				source_truncated: sourceCut || truncatedByBytes,
				spill_kind: spillKind,
				full_output_path: fullOutputPath,
				truncated_by: bounded.truncated ? bounded.truncatedBy : null,
				note: fetchPlan.note,
			},
		}
	} finally {
		// WF-5: whatever Response is still owned here must be released.
		await response?.body?.cancel().catch(() => {})
	}
}

function buildRequestHeaders(format: string, userAgent = BROWSER_UA): Record<string, string> {
	const acceptByFormat: Record<string, string> = {
		markdown: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
		text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
		html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
	}
	return {
		"User-Agent": userAgent,
		Accept: acceptByFormat[format] ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
	}
}

// ── Tool definition ──────────────────────────────────────────────────────────

function createWebFetchTool(deps: { scheduler: RequestScheduler; artifacts: ArtifactManager }) {
	return defineTool({
		name: "web-fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and extract content as markdown (default), plain text, or raw HTML. " +
			"Use markdown for articles and documentation (preserves headings, links, code blocks). " +
			"Use text for quick content extraction. Use html for raw page source. " +
			"Refuses private/loopback hosts, DNS-rebinding targets, and binary content. " +
			"Large results are truncated inline and saved to a temp file.",
		promptSnippet: "Fetch URL content as markdown/text/html. Supports articles, docs, GitHub blob URLs, and large-page spillover.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (must start with http:// or https://)", minLength: 1, maxLength: 8_000 }),
			format: Type.Optional(
				StringEnum(["markdown", "text", "html"] as const, {
					description:
						"Output format: markdown (default, preserves structure), text (plain text), html (raw source)",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds (default: 30, max: 120)",
					minimum: 1,
					maximum: MAX_TIMEOUT_MS / 1000,
				}),
			),
			max_chars: Type.Optional(
				Type.Number({
					description: `Maximum characters to return inline (default: ${DEFAULT_MAX_CHARS}); full content is saved to a temp file when truncated`,
					minimum: 1,
					maximum: HARD_MAX_CHARS,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const { url } = params
			const format = params.format ?? "markdown"
			// WF-4: clamp to a hard ceiling; the schema maximum is enforced
			// for the model, but handlers may bypass schema validation.
			const rawMaxChars = Math.floor(params.max_chars ?? DEFAULT_MAX_CHARS)
			const maxChars = Math.min(Math.max(rawMaxChars, 1), HARD_MAX_CHARS)
			const timeoutSec = Math.min(Math.max(params.timeout ?? DEFAULT_TIMEOUT_MS / 1000, 1), MAX_TIMEOUT_MS / 1000)
			const timeoutMs = timeoutSec * 1000

			const fetchPlan = planFetchUrl(url)

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${sanitizeUrl(url)} (format: ${format})...` }],
				details: { url: sanitizeUrl(url), effective_url: sanitizeUrl(fetchPlan.fetchUrl) },
			})

			// WF-2: a composite caller signal that tracks user cancellation for
			// the whole lifecycle. The deadline itself is owned by the scheduler
			// flight (armed at dequeue — waiting for a concurrency slot no longer
			// burns the timeout), and merged callers detach independently, so
			// one caller's abort/timeout can never kill another's request.
			const controller = new AbortController()
			const onAbort = () => controller.abort(signal?.reason)
			if (signal?.aborted) onAbort()
			else signal?.addEventListener("abort", onAbort, { once: true })

			try {
				const cacheKey = `${format}|${maxChars}|${fetchPlan.fetchUrl}`
				const { content, details } = await deps.scheduler.schedule(
					cacheKey,
					(flightSignal) => executeFetch(fetchPlan, format, maxChars, flightSignal, deps.artifacts),
					{ signal: controller.signal, timeoutMs },
				)
				return {
					content: [{ type: "text", text: content }],
					details,
				}
			} catch (error) {
				// User cancellation is classified by the caller's own signal;
				// flight timeouts arrive as WebToolError("timeout").
				if (controller.signal.aborted || signal?.aborted) throw new Error("aborted")
				if (error instanceof WebToolError) {
					if (error.code === "aborted") throw new Error("aborted")
					throw error
				}
				throw asWebToolError(error, "http")
			} finally {
				signal?.removeEventListener("abort", onAbort)
			}
		},

		renderCall(args, theme, _context) {
			const format = args.format ?? "markdown"
			const maxChars = args.max_chars ? `${Math.round(args.max_chars / 1000)}k max` : undefined
			const url = sanitizeUrl(args.url)
			let urlDisplay: string
			try {
				const u = new URL(url)
				const host = u.hostname.replace(/^www\./, "")
				const path = u.pathname.length > 1 ? u.pathname.slice(0, 48) : ""
				urlDisplay = host + path + (u.search ? u.search.slice(0, 18) : "")
				if (urlDisplay.length > 72) urlDisplay = urlDisplay.slice(0, 69) + "..."
			} catch {
				urlDisplay = url.length > 72 ? url.slice(0, 69) + "..." : url
			}

			let text = theme.fg("toolTitle", theme.bold("Web fetch"))
			text += theme.fg("dim", " · ") + theme.fg("accent", format)
			if (maxChars) text += theme.fg("dim", ` · ${maxChars}`)
			text += theme.fg("dim", " · ") + theme.fg("muted", urlDisplay)
			return new Text(text, 0, 0)
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0)

			// Official API first (ToolRenderContext.isError); the result.isError
			// check stays as a belt-and-braces fallback for older hosts.
			if (context.isError || (result as { isError?: boolean }).isError === true) {
				const msg = result.content[0]?.type === "text" ? result.content[0].text : "Error"
				return new Text(theme.fg("error", `✗ ${msg}`), 0, 0)
			}

			const details = result.details as Partial<FetchDetails> | undefined
			const totalChars = details?.total_chars
			const capturedBytes = details?.captured_bytes ?? 0
			const truncated = details?.truncated ?? false
			const format = details?.format ?? "markdown"
			const contentType = details?.content_type?.split(";")[0] || "unknown"
			const content = result.content[0]?.type === "text" ? result.content[0].text : ""

			let summary: string
			if (totalChars !== undefined) {
				summary = theme.fg("success", `✓ ${totalChars.toLocaleString()} chars`)
			} else {
				summary = theme.fg("success", `✓ ${formatSize(capturedBytes)} captured`)
			}
			if (details?.title) summary += theme.fg("muted", ` · ${details.title.slice(0, 80)}`)
			summary += theme.fg("dim", ` · ${format}`)
			summary += theme.fg("dim", ` · ${contentType}`)
			if (truncated) summary += theme.fg("warning", " · truncated")
			if (details?.complete === false) summary += theme.fg("dim", " · prefix")

			if (!expanded) {
				summary += theme.fg("dim", ` ${keyHint("app.tools.expand", "expand")}`)
				return new Text(summary, 0, 0)
			}

			const container = new Container()
			let header = summary
			if (details?.url) {
				header += `\n${theme.fg("dim", "URL ")}${theme.fg("muted", details.url.length > 120 ? details.url.slice(0, 117) + "..." : details.url)}`
			}
			if (details?.effective_url && details.effective_url !== details.url) {
				header += `\n${theme.fg("dim", "Fetched ")}${theme.fg("muted", details.effective_url.length > 120 ? details.effective_url.slice(0, 117) + "..." : details.effective_url)}`
			}
			if (details?.full_output_path) {
				header += `\n${theme.fg("dim", `${spillLabel(details.spill_kind ?? "markdown")} `)}${theme.fg("accent", details.full_output_path)}`
			}
			container.addChild(new Text(header, 0, 0))

			if (format === "markdown") {
				const preview = content.length > 24000 ? content.slice(0, 24000) + "\n\n... preview truncated for display" : content
				container.addChild(new Markdown(preview, 0, 0, getMarkdownTheme()))
				return container
			}

			const maxLines = format === "html" ? 30 : 50
			const allLines = content.split("\n")
			const previewLines = allLines.slice(0, maxLines)
			let preview = theme.fg("dim", "── content preview ──")
			for (const line of previewLines) {
				preview += `\n${theme.fg("muted", line.slice(0, 140))}`
			}
			if (allLines.length > previewLines.length) {
				preview += `\n${theme.fg("dim", `... ${allLines.length - previewLines.length} more lines`)}`
			}
			container.addChild(new Text(preview, 0, 0))
			return container
		},
	})
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const scheduler = new RequestScheduler()
	const artifacts = new ArtifactManager()

	pi.registerTool(createWebFetchTool({ scheduler, artifacts }))

	pi.on("session_start", async () => {
		await sweepStaleArtifactRoots().catch(() => {})
	})

	pi.on("session_shutdown", async () => {
		await artifacts.cleanup()
		scheduler.dispose()
	})
}
