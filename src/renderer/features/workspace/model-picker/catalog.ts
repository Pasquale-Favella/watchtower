import type { CoachHarnessRow } from '@/shared/schemas/agents.js'
import type { WorkspaceConnectionInspection } from '@/shared/schemas/workspace-connections.js'

export interface EffortChoice {
  readonly id: string
  readonly label: string
}

export interface ModelChoice {
  readonly id: string
  readonly label: string
  /** What the model is for, shown under its name. */
  readonly description?: string | undefined
  /** Effort choices this model offers. Absent when the agent declares none for it. */
  readonly modes?: readonly EffortChoice[] | undefined
}

/** What the picker can list for one connection. `session` lists only models observed in a native session. */
export type CatalogView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'listed'; readonly models: readonly ModelChoice[] }
  | { readonly kind: 'session'; readonly models: readonly ModelChoice[] }

export interface CatalogInput {
  readonly inspection: WorkspaceConnectionInspection | null
  readonly failed: boolean
  /** Models observed from the Conversation's native session, when the parent has them. */
  readonly sessionModels?: readonly ModelChoice[] | undefined
}

/** A connection-scoped list is authoritative. Session-scoped or unknown catalogs list only observed models. */
export function catalogView(input: CatalogInput): CatalogView {
  const observed = input.sessionModels ?? []
  const inspection = input.inspection
  if (inspection) {
    const { models } = inspection.capabilities
    if (models.state === 'connection-scoped') return { kind: 'listed', models: models.items }
    if (observed.length > 0) return { kind: 'session', models: observed }
    return { kind: 'session', models: models.state === 'session-scoped' ? models.items : [] }
  }
  if (observed.length > 0) return { kind: 'session', models: observed }
  return { kind: input.failed ? 'failed' : 'loading' }
}

/** Models a selection can be checked against, or null while the catalog is unknown. */
export function knownModels(view: CatalogView): readonly ModelChoice[] | null {
  if (view.kind === 'listed') return view.models
  if (view.kind === 'session' && view.models.length > 0) return view.models
  return null
}

/** Connection-level effort choices, or null when the agent has not declared any. */
export function connectionEffort(inspection: WorkspaceConnectionInspection | null): readonly EffortChoice[] | null {
  if (!inspection) return null
  const { modes } = inspection.capabilities
  if (modes.state === 'connection-scoped') return modes.items
  return modes.state === 'session-scoped' && modes.items.length > 0 ? modes.items : null
}

/**
 * Effort choices for the model, or the connection-level choices when no model is picked. Null when unknown.
 * A known model with no declared effort choices offers none.
 */
export function effortFor(input: {
  readonly models: readonly ModelChoice[] | null
  readonly connectionEffort: readonly EffortChoice[] | null
  readonly modelId: string
}): readonly EffortChoice[] | null {
  if (!input.modelId) return input.connectionEffort
  const model = input.models?.find(candidate => candidate.id === input.modelId)
  if (!model) return null
  return model.modes ?? input.connectionEffort ?? []
}

const REASONING_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** "Effort" for reasoning levels (Claude, Codex, OpenCode); "Mode" for agent-defined session modes. */
export function effortTitleFor(options: readonly EffortChoice[] | null): 'Effort' | 'Mode' {
  return !options?.length || options.every(option => REASONING_LEVELS.has(option.id.toLowerCase())) ? 'Effort' : 'Mode'
}

/** Rail status from the picker's own inspection state. Detection alone reports the agent as ready. A
 *  signed-out agent is unavailable and an agent whose sign-in could not be verified needs attention. */
export function connectionStatus(reading: {
  readonly inspection: WorkspaceConnectionInspection | null
  readonly pending: boolean
  readonly failed: boolean
}): CoachHarnessRow['status'] {
  if (reading.pending && !reading.inspection) return 'pending'
  if (reading.failed) return 'error'
  const inspection = reading.inspection
  if (!inspection) return 'ready'
  if (inspection.authentication === 'unauthenticated') return 'error'
  if (inspection.statusMessage || inspection.protocol.state !== 'initialized') return 'warning'
  return 'ready'
}

/** What the rail and model list say about an agent: its account when signed in, otherwise what to do. */
export function connectionDetail(reading: {
  readonly inspection: WorkspaceConnectionInspection | null
  readonly pending: boolean
  readonly failed: boolean
}): string | null {
  if (reading.pending && !reading.inspection) return 'Checking…'
  if (reading.failed) return 'Could not be checked. Try again.'
  const inspection = reading.inspection
  if (!inspection) return null
  if (inspection.statusMessage) return inspection.statusMessage
  const account = [inspection.account?.label, inspection.account?.email].filter(Boolean).join(' · ')
  return account || null
}
