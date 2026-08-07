import type { ProjectSummary } from '../types.js'
import { aggregateTotals } from '../format.js'

/**
 * Serializza tutti i progetti + un blocco `aggregate` di primo livello.
 * Include l'intera struttura ProjectSummary (con sessions, turns, calls) —
 * pesante ma completo; ideale per re-processing esterno.
 */
export function renderJsonReport(projects: ProjectSummary[]): string {
  const aggregate = aggregateTotals(projects)
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    aggregate,
    projects,
  }
  return JSON.stringify(payload, null, 2)
}
