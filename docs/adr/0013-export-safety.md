# Export safety: native pickers, full history, CSV-injection guard, and disciplined overwrites

Status: accepted

Export (`src/main/export.ts` + the IPC handler in `index.ts`) writes the **full history** (no date filter) of the ledger as CSV (a folder of one table per file) or JSON (`watchtower.export.v1`), with costs converted to the display currency active at export time — the store is never rewritten (ADR 0009). Files are written through **native dialogs**: a folder picker for CSV, a save dialog for JSON, both cancellable.

Deliberate safety decisions:

- **CSV-injection guard** — any field beginning with `\t\r=+-@` is prefixed with `'`, and fields containing commas/quotes/newlines are quoted, so a crafted model name or tool name can never become a spreadsheet formula.
- **Overwrite discipline** — CSV treats the output as a directory (strips a trailing `.csv`), refuses to overwrite a plain file, refuses to reuse a directory that isn't a prior export (no `.watchtower-export` marker), and drops that marker into every folder it creates so an older export can be safely overwritten without ever deleting a user's unrelated files by accident. JSON refuses to overwrite a file whose head lacks the `watchtower.export.v` schema marker and refuses a directory target.
- **Boundary conversion** — every cost column passes through convert→round in the selected currency and is labeled with its code; token counts stay raw integers.

**Why:** export is the one feature that writes outside the app's own data directory, onto the user's filesystem. It must be impossible for the export to clobber unrelated work (the marker + refusal checks), to produce spreadsheets that self-execute (the injection guard), or to silently mislabel money (explicit currency headers and boundary conversion).
