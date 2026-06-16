/**
 * web-fetch extension for pi
 *
 * Fetch a URL and extract content as markdown, text, or raw HTML.
 * Inspired by opencode's webfetch tool with improvements:
 *   - format parameter (markdown/text/html)
 *   - Smart Accept headers based on format
 *   - Cloudflare 403 retry with fallback UA
 *   - URL validation, SSRF guard, redirect guard, and 5MB response size limit
 *   - Binary content-type guard
 *   - Large-output spillover to a temp file
 *   - Lightweight HTML→Markdown converter (no external deps)
 *   - Lightweight GitHub blob URL → raw.githubusercontent.com rewrite
 */

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Type, StringEnum } from "@earendil-works/pi-ai"
import { defineTool, getMarkdownTheme, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Container, Markdown, Text } from "@earendil-works/pi-tui"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_MAX_CHARS = 50_000
const MAX_REDIRECTS = 5
const FETCH_TEMP_DIR_PREFIX = "pi-web-fetch-"

const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
const FALLBACK_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

const SUPPORTED_HTTP_PROTOCOLS = new Set(["http:", "https:"])
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

// ── Accept headers by format ─────────────────────────────────────────────────

function buildAcceptHeader(format: string): string {
	switch (format) {
		case "markdown":
			return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
		case "text":
			return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
		case "html":
			return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
		default:
			return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	}
}

// ── URL validation / SSRF guard ──────────────────────────────────────────────

function isPrivateOrLoopbackHostname(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
	if (h === "localhost" || h.endsWith(".localhost")) return true

	// IPv6 loopback / unspecified / link-local / unique-local.
	if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
		return true
	}

	// IPv4 literals.
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (!v4) return false
	const octets = v4.slice(1).map(Number)
	if (octets.some((n) => n < 0 || n > 255)) return true
	const [a, b] = octets
	if (a === 0 || a === 10 || a === 127) return true
	if (a === 169 && b === 254) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 192 && b === 168) return true
	return false
}

function parseAndAssertHttpUrl(raw: string): URL {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		throw new Error(`Invalid URL: ${raw}`)
	}

	if (!SUPPORTED_HTTP_PROTOCOLS.has(parsed.protocol)) {
		throw new Error(`Unsupported URL protocol: ${parsed.protocol}. Only http and https are supported.`)
	}
	if (isPrivateOrLoopbackHostname(parsed.hostname)) {
		throw new Error(`Refusing to fetch private/loopback address: ${parsed.hostname}`)
	}
	return parsed
}

interface FetchUrlPlan {
	fetchUrl: string
	fallbackUrl?: string
	note?: string
}

function planFetchUrl(raw: string): FetchUrlPlan {
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

function isRedirect(response: Response): boolean {
	return response.status >= 300 && response.status < 400 && response.headers.has("location")
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

function convertHTMLToMarkdown(html: string): string {
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

	// Convert links: <a href="url">text</a> → [text](url).
	md = md.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")

	// Convert images: <img src="url" alt="text"> → ![text](url).
	md = md.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*\/?>/gi, "![$1]($2)")
	md = md.replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, "![$2]($1)")
	md = md.replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, "![]($1)")

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

// ── Content guards / truncation ──────────────────────────────────────────────

function assertSupportedContentType(contentType: string): void {
	const type = contentType.split(";")[0]?.trim().toLowerCase()
	if (!type) return
	if (BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix)) || BINARY_CONTENT_TYPES.has(type)) {
		throw new Error(`Unsupported content type: ${contentType}. web-fetch supports text-like content only.`)
	}
}

function extensionForFormat(format: string): string {
	if (format === "html") return "html"
	if (format === "markdown") return "md"
	return "txt"
}

async function spillFullContentToTempFile(content: string, format: string): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), FETCH_TEMP_DIR_PREFIX))
	const tempFile = join(tempDir, `content.${extensionForFormat(format)}`)
	await writeFile(tempFile, content, "utf8")
	return tempFile
}

function formatTruncationFooter(totalChars: number, maxChars: number, tempFile: string): string {
	return `\n...[truncated]\n\n[Content truncated: showing ${maxChars.toLocaleString()} of ${totalChars.toLocaleString()} chars. Full content saved to: ${tempFile}]`
}

// ── Fetch with retry ─────────────────────────────────────────────────────────

async function fetchFollowingRedirects(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
	let currentUrl = url
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		parseAndAssertHttpUrl(currentUrl)
		const response = await fetch(currentUrl, { signal, headers, redirect: "manual" })
		if (!isRedirect(response)) return { response, finalUrl: currentUrl }

		const location = response.headers.get("location")
		if (!location) return { response, finalUrl: currentUrl }
		if (redirects === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`)
		currentUrl = new URL(location, currentUrl).toString()
	}
	throw new Error(`Too many redirects (>${MAX_REDIRECTS})`)
}

async function fetchWithRetry(
	url: string,
	format: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
	const accept = buildAcceptHeader(format)
	const headers = {
		"User-Agent": BROWSER_UA,
		Accept: accept,
		"Accept-Language": "en-US,en;q=0.9",
	}

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs)
	const abort = () => controller.abort(signal?.reason)
	if (signal?.aborted) abort()
	signal?.addEventListener("abort", abort, { once: true })

	try {
		const result = await fetchFollowingRedirects(url, headers, controller.signal)

		// Retry with alternate browser UA if blocked by Cloudflare bot detection.
		if (result.response.status === 403 && result.response.headers.get("cf-mitigated") === "challenge") {
			return await fetchFollowingRedirects(url, { ...headers, "User-Agent": FALLBACK_UA }, controller.signal)
		}

		return result
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener("abort", abort)
	}
}

// ── Tool definition ──────────────────────────────────────────────────────────

const webFetchTool = defineTool({
	name: "web-fetch",
	label: "Web Fetch",
	description:
		"Fetch a URL and extract content as markdown (default), plain text, or raw HTML. " +
		"Use markdown for articles and documentation (preserves headings, links, code blocks). " +
		"Use text for quick content extraction. Use html for raw page source. " +
		"Refuses private/loopback hosts and unsupported binary content. " +
		"Large results are truncated inline and saved to a temp file.",
	promptSnippet: "Fetch URL content as markdown/text/html. Supports articles, docs, GitHub blob URLs, and large-page spillover.",
	parameters: Type.Object({
		url: Type.String({ description: "URL to fetch (must start with http:// or https://)" }),
		format: Type.Optional(
			StringEnum(["markdown", "text", "html"] as const, {
				description:
					"Output format: markdown (default, preserves structure), text (plain text), html (raw source)",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description: "Timeout in seconds (default: 30, max: 120)",
			}),
		),
		max_chars: Type.Optional(
			Type.Number({
				description: "Maximum characters to return inline (default: 50000); full content is saved to a temp file when truncated",
			}),
		),
	}),

	async execute(_toolCallId, params, signal, onUpdate) {
		const { url } = params
		const format = params.format ?? "markdown"
		const maxChars = Math.max(1, Math.floor(params.max_chars ?? DEFAULT_MAX_CHARS))
		const timeoutSec = Math.min(Math.max(params.timeout ?? DEFAULT_TIMEOUT_MS / 1000, 1), MAX_TIMEOUT_MS / 1000)
		const timeoutMs = timeoutSec * 1000

		const fetchPlan = planFetchUrl(url)
		const fetchUrl = fetchPlan.fetchUrl
		parseAndAssertHttpUrl(fetchUrl)

		onUpdate?.({
			content: [{ type: "text", text: `Fetching ${url} (format: ${format})...` }],
			details: { url, effective_url: fetchUrl },
		})

		let { response, finalUrl } = await fetchWithRetry(fetchUrl, format, timeoutMs, signal ?? undefined)
		if (!response.ok && fetchPlan.fallbackUrl) {
			const fallback = await fetchWithRetry(fetchPlan.fallbackUrl, format, timeoutMs, signal ?? undefined)
			response = fallback.response
			finalUrl = fallback.finalUrl
		}

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`)
		}

			const contentLength = response.headers.get("content-length")
			const contentLengthBytes = contentLength ? Number.parseInt(contentLength, 10) : undefined
			if (contentLengthBytes && contentLengthBytes > MAX_RESPONSE_SIZE) {
				throw new Error(`Response too large (${contentLengthBytes.toLocaleString()} bytes; limit is 5MB)`)
			}

			const contentType = response.headers.get("content-type") || ""
			assertSupportedContentType(contentType)

			const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml")
			const body = await response.text()
			const bodyBytes = Buffer.byteLength(body, "utf8")

			if (bodyBytes > MAX_RESPONSE_SIZE) {
				throw new Error(`Response too large (${bodyBytes.toLocaleString()} bytes; limit is 5MB)`)
			}

			const title = isHtml ? extractTitle(body) : undefined
			let output: string
			switch (format) {
				case "markdown":
					output = isHtml ? convertHTMLToMarkdown(body) : body
					break
				case "text":
					output = isHtml ? extractTextFromHTML(body) : body
					break
				case "html":
					output = body
					break
				default:
					output = body
			}

			const truncated = output.length > maxChars
			let fullOutputPath: string | undefined
			let content = output
			if (truncated) {
				fullOutputPath = await spillFullContentToTempFile(output, format)
				content = output.slice(0, maxChars) + formatTruncationFooter(output.length, maxChars, fullOutputPath)
			}

			return {
				content: [{ type: "text", text: content }],
				details: {
					url,
					effective_url: finalUrl,
					format,
					title,
					content_type: contentType,
					content_length: contentLengthBytes,
					note: fetchPlan.note,
					total_chars: output.length,
					total_bytes: Buffer.byteLength(output, "utf8"),
					truncated,
					full_output_path: fullOutputPath,
				},
			}
	},

	renderCall(args, theme, _context) {
		const format = args.format ?? "markdown"
		const maxChars = args.max_chars ? `${Math.round(args.max_chars / 1000)}k max` : undefined
		const url = args.url
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

	renderResult(result, { expanded, isPartial }, theme, _context) {
		if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0)

		if (result.isError) {
			const msg = result.content[0]?.type === "text" ? result.content[0].text : "Error"
			return new Text(theme.fg("error", `✗ ${msg}`), 0, 0)
		}

		const details = result.details as {
			url?: string
			effective_url?: string
			format?: string
			title?: string
			content_type?: string
			total_chars?: number
			total_bytes?: number
			truncated?: boolean
			full_output_path?: string
		}
		const totalChars = details?.total_chars ?? 0
		const truncated = details?.truncated ?? false
		const format = details?.format ?? "markdown"
		const contentType = details?.content_type?.split(";")[0] || "unknown"
		const content = result.content[0]?.type === "text" ? result.content[0].text : ""

		let summary = theme.fg("success", `✓ ${totalChars.toLocaleString()} chars`)
		if (details?.title) summary += theme.fg("muted", ` · ${details.title.slice(0, 80)}`)
		summary += theme.fg("dim", ` · ${format}`)
		summary += theme.fg("dim", ` · ${contentType}`)
		if (truncated) summary += theme.fg("warning", " · truncated")

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
			header += `\n${theme.fg("dim", "Full content ")}${theme.fg("accent", details.full_output_path)}`
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

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool(webFetchTool)
}
