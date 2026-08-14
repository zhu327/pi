/**
 * str_replace_editor for pi — single-file build, maintained directly
 * (distributed as one file; no separate src/ regeneration step).
 *
 * Load by placing this file at ~/.pi/agent/extensions/str-replace-editor.ts.
 *
 * REFACTOR_PLAN.md tasks implemented:
 *   - SRE-1: CRLF/BOM handling — files are read as buffers, the UTF-8 BOM is
 *     separated, the dominant EOL is detected, content is normalized to LF
 *     for matching/editing, then restored to the original EOL + BOM on
 *     write. Views never expose the BOM as text.
 *   - SRE-2: strict UTF-8 validation — non-UTF-8 files are rejected with a
 *     clear error and their bytes are never rewritten.
 *   - SRE-3: overlapping occurrences are detected (aaa/aa reports
 *     multiple); the error lists at most 10 line numbers plus the total.
 *   - SRE-4: tool details hold only actually-displayed view lines/rows with
 *     truncation metadata — session/RPC payloads stay bounded.
 *   - SRE-5: a late abort after a successful write no longer turns a
 *     committed edit into a failure (committed flag is recorded instead).
 *   - SRE-6: commands are validated with an exhaustive switch at runtime;
 *     unknown commands throw and never bypass the mutation queue.
 *   - SRE-7: path normalization aligned with pi's built-ins (~ expansion,
 *     leading @ strip, Unicode space normalization) and schema limits.
 *   - SRE-8: empty-file creates produce add-only diffs; view truncation is
 *     line-safe and never splits UTF-16 surrogates; the diff comment now
 *     matches the "single contiguous replacement" algorithm.
 */
/**
 * Pure editor logic for the pi `str_replace_editor` extension.
 *
 * Ported from `@deepseek-ai/dsh-tool-str-replace-editor`, adapted to pi
 * conventions: relative paths resolve against the caller cwd and a leading
 * `@` is stripped (models sometimes prefix path arguments with it). The
 * command semantics, model-facing messages, and truncation marker are kept
 * verbatim so the model contract matches the original tool.
 *
 * This module touches the filesystem only through `node:fs/promises` and
 * never imports pi packages, so it is unit-testable without a pi runtime.
 * @module pi-extension-str-replace-editor/editor
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export const TRUNCATED_MESSAGE = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>"

export const DEFAULT_MAX_OUTPUT_CHARS = 16_000

// Hard byte cap for any single view output, in addition to the char budget.
const VIEW_MAX_OUTPUT_BYTES = 50 * 1024
/** Hard line cap mirroring pi's DEFAULT_MAX_LINES (SRE-8 hardening). */
const VIEW_MAX_OUTPUT_LINES = 2000

export const DEFAULT_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim()

export type EditorCommand = "view" | "create" | "str_replace" | "insert"

const EDITOR_COMMANDS = new Set<string>(["view", "create", "str_replace", "insert"])

/** SRE-6: runtime exhaustive command guard, also used for queue decisions. */
export function isEditorCommand(value: unknown): value is EditorCommand {
	return typeof value === "string" && EDITOR_COMMANDS.has(value)
}

/** Model-facing arguments for one editor command. */
export interface EditorArgs {
  command: EditorCommand
  path: string
  file_text?: string
  insert_line?: number
  new_str?: string
  old_str?: string
  view_range?: number[]
}

/** Outcome of one editor command. */
export interface EditorResult {
  /** Model-facing result text (kept verbatim from the original tool). */
  text: string
  /** The command that produced this result. */
  kind: EditorCommand
  /** Resolved absolute path the command operated on. */
  path: string
  /** Display-oriented diff for mutations (pi renderDiff format). */
  diff?: string
  /** Line number of the first change in the new content, for editor navigation. */
  firstChangedLine?: number
  /** view: raw content slice behind the numbering, for TUI highlighting. */
  viewLines?: string[]
  /** view: sorted `type<TAB>path` listing rows for directories, for TUI display. */
  viewRows?: string[]
  /** view: first displayed line number (1-based). */
  viewStartLine?: number
  /** view: total lines in the file. */
  viewTotalLines?: number
  /** view: lines in the requested range (differs from viewTotalLines when view_range is used). */
  viewRangeLines?: number
  /** view: whether the numbered text was clipped at maxOutputChars. */
  clipped?: boolean
  /** view: whether details hold only a prefix of the displayed lines/rows (SRE-4). */
  viewTruncated?: boolean
  /** view: total rows for directories (SRE-4). */
  viewTotalRows?: number
  /** mutation: whether the write hit the disk (SRE-5). */
  committed?: boolean
  /** mutation: whether cancellation was observed after the write committed (SRE-5). */
  cancellationObservedAfterCommit?: boolean
}

/** Options for {@link runEditor} and {@link computeEditorDiff}. */
export interface EditorOptions {
  /** Working directory relative paths resolve against. */
  cwd: string
  /** Maximum returned view characters before clipping (default {@link DEFAULT_MAX_OUTPUT_CHARS}). */
  maxOutputChars?: number
  /** Cancellation signal checked between filesystem awaits. */
  signal?: AbortSignal
}

// SRE-4: details carry only the lines/rows the TUI can actually show.
const VIEW_DETAILS_MAX_LINES = 500
const VIEW_DETAILS_MAX_ROWS = 500
/** M6: per-line and total byte caps for details payloads. */
const VIEW_DETAILS_MAX_LINE_CHARS = 1000
const VIEW_DETAILS_MAX_BYTES = 100 * 1024

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted")
}

// ── Path normalization (SRE-7, aligned with pi's built-in tools) ─────────────

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/**
 * Resolve a model-supplied path: strip a leading `@` (a known model quirk),
 * normalize Unicode spaces (U+00A0/U+2000-U+200A/U+202F/U+205F/U+3000),
 * expand `~`, and resolve relative paths against the working directory.
 * Empty paths (after `@` stripping) are rejected.
 */
export function resolveToolPath(rawPath: string, cwd: string): string {
  const normalizedSpaces = rawPath.replace(UNICODE_SPACES, " ")
  const stripped = normalizedSpaces.startsWith("@") ? normalizedSpaces.slice(1) : normalizedSpaces
  const trimmed = stripped.trim()
  if (trimmed.length === 0) throw new Error("path must be a non-empty string")

  let expanded = trimmed
  if (expanded === "~") expanded = homedir()
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) expanded = join(homedir(), expanded.slice(2))

  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

// ── Encoding handling (SRE-1: CRLF/BOM; SRE-2: strict UTF-8) ─────────────────

type EolStyle = "\n" | "\r\n" | "\r"

interface FileEncoding {
	hasBom: boolean
	eol: EolStyle
}

/** Detect the UTF-8 BOM and the dominant EOL style of a file buffer. */
function detectFileEncoding(buffer: Buffer): FileEncoding {
	let hasBom = false
	let start = 0
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		hasBom = true
		start = 3
	}
	// H1 fix: count over the WHOLE buffer (it is already in memory) — a
	// fixed sampling window would misread files whose first line is longer
	// than the window. A latin-1 scan is safe: UTF-8 continuation bytes are
	// >= 0x80 and can never forge 0x0A / 0x0D. No newlines at all defaults
	// to LF (strict comparisons, ties go to LF) instead of inventing CRLF.
	let crlf = 0
	let lf = 0
	let cr = 0
	const text = buffer.toString("latin1")
	for (let i = start; i < text.length; i++) {
		const ch = text.charCodeAt(i)
		if (ch === 0x0a) {
			if (i > start && text.charCodeAt(i - 1) === 0x0d) crlf += 1
			else lf += 1
		} else if (ch === 0x0d) {
			if (i + 1 >= text.length || text.charCodeAt(i + 1) !== 0x0a) cr += 1
		}
	}
	const eol: EolStyle = crlf > lf && crlf > cr ? "\r\n" : cr > lf ? "\r" : "\n"
	return { hasBom, eol }
}

/**
 * Normalize every newline form to LF for matching/editing — including
 * stray CRs inside otherwise-LF files, which would otherwise leak into
 * viewLines and break cross-line matching (H2 fix). restoreEol puts the
 * file's dominant style back on write.
 */
function normalizeToLf(text: string): string {
	return text.replace(/\r\n?/g, "\n")
}

/** Restore the file's EOL style on the way out. */
function restoreEol(text: string, eol: EolStyle): string {
	if (eol === "\n") return text
	if (eol === "\r\n") return text.replace(/\n/g, "\r\n")
	return text.replace(/\n/g, "\r")
}

/** Encode content back to bytes with the original EOL style and BOM. */
function encodeText(text: string, encoding: FileEncoding): Buffer {
	const withEol = restoreEol(text, encoding.eol)
	return Buffer.from((encoding.hasBom ? "\uFEFF" : "") + withEol, "utf8")
}

/**
 * Decode a file buffer strictly as UTF-8 (SRE-2). Throws without touching
 * the original bytes when the file is not valid UTF-8.
 */
function decodeFileBuffer(buffer: Buffer, encoding: FileEncoding, path: string): string {
	const payload = encoding.hasBom ? buffer.subarray(3) : buffer
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(payload)
	} catch {
		throw new Error(
			`The file ${path} is not valid UTF-8 text. Only UTF-8 text files are supported — the file was not modified.`,
		)
	}
}

// ── Output truncation (SRE-8: line-safe, byte-bounded, no split surrogates) ──

/**
 * Truncate view output on whole-line boundaries. The char budget
 * (maxOutputChars, contract kept) is enforced on code points (never
 * mid-surrogate) and a hard 50KB byte cap is applied on top; the
 * `<response clipped>` marker is appended exactly once when clipping.
 */
function maybeTruncate(content: string, maxOutputChars: number): { text: string; clipped: boolean } {
	if (content.length <= maxOutputChars && Buffer.byteLength(content, "utf8") <= VIEW_MAX_OUTPUT_BYTES) {
		return { text: content, clipped: false }
	}

	const lines = content.split("\n")
	const kept: string[] = []
	let chars = 0
	let bytes = 0
	let clipped = false
	for (const line of lines) {
		if (kept.length >= VIEW_MAX_OUTPUT_LINES) {
			clipped = true
			break
		}
		const lineChars = Array.from(line).length
		const lineBytes = Buffer.byteLength(line, "utf8")
		if (kept.length > 0 && (chars + lineChars > maxOutputChars || bytes + lineBytes > VIEW_MAX_OUTPUT_BYTES)) {
			clipped = true
			break
		}
		kept.push(line)
		chars += lineChars
		bytes += lineBytes
		if (chars > maxOutputChars || bytes > VIEW_MAX_OUTPUT_BYTES) {
			clipped = true
			break
		}
	}
	return { text: kept.join("\n") + TRUNCATED_MESSAGE, clipped }
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

// ── Matching (SRE-3: overlapping occurrences) ────────────────────────────────

const MAX_REPORTED_MATCH_LINES = 10

/** Bound how much of a search string is echoed back in error messages. */
function echoForError(value: string, maxChars = 200): string {
  if (value.length <= maxChars) return value
  const chars = Array.from(value)
  return `${chars.slice(0, maxChars).join("")}… (${value.length} chars)`
}

/**
 * Find occurrences of `search`, counting overlapping matches (aaa contains
 * aa at offsets 0 and 1). Stores at most {@link MAX_REPORTED_MATCH_LINES}
 * offsets while counting every occurrence.
 */
function matchOffsets(content: string, search: string): { offsets: number[]; total: number } {
  const offsets: number[] = []
  let total = 0
  let from = 0
  while (true) {
    const match = content.indexOf(search, from)
    if (match < 0) break
    total += 1
    if (offsets.length < MAX_REPORTED_MATCH_LINES) offsets.push(match)
    from = match + 1
  }
  return { offsets, total }
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1
  let cursor = 0
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === "\n") line += 1
      cursor += 1
    }
    return line
  })
}

function requiredForCommand(
  value: string | undefined,
  parameter: string,
  command: string,
  allowEmpty = true,
): string {
  if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`)
  if (!allowEmpty && value.length === 0) {
    throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`)
  }
  return value
}

/**
 * Validate `view_range` and slice the content. Returns the sliced lines, the
 * first displayed line number (1-based), and the total line count.
 */
function computeViewSlice(
  content: string,
  viewRange?: number[],
): { lines: string[]; startLine: number; totalLines: number } {
  const allLines = content.split("\n")
  let lines = allLines
  let initialLine = 1
  if (viewRange !== undefined) {
    const [requestedInitialLine, requestedFinalLine] = viewRange
    if (
      viewRange.length !== 2
      || requestedInitialLine === undefined
      || requestedFinalLine === undefined
      || !viewRange.every(Number.isInteger)
    ) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.")
    }
    initialLine = requestedInitialLine
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
      )
    }
    if (requestedFinalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${requestedFinalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
      )
    }
    if (requestedFinalLine !== -1 && requestedFinalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${requestedFinalLine}\` should be larger or equal than its first \`${initialLine}\``,
      )
    }
    lines = requestedFinalLine === -1
      ? allLines.slice(initialLine - 1)
      : allLines.slice(initialLine - 1, requestedFinalLine)
  }
  return { lines, startLine: initialLine, totalLines: allLines.length }
}

interface FormattedView {
  /** Model-facing numbered text, byte-identical to the original tool. */
  text: string
  /** Raw content slice behind the numbering, for TUI highlighting. */
  lines: string[]
  /** First displayed line number (1-based). */
  startLine: number
  /** Total lines in the file. */
  totalLines: number
  /** Whether the numbered text was clipped at maxOutputChars. */
  clipped: boolean
}

function formatFileView(
  path: string,
  content: string,
  maxOutputChars: number,
  viewRange?: number[],
): FormattedView {
  const { lines, startLine, totalLines } = computeViewSlice(content, viewRange)
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${totalLines} lines)`
  if (viewRange !== undefined) {
    const [, requestedFinalLine] = viewRange
    prompt += ` with view_range=[${startLine}, ${requestedFinalLine}]`
  }
  const numbered = lines
    .map((line, index) => `${String(startLine + index).padStart(6, " ")}  ${line}`)
    .join("\n")
  const full = `${prompt}:\n${numbered}\n`
  const truncated = maybeTruncate(full, maxOutputChars)
  return {
    text: truncated.text,
    lines,
    startLine,
    totalLines,
    clipped: truncated.clipped,
  }
}

async function listDirectory(
  path: string,
  maxOutputChars: number,
  signal: AbortSignal | undefined,
): Promise<{ text: string; rows: string[]; clipped: boolean }> {
  async function visit(dir: string, depth: number): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    throwIfAborted(signal)
    const rows: string[] = []
    for (const entry of entries.filter(candidate =>
      !candidate.name.startsWith(".")
      && candidate.name !== "node_modules"
      && candidate.name !== "__pycache__")) {
      const childPath = resolve(dir, entry.name)
      const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?"
      rows.push(`${type}\t${childPath}`)
      if (type === "d" && depth < 2) {
        rows.push(...await visit(childPath, depth + 1))
      }
    }
    return rows
  }
  const rows = [`d\t${path}`, ...await visit(path, 1)]
  rows.sort((left, right) => {
    const leftPath = left.slice(left.indexOf("\t") + 1)
    const rightPath = right.slice(right.indexOf("\t") + 1)
    return codepointCompare(leftPath, rightPath)
  })
  const truncated = maybeTruncate(rows.join("\n") + "\n", maxOutputChars)
  return {
    text: `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${truncated.text}\n`,
    rows,
    clipped: truncated.clipped,
  }
}

async function statKind(
  path: string,
  signal: AbortSignal | undefined,
): Promise<"file" | "directory" | "other" | "absent"> {
  try {
    const info = await stat(path)
    throwIfAborted(signal)
    if (info.isFile()) return "file"
    if (info.isDirectory()) return "directory"
    return "other"
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "absent"
    throw error
  }
}

async function viewPath(
  path: string,
  viewRange: number[] | undefined,
  maxOutputChars: number,
  signal: AbortSignal | undefined,
): Promise<EditorResult> {
  const kind = await statKind(path, signal)
  if (kind === "absent") {
    throw new Error(`The path ${path} does not exist. Please provide a valid path.`)
  }
  if (kind === "directory") {
    if (viewRange !== undefined) {
      throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.")
    }
    const { text, rows, clipped } = await listDirectory(path, maxOutputChars, signal)
    // SRE-4: details carry only a bounded prefix of the listing.
    return {
      text,
      kind: "view",
      path,
      viewRows: rows.slice(0, VIEW_DETAILS_MAX_ROWS),
      viewTotalRows: rows.length,
      viewTruncated: rows.length > VIEW_DETAILS_MAX_ROWS,
      clipped,
    }
  }
  if (kind !== "file") {
    throw new Error(`cannot view "${path}": not a regular file or directory`)
  }
  const buffer = await readFile(path)
  throwIfAborted(signal)
  // SRE-1/SRE-2: BOM/EOL-aware, strict UTF-8 view.
  const encoding = detectFileEncoding(buffer)
  const content = decodeFileBuffer(buffer, encoding, path)
  const normalized = normalizeToLf(content)
  const formatted = formatFileView(path, normalized, maxOutputChars, viewRange)
  // SRE-4 (M6): bound the details payload byte-wise as well — very long
  // single lines must not balloon the session/RPC details.
  const viewLines: string[] = []
  let detailsBytes = 0
  for (const line of formatted.lines) {
    if (viewLines.length >= VIEW_DETAILS_MAX_LINES) break
    const boundedLine = line.length > VIEW_DETAILS_MAX_LINE_CHARS ? `${line.slice(0, VIEW_DETAILS_MAX_LINE_CHARS)} …` : line
    detailsBytes += Buffer.byteLength(boundedLine, "utf8")
    if (viewLines.length > 0 && detailsBytes > VIEW_DETAILS_MAX_BYTES) break
    viewLines.push(boundedLine)
  }
  return {
    text: formatted.text,
    kind: "view",
    path,
    // SRE-4: only the lines the TUI can actually show.
    viewLines,
    viewStartLine: formatted.startLine,
    viewTotalLines: formatted.totalLines,
    viewRangeLines: formatted.lines.length,
    viewTruncated: viewLines.length < formatted.lines.length,
    clipped: formatted.clipped,
  }
}

/** In-memory replacement matching: throws the original tool's errors. */
function computeReplaceAfter(before: string, args: EditorArgs, path: string): string {
  // H2: edit inputs are newline-normalized to match the LF-normalized
  // content — CRLF-flavored old_str/new_str must match, and must not
  // produce doubled carriage returns when the file style is restored.
  const oldValue = normalizeToLf(requiredForCommand(args.old_str, "old_str", "str_replace", false))
  const newValue = normalizeToLf(args.new_str ?? "")
  const { offsets, total } = matchOffsets(before, oldValue)
  if (total === 0) {
    throw new Error(
      `No replacement was performed, old_str \`${echoForError(oldValue)}\` did not appear verbatim in ${path}.`,
    )
  }
  if (total > 1) {
    // SRE-3: at most 10 line numbers plus the total count.
    const lines = lineNumbersAt(before, offsets)
    const hidden = total - lines.length
    const suffix = hidden > 0 ? ` and ${hidden} more` : ""
    throw new Error(
      `No replacement was performed. Multiple occurrences (${total}) of old_str \`${echoForError(oldValue)}\` in lines [${lines.join(", ")}${suffix}]. Please ensure it is unique`,
    )
  }
  const offset = offsets[0]!
  return before.slice(0, offset) + newValue + before.slice(offset + oldValue.length)
}

/** In-memory insert construction: throws the original tool's errors. */
function computeInsertAfter(before: string, args: EditorArgs): string {
  if (args.insert_line === undefined) throw new Error("Parameter `insert_line` is required for command: insert")
  const value = normalizeToLf(requiredForCommand(args.new_str, "new_str", "insert"))
  const lines = before.split("\n")
  if (!Number.isInteger(args.insert_line) || args.insert_line < 0 || args.insert_line > lines.length) {
    throw new Error(
      `Invalid \`insert_line\` parameter: ${args.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`,
    )
  }
  return [
    ...lines.slice(0, args.insert_line),
    ...value.split("\n"),
    ...lines.slice(args.insert_line),
  ].join("\n")
}

/** The target must exist as a regular file (str_replace / insert). */
async function requireEditableFile(path: string, signal: AbortSignal | undefined): Promise<void> {
  const kind = await statKind(path, signal)
  if (kind === "absent") {
    throw new Error(`The path ${path} does not exist. Please provide a valid path.`)
  }
  if (kind === "directory") {
    throw new Error(
      `The path ${path} is a directory and only the \`view\` command can be used on directories`,
    )
  }
  if (kind !== "file") {
    throw new Error(`cannot edit "${path}": not a regular file`)
  }
}

/** The target must not exist (create), matching the original tool's message for any existing kind. */
async function requireAbsent(path: string, signal: AbortSignal | undefined): Promise<void> {
  const kind = await statKind(path, signal)
  if (kind !== "absent") {
    throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`)
  }
}

/** Read + normalize a file for mutation (SRE-1/SRE-2 shared with view). */
async function readNormalizedFile(path: string, signal: AbortSignal | undefined): Promise<{ content: string; encoding: FileEncoding }> {
  const buffer = await readFile(path)
  throwIfAborted(signal)
  const encoding = detectFileEncoding(buffer)
  const content = decodeFileBuffer(buffer, encoding, path)
  return { content: normalizeToLf(content), encoding }
}

async function runMutation(
  args: EditorArgs,
  path: string,
  maxOutputChars: number,
  signal: AbortSignal | undefined,
): Promise<EditorResult> {
  if (args.command === "create") {
    const content = requiredForCommand(args.file_text, "file_text", "create")
    await requireAbsent(path, signal)
    throwIfAborted(signal) // SRE-5: cancel before the write is allowed to fail the call.
    try {
      // `wx` makes the create-if-absent atomic against concurrent writers.
      await writeFile(path, content, { encoding: "utf8", flag: "wx" })
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`)
      }
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // 附加: an actionable error instead of a raw ENOENT.
        throw new Error(`New file cannot be created at: ${path}: the parent directory does not exist.`)
      }
      throw error
    }
    // SRE-5: once the write committed, a late abort does not flip the
    // result to failure — the edit is on disk either way.
    const abortedAfterCommit = signal?.aborted === true
    const { diff, firstChangedLine } = generateDiffString("", content)
    return {
      text: `New file created successfully at: ${path}`,
      kind: "create",
      path,
      diff,
      firstChangedLine,
      committed: true,
      cancellationObservedAfterCommit: abortedAfterCommit,
    }
  }

  await requireEditableFile(path, signal)
  const { content: before, encoding } = await readNormalizedFile(path, signal)
  const after = args.command === "str_replace"
    ? computeReplaceAfter(before, args, path)
    : computeInsertAfter(before, args)
  throwIfAborted(signal) // SRE-5: pre-write cancellation check.
  await writeFile(path, encodeText(after, encoding))
  // SRE-5: committed write wins over a late abort.
  const abortedAfterCommit = signal?.aborted === true
  const { diff, firstChangedLine } = generateDiffString(before, after)
  return {
    text: `The file ${path} has been edited successfully.`,
    kind: args.command,
    path,
    diff,
    firstChangedLine,
    committed: true,
    cancellationObservedAfterCommit: abortedAfterCommit,
  }
}

/**
 * Run one editor command. Mutation commands read-modify-write in memory and
 * must be wrapped by the caller in pi's per-file mutation queue; `view` is
 * read-only and needs no queue.
 */
export async function runEditor(args: EditorArgs, options: EditorOptions): Promise<EditorResult> {
  // SRE-6: exhaustive runtime command validation — schema can be bypassed by
  // handlers, so the command is checked here before any work happens.
  if (!isEditorCommand(args.command)) {
    throw new Error(
      `Unknown command \`${String(args.command)}\`. Allowed commands: view, create, str_replace, insert.`,
    )
  }
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const path = resolveToolPath(args.path, options.cwd)
  throwIfAborted(options.signal)
  switch (args.command) {
    case "view":
      return viewPath(path, args.view_range, maxOutputChars, options.signal)
    case "create":
    case "str_replace":
    case "insert":
      return runMutation(args, path, maxOutputChars, options.signal)
  }
}

/**
 * Compute the display diff a mutation command would produce, without writing.
 * Mirrors pi's built-in edit preview: a thrown error becomes the preview error.
 */
export async function computeEditorDiff(
  args: EditorArgs,
  options: EditorOptions,
): Promise<{ diff: string; firstChangedLine?: number }> {
  if (!isEditorCommand(args.command)) {
    throw new Error(
      `Unknown command \`${String(args.command)}\`. Allowed commands: view, create, str_replace, insert.`,
    )
  }
  const path = resolveToolPath(args.path, options.cwd)
  if (args.command === "create") {
    const content = requiredForCommand(args.file_text, "file_text", "create")
    await requireAbsent(path, options.signal)
    return generateDiffString("", content)
  }
  await requireEditableFile(path, options.signal)
  const { content: before } = await readNormalizedFile(path, options.signal)
  const after = args.command === "str_replace"
    ? computeReplaceAfter(before, args, path)
    : computeInsertAfter(before, args)
  return generateDiffString(before, after)
}

/**
 * Generate a display-oriented diff with line numbers, in the format pi's
 * `renderDiff` parses (`+N content` / `-N content` / ` N content` with
 * context lines and `...` skips).
 *
 * Every mutation this tool performs changes exactly one contiguous region
 * (one literal replacement, one line insertion, or a whole-file create), so
 * a common prefix/suffix line trim yields the exact minimal diff in O(n+m)
 * without a diff-library dependency. Empty inputs map to zero lines so a
 * create never reports a phantom deleted line (SRE-8).
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const oldLines = oldContent === "" ? [] : oldContent.split("\n")
  const newLines = newContent === "" ? [] : newContent.split("\n")
  const maxLineNum = Math.max(oldLines.length, newLines.length)
  const lineNumWidth = String(maxLineNum).length

  let prefix = 0
  const prefixCap = Math.min(oldLines.length, newLines.length)
  while (prefix < prefixCap && oldLines[prefix] === newLines[prefix]) prefix += 1

  let suffix = 0
  const suffixCap = prefixCap - prefix
  while (
    suffix < suffixCap
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const removedStart = prefix
  const removedEnd = oldLines.length - suffix
  const addedStart = prefix
  const addedEnd = newLines.length - suffix

  if (removedStart === removedEnd && addedStart === addedEnd) {
    // Identical content (e.g. old_str equals new_str): no diff lines.
    return { diff: "", firstChangedLine: undefined }
  }

  const output: string[] = []
  if (prefix > contextLines) {
    output.push(` ${"".padStart(lineNumWidth, " ")} ...`)
  }
  const leadStart = Math.max(0, prefix - contextLines)
  for (let i = leadStart; i < prefix; i++) {
    const lineNum = String(i + 1).padStart(lineNumWidth, " ")
    output.push(` ${lineNum} ${oldLines[i]}`)
  }
  for (let i = removedStart; i < removedEnd; i++) {
    const lineNum = String(i + 1).padStart(lineNumWidth, " ")
    output.push(`-${lineNum} ${oldLines[i]}`)
  }
  for (let i = addedStart; i < addedEnd; i++) {
    const lineNum = String(i + 1).padStart(lineNumWidth, " ")
    output.push(`+${lineNum} ${newLines[i]}`)
  }
  const tailStart = oldLines.length - suffix
  for (let i = 0; i < Math.min(contextLines, suffix); i++) {
    const lineNum = String(tailStart + i + 1).padStart(lineNumWidth, " ")
    output.push(` ${lineNum} ${oldLines[tailStart + i]}`)
  }
  if (suffix > contextLines) {
    output.push(` ${"".padStart(lineNumWidth, " ")} ...`)
  }
  return { diff: output.join("\n"), firstChangedLine: prefix + 1 }
}


/**
 * Model-facing `str_replace_editor` tool for pi, with a TUI that mirrors
 * pi's built-in `edit` tool: live diff preview while the model types, a
 * settled diff on the result, and pending/success/error shell backgrounds.
 * @module pi-extension-str-replace-editor/tool
 */

import { StringEnum, Type, type Static } from "@earendil-works/pi-ai"
import { defineTool, getLanguageFromPath, highlightCode, keyHint, renderDiff, withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Box, Spacer, Text, type Component } from "@earendil-works/pi-tui"

export const EditorParameters = Type.Object({
  command: StringEnum(["view", "create", "str_replace", "insert"] as const, {
    description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
  }),
  path: Type.String({
    description: "Path to file or directory, absolute or relative to the working directory.",
    minLength: 1,
  }),
  file_text: Type.Optional(Type.String({
    description: "Required parameter of `create` command, with the content of the file to be created.",
  })),
  insert_line: Type.Optional(Type.Integer({
    description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
    minimum: 0,
  })),
  new_str: Type.Optional(Type.String({
    description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
  })),
  old_str: Type.Optional(Type.String({
    description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
  })),
  view_range: Type.Optional(Type.Array(Type.Integer(), {
    description: "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
    minItems: 2,
    maxItems: 2,
  })),
})

export type EditorParameters = Static<typeof EditorParameters>

/** The tool definition with its concrete generics; tests use this for renderer typing. */
export type EditorToolDefinition = ToolDefinition<typeof EditorParameters, EditorDetails, RenderState>

/** UI-only details: the LLM sees `content`, the TUI renders these. */
export interface EditorDetails {
  kind: "view" | "create" | "str_replace" | "insert"
  path: string
  diff?: string
  firstChangedLine?: number
  /** view: raw content slice behind the numbering, for TUI highlighting. */
  viewLines?: string[]
  /** view: sorted `type<TAB>path` listing rows for directories, for TUI display. */
  viewRows?: string[]
  /** view: first displayed line number (1-based). */
  viewStartLine?: number
  /** view: total lines in the file. */
  viewTotalLines?: number
  /** view: lines in the requested range (differs from viewTotalLines when view_range is used). */
  viewRangeLines?: number
  /** view: whether the numbered text was clipped at maxOutputChars. */
  clipped?: boolean
  /** view: whether details hold only a prefix of the displayed lines/rows. */
  viewTruncated?: boolean
  /** view: total rows for directories. */
  viewTotalRows?: number
  /** mutation: whether the write hit the disk (SRE-5). */
  committed?: boolean
  /** mutation: whether cancellation was observed after the write committed (SRE-5). */
  cancellationObservedAfterCommit?: boolean
}

/** Configuration for the tool, validated like the original plugin. */
export interface StrReplaceEditorOptions {
  /** Maximum returned view characters before clipping (default 16000). */
  maxOutputChars?: number
  /** Model-facing tool description. */
  description?: string
}

type EditPreview = { diff: string; firstChangedLine?: number } | { error: string }

type RenderState = {
  callComponent?: CallRenderComponent
}

type CallRenderComponent = Box & {
  preview?: EditPreview
  previewArgsKey?: string
  previewPending?: boolean
  settledError?: boolean
  /** Whether the result has settled; drives the success background for preview-less commands like view. */
  settled?: boolean
}

const MUTATION_COMMANDS = new Set(["create", "str_replace", "insert"])

function createCallRenderComponent(): CallRenderComponent {
  return Object.assign(new Box(1, 1, (text: string) => text), {
    preview: undefined as EditPreview | undefined,
    previewArgsKey: undefined as string | undefined,
    previewPending: false,
    settledError: false,
    settled: false,
  })
}

function getCallRenderComponent(state: RenderState, lastComponent: unknown): CallRenderComponent {
  if (lastComponent instanceof Box) {
    const component = lastComponent as CallRenderComponent
    state.callComponent = component
    return component
  }
  if (state.callComponent) {
    return state.callComponent
  }
  const component = createCallRenderComponent()
  state.callComponent = component
  return component
}

type RenderableArgs = EditorArgs | undefined

function previewInput(args: RenderableArgs): { command: EditorArgs["command"]; path: string } | null {
  if (!args || typeof args.path !== "string" || args.path.length === 0) return null
  return { command: args.command, path: args.path }
}

function previewArgsKey(input: { command: string; path: string } | null, args: RenderableArgs): string | undefined {
  if (!input) return undefined
  return JSON.stringify({
    command: input.command,
    path: input.path,
    file_text: args?.file_text,
    insert_line: args?.insert_line,
    new_str: args?.new_str,
    old_str: args?.old_str,
  })
}

async function computePreview(
  input: { command: EditorArgs["command"]; path: string },
  args: EditorArgs,
  cwd: string,
): Promise<EditPreview> {
  try {
    return await computeEditorDiff(args, { cwd })
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function headerBg(
  preview: EditPreview | undefined,
  settledError: boolean | undefined,
  settled: boolean | undefined,
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
): (text: string) => string {
  if (preview) {
    if ("error" in preview) {
      return (text: string) => theme.bg("toolErrorBg", text)
    }
    return (text: string) => theme.bg("toolSuccessBg", text)
  }
  if (settledError) {
    return (text: string) => theme.bg("toolErrorBg", text)
  }
  if (settled) {
    return (text: string) => theme.bg("toolSuccessBg", text)
  }
  return (text: string) => theme.bg("toolPendingBg", text)
}

function buildCallComponent(
  component: CallRenderComponent,
  args: RenderableArgs,
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
  collapsed: boolean,
): CallRenderComponent {
  component.setBgFn(headerBg(component.preview, component.settledError, component.settled, theme))
  component.clear()
  const command = args?.command ?? "str_replace_editor"
  const path = args?.path ?? ""
  let title = `${theme.fg("toolTitle", theme.bold(command))}${path ? ` ${theme.fg("muted", path)}` : ""}`
  if (args?.command === "view" && collapsed) {
    // Mirror the read tool: advertise expandability while the content slot is collapsed.
    title += ` ${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`
  }
  // The live diff is an estimate until the result settles.
  if (component.preview && !component.settled) {
    title += ` ${theme.fg("dim", "(preview)")}`
  }
  component.addChild(new Text(title, 0, 0))

  if (!component.preview) {
    return component
  }

  const body = "error" in component.preview
    ? theme.fg("error", component.preview.error)
    : renderDiff(component.preview.diff, { filePath: path || undefined })
  component.addChild(new Spacer(1))
  component.addChild(new Text(body, 0, 0))
  return component
}

function setPreview(component: CallRenderComponent, preview: EditPreview, argsKey: string | undefined): boolean {
  const current = component.preview
  const changed =
    current === undefined ||
    ("error" in current && "error" in preview
      ? current.error !== preview.error
      : "error" in current !== "error" in preview) ||
    (!("error" in current) &&
      !("error" in preview) &&
      (current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine))
  component.preview = preview
  component.previewArgsKey = argsKey
  component.previewPending = false
  return changed
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n") || undefined
}

/**
 * Trim trailing empty lines from the numbered view output for display,
 * mirroring the read tool's trailing empty-line trimming. After numbering,
 * an empty source line renders as `     7  ` (padded line number + two
 * spaces), so both that shape and bare empty lines are trimmed.
 */
function trimTrailingEmptyNumberedLines(text: string): string {
  const lines = text.split("\n")
  let end = lines.length
  while (end > 0 && (lines[end - 1] === "" || /^\s*\d+ {2}$/.test(lines[end - 1]))) end -= 1
  return lines.slice(0, end).join("\n")
}

/**
 * Render the view output for the TUI, mirroring pi's read (files) and ls
 * (directories) tools: no verbose model-facing header, syntax-highlighted
 * numbered lines for files, colored entries for directories. Directories
 * show a 20-row preview while collapsed like ls; files show nothing
 * collapsed like read. Details-truncated views get an explicit marker (SRE-4).
 */
function renderViewOutput(
  details: EditorDetails | undefined,
  content: { content: Array<{ type: string; text?: string }> },
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
  expanded: boolean,
): string | undefined {
  if (details === undefined) return undefined
  if (details.clipped) {
    // The displayed text was truncated; render it as-is (it carries the
    // `<response clipped>` marker) with trailing empty numbered lines trimmed.
    const text = resultText(content)
    return text === undefined ? undefined : theme.fg("toolOutput", trimTrailingEmptyNumberedLines(text))
  }
  if (details.viewRows !== undefined) {
    const rendered = renderDirectoryRows(details.viewRows, theme, expanded)
    if (details.viewTruncated && expanded) {
      const hidden = (details.viewTotalRows ?? details.viewRows.length) - details.viewRows.length
      return `${rendered}\n${theme.fg("dim", `... ${hidden} more rows not shown`)}`
    }
    return rendered
  }
  if (details.viewLines === undefined || !expanded) return undefined
  const lines = [...details.viewLines]
  let end = lines.length
  while (end > 0 && lines[end - 1] === "") end -= 1
  const visibleLines = lines.slice(0, end)
  const lang = getLanguageFromPath(details.path)
  const rendered = lang !== undefined
    ? highlightCode(visibleLines.join("\n"), lang)
    : visibleLines
  const startLine = details.viewStartLine ?? 1
  let output = rendered
    .map((line, index) => {
      // Compact 3-wide number field in the muted color: clearly a gutter,
      // not an indentation; grows naturally past 999 lines.
      const number = String(startLine + index).padStart(3, " ")
      return `${theme.fg("muted", number)} ${line.replace(/\t/g, "   ")}`
    })
    .join("\n")
  if (details.viewTruncated) {
    // Hidden counts only lines inside the requested range that the details
    // cap dropped — never the (never-requested) rest of the file. Both
    // counts are relative, so no absolute line numbers mix in.
    const rangeLines = details.viewRangeLines ?? details.viewTotalLines ?? visibleLines.length
    const hidden = rangeLines - visibleLines.length
    output += `\n${theme.fg("dim", `... ${Math.max(0, hidden)} more lines not shown`)}`
  }
  return output
}

/**
 * Render directory rows without the verbose header: directories in accent
 * bold, files in the output color, other entries dim; collapsed shows the
 * first 20 rows with an expand hint, like the ls tool.
 */
function renderDirectoryRows(
  rows: string[],
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
  expanded: boolean,
): string {
  const rendered = rows.map((row) => {
    const tab = row.indexOf("\t")
    const type = tab >= 0 ? row.slice(0, tab) : ""
    const entryPath = tab >= 0 ? row.slice(tab + 1) : row
    const coloredPath = type === "d"
      ? theme.fg("accent", theme.bold(entryPath))
      : type === "f"
        ? theme.fg("toolOutput", entryPath)
        : theme.fg("dim", entryPath)
    return type.length > 0 ? `${theme.fg("dim", type)}\t${coloredPath}` : coloredPath
  })
  if (expanded) return rendered.join("\n")
  const maxLines = 20
  const shown = rendered.slice(0, maxLines)
  const remaining = rendered.length - shown.length
  let text = shown.join("\n")
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
  }
  return text
}

/**
 * Build the registered tool. The original plugin's Config validation is kept:
 * `maxOutputChars` must be a positive safe integer and `description` non-empty.
 */
export function createStrReplaceEditorTool(
  options: StrReplaceEditorOptions = {},
): ToolDefinition<typeof EditorParameters, EditorDetails, RenderState> {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const description = options.description ?? DEFAULT_DESCRIPTION
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars <= 0) {
    throw new Error("pi-extension-str-replace-editor: maxOutputChars must be a positive safe integer")
  }
  if (description.trim().length === 0) {
    throw new Error("pi-extension-str-replace-editor: description must be non-empty")
  }

  return defineTool({
    name: "str_replace_editor",
    label: "str_replace_editor",
    description,
    promptSnippet: "View, create, and edit files with view/create/str_replace/insert commands",
    promptGuidelines: [
      "Use str_replace_editor's view command to inspect files and directories before editing; its insert command inserts after a line number.",
      "In str_replace_editor, old_str must match exactly (including whitespace) and uniquely; include more surrounding lines when a match is ambiguous.",
    ],
    parameters: EditorParameters,
    renderShell: "self",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // SRE-6: runtime re-validation — schema enforcement can be bypassed by
      // programmatic handlers; the command is checked again here so the
      // mutation-queue decision and runEditor see the same verified value.
      if (!isEditorCommand(params.command)) {
        throw new Error(
          `Unknown command \`${String(params.command)}\`. Allowed commands: view, create, str_replace, insert.`,
        )
      }
      const isMutation = MUTATION_COMMANDS.has(params.command)
      const result = isMutation
        // Queue the whole read-modify-write window per target file, like the
        // built-in edit/write tools, because pi runs tool calls in parallel.
        ? await withFileMutationQueue(resolveToolPath(params.path, ctx.cwd), () =>
          runEditor(params, { cwd: ctx.cwd, maxOutputChars, signal }))
        : await runEditor(params, { cwd: ctx.cwd, maxOutputChars, signal })
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          kind: result.kind,
          path: result.path,
          diff: result.diff,
          firstChangedLine: result.firstChangedLine,
          viewLines: result.viewLines,
          viewRows: result.viewRows,
          viewStartLine: result.viewStartLine,
          viewTotalLines: result.viewTotalLines,
          viewRangeLines: result.viewRangeLines,
          clipped: result.clipped,
          viewTruncated: result.viewTruncated,
          viewTotalRows: result.viewTotalRows,
          committed: result.committed,
          cancellationObservedAfterCommit: result.cancellationObservedAfterCommit,
        },
      }
    },

    renderCall(args, theme, context) {
      const component = getCallRenderComponent(context.state, context.lastComponent)
      const input = previewInput(args as RenderableArgs)
      const argsKey = previewArgsKey(input, args as RenderableArgs)

      if (component.previewArgsKey !== argsKey) {
        component.preview = undefined
        component.previewArgsKey = argsKey
        component.previewPending = false
        component.settledError = false
        component.settled = false
      }

      if (
        context.argsComplete
        && input
        && MUTATION_COMMANDS.has(input.command)
        && !component.preview
        && !component.previewPending
      ) {
        component.previewPending = true
        const requestKey = argsKey
        void computePreview(input, args as EditorArgs, context.cwd).then((preview) => {
          if (component.previewArgsKey === requestKey) {
            setPreview(component, preview, requestKey)
            context.invalidate()
          }
        })
      }

      return buildCallComponent(component, args as RenderableArgs, theme, !context.expanded)
    },

    renderResult(result, options, theme, context) {
      const callComponent = context.state.callComponent
      const args = context.args as RenderableArgs
      const input = previewInput(args)
      const argsKey = previewArgsKey(input, args)
      const typedResult = result as { content: Array<{ type: string; text?: string }>; details?: EditorDetails }
      const resultDiff = !context.isError ? typedResult.details?.diff : undefined
      let changed = false
      if (callComponent) {
        if (typeof resultDiff === "string") {
          changed =
            setPreview(
              callComponent,
              { diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
              argsKey,
            ) || changed
        }
        if (callComponent.settledError !== context.isError) {
          callComponent.settledError = context.isError
          changed = true
        }
        if (callComponent.settled !== true) {
          callComponent.settled = true
          changed = true
        }
        if (changed) {
          buildCallComponent(callComponent, args, theme, !context.expanded)
        }
      }

      // The result slot mirrors the diff-card structure: a Box whose bgFn
      // paints every child line (spacer included) with the settled state
      // background, so view content sits on the same tint as create diffs.
      const resultBg = (text: string) => theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text)
      const component = (context.lastComponent as Box | undefined) ?? new Box(0, 0, resultBg)
      component.setBgFn(resultBg)
      component.clear()
      if (options.isPartial) {
        return component
      }

      let output: string | undefined
      if (context.isError) {
        const errorText = resultText(typedResult)
        const previewError = callComponent?.preview && "error" in callComponent.preview
          ? callComponent.preview.error
          : undefined
        if (errorText && errorText !== previewError) {
          output = theme.fg("error", errorText)
        }
      } else if (args?.command === "view") {
        // Mirror read (files) and ls (directories): highlighted numbered
        // content when expanded, colored rows with a collapsed preview for
        // directories. The verbose model-facing header is not repeated.
        output = renderViewOutput(typedResult.details, typedResult, theme, options.expanded)
      } else if (resultDiff && resultDiff !== (callComponent?.preview && "diff" in callComponent.preview ? callComponent.preview.diff : undefined)) {
        output = renderDiff(resultDiff, { filePath: args?.path })
      }

      if (!output) {
        return component
      }
      component.addChild(new Spacer(1))
      component.addChild(new Text(output, 1, 0))
      // Trailing tinted blank line separates this tool row from the next,
      // matching the shell padding other tool rows get.
      component.addChild(new Spacer(1))
      return component
    },
  })
}


/**
 * pi extension entry: registers the `str_replace_editor` tool.
 *
 * Load with `pi -e <this directory>` or `pi install <this directory>`.
 * @module pi-extension-str-replace-editor
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI): void {
  pi.registerTool(createStrReplaceEditorTool())
}
