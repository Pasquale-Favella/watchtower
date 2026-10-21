# Export safety: native pickers, full history, CSV-injection guard, and disciplined overwrites

Status: accepted

Export (`src/main/export.ts` + the IPC handler in `index.ts`) writes the **full history** (no date filter) of the ledger as CSV (a folder of one table per file) or JSON (`watchtower.export.v1`), with costs converted to the display currency active at export time — the store is never rewritten (ADR 0009). Files are written through **native dialogs**: a folder picker for CSV, a save dialog for JSON, both cancellable. (The Settings CSV flow later moved to a zip save dialog; see ZIP delivery below.)

Deliberate safety decisions:

- **CSV-injection guard** — any field beginning with a tab, CR, LF, `=`, `+`, `-`, `@` or the full-width `＝＋－＠` is prefixed with `'` (Papa Parse `escapeFormulae`), and fields containing commas/quotes/newlines are quoted, so a crafted model name or tool name can never become a spreadsheet formula.
- **Overwrite discipline** — CSV treats the output as a directory (strips a trailing `.csv`), refuses to overwrite a plain file, refuses to reuse a directory that isn't a prior export (no `.watchtower-export` marker), and drops that marker into every folder it creates so an older export can be safely overwritten without ever deleting a user's unrelated files by accident. JSON refuses to overwrite a file whose head lacks the `watchtower.export.v` schema marker and refuses a directory target.
- **Boundary conversion** — every cost column passes through convert→round in the selected currency and is labeled with its code; token counts stay raw integers.

**Why:** export is the one feature that writes outside the app's own data directory, onto the user's filesystem. It must be impossible for the export to clobber unrelated work (the marker + refusal checks), to produce spreadsheets that self-execute (the injection guard), or to silently mislabel money (explicit currency headers and boundary conversion).

**ZIP delivery (2026-10, the Settings › Export CSV flow):** the pane no longer offers the CSV folder picker; it uses the JSON-style save dialog for one `watchtower-export-<stamp>.zip` artifact (defaulting into `Documents`). The files are staged in a folder the app creates itself inside a scoped private temp directory (Effect `FileSystem`; the staging path is a not-yet-existing child, so the marker discipline above still governs every folder the app writes), packed with `adm-zip` into a single top-level folder inside the archive, and written atomically via a temp file in a randomly named directory beside the target, then rename, so a failed write never destroys a previous export. The scope removes staging on success, failure and interruption. Overwriting the zip target requires the save dialog's own replace confirmation; no user-owned folder is ever staged or wiped. Explicit-destination callers (scripts, e2e) keep the classic marked-folder behaviour.
