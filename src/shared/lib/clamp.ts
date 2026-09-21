/** Floors an unknown page-shaped value into `[min, max]`, falling back to
 * `fallback` for anything non-numeric (request scopes are typed, not
 * zod-validated per ADR 0008 — garbage normalizes instead of throwing).
 * Shared by the main-process page normalizers and the renderer's pager so the
 * clamping shape lives in one place. */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(raw, min), max)
}
