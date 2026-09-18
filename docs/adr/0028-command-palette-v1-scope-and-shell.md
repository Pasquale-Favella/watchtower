# Command palette v1: shadcn Command shell, registry-owned trigger, 11-row scope

Status: accepted

Issue #123 lists `palette + global search` (Phase 3) and `Command palette + PoP delta` (Top 10) with no scope. We ship one `Mod+K` dialog built on the shadcn `Command` primitive over `cmdk`, triggered through the ADR 0001 shortcut registry as `commandPalette`, listing exactly the 11 `SHORTCUTS` entries (9 Sections + refresh + toggleSidebar); ledger content search is a deferred row source, blocked on W3 pagination and W15 redaction.

## Considered options

- **Hand-rolled dialog + combobox filter**: no new dep, but rebuilds grouping/empty-state/filtering the canonical primitive already owns.
- **Local `useHotkey('Mod+K')` in the palette component**: fastest wiring, but the first ADR 0001 violation — a keycap literal outside the registry and a second source to drift.
- **v1 with content search (sessions/models/PRs)**: rejected — inherits full-scan aggregation with no LIMIT and wipe-only prompt retention, so it ships the scaling and GDPR risk before the prerequisites land.

## Consequences

- New dep `cmdk` (renderer-only) + `shared/components/ui/command.tsx` (base-nova style, manual path move — `components.json` aliases don't match `shared/components/ui`).
- `CommandInput` diverges from the latest canonical (plain bordered row + `SearchIcon`, no `InputGroup`): the repo has no `input-group.tsx`/`textarea.tsx` and v1 needs no addon slots; revisit if addons are ever needed.
- `shortcutActionSchema` gains `commandPalette`; `NUMBERED_SECTION_SHORTCUTS`/footer range exclude it; the palette never lists itself.
- Rows carry `source: section | action` so global search plugs in as a third source without rebuilding the shell.
