# File discovery and reading

- Use `rg` for text search, `rg --files` for file lists, and `fd` for filename or file-type queries. `rg` and `fd` are always installed — prefer them over `grep`/`find`, and fall back only when they genuinely cannot handle the task.
- Use `ls` only for single-directory listings, never for recursive discovery. Recursive scans are slow, noisy, and easy to mis-scope.
- Keep discovery targeted: scope searches to relevant paths and file types, exclude generated or vendor directories, cap broad output, and combine independent queries when useful.
- Once relevant paths or line ranges are known, use `read`; for large files, locate relevant symbols or lines first and read only the needed ranges.

# Edit reliability

- Read the target region before calling `edit`; copy `oldText` exactly from the file, not from memory. Reading first keeps `oldText` unique and prevents accidental edits.
- If an edit fails to match, re-read the region and retry — never guess or blindly widen `oldText`.
- After editing, verify the change (e.g., re-read the edited lines or `git diff`) before moving on.
