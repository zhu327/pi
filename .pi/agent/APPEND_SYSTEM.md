# File discovery and reading

- Use `bash` for repository discovery: `rg` for text search, `rg --files` for file lists, `fd` for filename or file-type queries. `rg` and `fd` are always installed — never fall back to `grep`, `egrep`, `fgrep`, or `find`.
- Use `ls` only for single-directory listings, never for recursive discovery.
- Keep discovery targeted: scope searches to relevant paths and file types, exclude generated or vendor directories, cap broad output, and combine independent queries when useful.
- Once relevant paths or line ranges are known, use `read`; for large files, locate relevant symbols or lines first and read only the needed ranges.

# Edit reliability

- Read the target region before calling `edit`; copy `oldText` exactly from the file, not from memory.
- If an edit fails to match, re-read the region and retry — never guess or blindly widen `oldText`.
