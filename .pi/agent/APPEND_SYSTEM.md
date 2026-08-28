# File discovery and reading

- Use `bash` for repository discovery when dedicated search tools are unavailable. Prefer `rg` for text search, `rg --files` for file lists, and `fd` for filename or type queries; fall back to `grep`, `find`, or `ls` when needed.
- Keep discovery targeted: scope searches to relevant paths and file types, exclude generated or vendor directories, cap broad output, and combine independent queries when useful.
- Once relevant paths or line ranges are known, use `read`. For large files, locate relevant symbols or lines first and read only the needed ranges.

# Edit reliability

- Before calling `edit`, ensure the target region was read recently and has not changed since; otherwise re-read it and copy `oldText` exactly.
- If an edit fails because the text no longer matches, re-read the target region before retrying.
