# Global Instructions

- For exact-match file edits, prefer `str_replace_editor` (`view` the target region first, then `str_replace` with text copied from that view).
- Before any precise edit (`edit` or `str_replace`), always read the exact target lines first — never construct old text from memory. Watch for tab indentation and trailing punctuation.
- Reserve the built-in `edit` tool for multiple disjoint changes to the same file in one batch; use `write` only for full rewrites.
