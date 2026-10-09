import * as Schema from 'effect/Schema'

import type { CoachSessionModels, CoachSessionModes } from '../../shared/schemas/agents.js'

/** A valid UI selection that the advertised session cannot apply because the
 *  agent exposed no matching setter. This is separate from SDK rejection. */
export class SelectionUnavailableError extends Schema.TaggedError<SelectionUnavailableError>()(
  'SelectionUnavailableError',
  { message: Schema.String },
) {}

interface AcpSessionResponse {
  models?: unknown
  modes?: unknown
  configOptions?: unknown
}

interface ConfigSelectValue {
  value: string
  name: string
  description?: string
}

export interface ConfigSelectInfo {
  id: string
  values: Set<string>
  current?: string
}

export interface LegacySelectInfo {
  ids: Set<string>
  current?: string
}

export interface HarnessCatalog {
  models?: CoachSessionModels
  modes?: CoachSessionModes
  selects: {
    model?: ConfigSelectInfo
    mode?: ConfigSelectInfo
    thinking?: ConfigSelectInfo
  }
  legacy: {
    models?: LegacySelectInfo
    modes?: LegacySelectInfo
  }
}

export type RoutingChannel = 'config' | 'legacy'

export interface RoutingPolicy {
  modelOrder: RoutingChannel[]
  modeOrder: RoutingChannel[]
  bracketedModelIds: 'decompose' | 'none'
  minimalModelOrder: RoutingChannel[]
  minimalModeConfigIds: string[]
}

// Routing is value-aware: a pick goes to the channel whose catalog advertises it,
// so the live agents below all share the default row (verified against each):
// - codex: bracketed ids (`gpt-5.6-luna[high]`) decompose into model + reasoning_effort config writes.
// - pi: legacy setSessionModel is "Method not found" — its models only resolve via config; thinking modes via legacy.
// - opencode: model and mode are advertised via configOptions only.
// - claude-agent-acp: config model/effort with legacy modes.
// Add a row only for a harness that must deviate from the default.
const DEFAULT_ROUTING: RoutingPolicy = {
  modelOrder: ['config', 'legacy'],
  modeOrder: ['legacy', 'config'],
  bracketedModelIds: 'decompose',
  minimalModelOrder: ['config', 'legacy'],
  minimalModeConfigIds: ['mode', 'thought_level'],
}

export const MODEL_ROUTING: Record<string, RoutingPolicy> = {
  default: DEFAULT_ROUTING,
}

export function routingPolicyFor(kind: string): RoutingPolicy {
  return MODEL_ROUTING[kind] ?? DEFAULT_ROUTING
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Flattens flat and grouped ACP select values without trusting agent input. */
function flattenConfigOptions(options: unknown): ConfigSelectValue[] {
  if (!Array.isArray(options)) return []
  const out: ConfigSelectValue[] = []
  for (const entry of options) {
    if (!isRecord(entry)) continue
    if (Array.isArray(entry.options)) {
      const groupName = asString(entry.name) ?? asString(entry.group) ?? ''
      for (const nested of entry.options) {
        if (!isRecord(nested)) continue
        const value = asString(nested.value)
        const name = asString(nested.name)
        if (!value || !name) continue
        out.push({
          value,
          name: groupName ? `${groupName} / ${name}` : name,
          ...(typeof nested.description === 'string' ? { description: nested.description } : {}),
        })
      }
      continue
    }
    const value = asString(entry.value)
    const name = asString(entry.name)
    if (!value || !name) continue
    out.push({
      value,
      name,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    })
  }
  return out
}

function configOption(
  session: AcpSessionResponse,
  category: 'model' | 'mode',
): (Record<string, unknown> & { id: string }) | undefined {
  if (!Array.isArray(session.configOptions)) return undefined
  let byId: (Record<string, unknown> & { id: string }) | undefined
  for (const entry of session.configOptions) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    if (!id) continue
    const candidate = entry as Record<string, unknown> & { id: string }
    if (entry.category === category) return candidate
    if (id === category && !byId) byId = candidate
  }
  return byId
}

function thinkingOption(session: AcpSessionResponse): (Record<string, unknown> & { id: string }) | undefined {
  if (!Array.isArray(session.configOptions)) return undefined
  let byId: (Record<string, unknown> & { id: string }) | undefined
  for (const entry of session.configOptions) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    if (!id) continue
    const candidate = entry as Record<string, unknown> & { id: string }
    if (entry.category === 'thought_level') return candidate
    if ((id === 'thought_level' || id === 'reasoning_effort') && !byId) byId = candidate
  }
  return byId
}

function configSelect(option: (Record<string, unknown> & { id: string }) | undefined): ConfigSelectInfo | undefined {
  if (!option) return undefined
  const values = new Set(flattenConfigOptions(option.options).map(value => value.value))
  if (values.size === 0) return undefined
  const current = asString(option.currentValue)
  return { id: option.id, values, ...(current ? { current } : {}) }
}

function legacyModelInfo(session: AcpSessionResponse): LegacySelectInfo | undefined {
  if (!isRecord(session.models) || !Array.isArray(session.models.availableModels)) return undefined
  const ids = new Set<string>()
  for (const entry of session.models.availableModels) {
    if (!isRecord(entry)) continue
    const id = asString(entry.modelId)
    if (id) ids.add(id)
  }
  if (ids.size === 0) return undefined
  const current = asString(session.models.currentModelId)
  return { ids, ...(current ? { current } : {}) }
}

function legacyModeInfo(session: AcpSessionResponse): LegacySelectInfo | undefined {
  if (!isRecord(session.modes) || !Array.isArray(session.modes.availableModes)) return undefined
  const ids = new Set<string>()
  for (const entry of session.modes.availableModes) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    if (id) ids.add(id)
  }
  if (ids.size === 0) return undefined
  const current = asString(session.modes.currentModeId)
  return { ids, ...(current ? { current } : {}) }
}

function modelsFromSession(session: AcpSessionResponse): CoachSessionModels | undefined {
  if (
    isRecord(session.models) &&
    Array.isArray(session.models.availableModels) &&
    typeof session.models.currentModelId === 'string' &&
    session.models.currentModelId.length > 0
  ) {
    const rows = session.models.availableModels.flatMap(entry => {
      if (!isRecord(entry)) return []
      const modelId = asString(entry.modelId)
      const name = asString(entry.name)
      return modelId && name
        ? [{ modelId, name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }]
        : []
    })
    if (rows.length > 0) return { availableModels: rows, currentModelId: session.models.currentModelId }
  }
  const option = configOption(session, 'model')
  const current = asString(option?.currentValue)
  if (!option || !current) return undefined
  const rows = flattenConfigOptions(option.options).map(value => ({
    modelId: value.value,
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
  }))
  return rows.length > 0 ? { availableModels: rows, currentModelId: current } : undefined
}

function modesFromSession(session: AcpSessionResponse): CoachSessionModes | undefined {
  if (
    isRecord(session.modes) &&
    Array.isArray(session.modes.availableModes) &&
    typeof session.modes.currentModeId === 'string' &&
    session.modes.currentModeId.length > 0
  ) {
    const rows = session.modes.availableModes.flatMap(entry => {
      if (!isRecord(entry)) return []
      const id = asString(entry.id)
      const name = asString(entry.name)
      return id && name
        ? [{ id, name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }]
        : []
    })
    if (rows.length > 0) return { availableModes: rows, currentModeId: session.modes.currentModeId }
  }
  const option = configOption(session, 'mode') ?? thinkingOption(session)
  const current = asString(option?.currentValue)
  if (!option || !current) return undefined
  const rows = flattenConfigOptions(option.options).map(value => ({
    id: value.value,
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
  }))
  return rows.length > 0 ? { availableModes: rows, currentModeId: current } : undefined
}

export function describeCatalog(session: unknown): HarnessCatalog {
  const response: AcpSessionResponse = isRecord(session) ? session : {}
  const modelOption = configOption(response, 'model')
  const modeOption = configOption(response, 'mode')
  const thinking = thinkingOption(response)
  const modelSelect = configSelect(modelOption)
  const modeSelect = configSelect(modeOption) ?? configSelect(thinking)
  const thinkingSelect = configSelect(thinking)
  const models = modelsFromSession(response)
  const modes = modesFromSession(response)
  const legacyModels = legacyModelInfo(response)
  const legacyModes = legacyModeInfo(response)
  return {
    ...(models ? { models } : {}),
    ...(modes ? { modes } : {}),
    selects: {
      ...(modelSelect ? { model: modelSelect } : {}),
      ...(modeSelect ? { mode: modeSelect } : {}),
      ...(thinkingSelect ? { thinking: thinkingSelect } : {}),
    },
    legacy: {
      ...(legacyModels ? { models: legacyModels } : {}),
      ...(legacyModes ? { modes: legacyModes } : {}),
    },
  }
}

function splitBracketedModelId(modelId: string): { base: string; suffix: string } | undefined {
  const match = /^(.*)\[([^\]]+)\]$/.exec(modelId)
  return match?.[1] ? { base: match[1], suffix: match[2] ?? '' } : undefined
}

export interface ConfigSelectionWrite {
  via: 'config'
  configId: string
  value: string
}

export interface LegacySelectionWrite {
  via: 'legacy'
  value: string
}

export type SelectionWrite = ConfigSelectionWrite | LegacySelectionWrite

export interface SelectionAttempt {
  writes: SelectionWrite[]
  appliedId: string
  missingSetter: 'success' | 'continue' | 'fail'
}

export interface SelectionPlan {
  kind: 'model' | 'mode'
  attempts: SelectionAttempt[]
  unavailableMessage: string
}

export interface SelectionProvider {
  setConfigOption?: (args: { sessionId: string; configId: string; value: string }) => Promise<unknown>
  setModel?: (modelId: string) => Promise<unknown>
  setMode?: (modeId: string) => Promise<unknown>
}

function configWrite(select: ConfigSelectInfo, value: string): ConfigSelectionWrite {
  return { via: 'config', configId: select.id, value }
}

function legacyWrite(value: string): LegacySelectionWrite {
  return { via: 'legacy', value }
}

function attempt(
  writes: SelectionWrite[],
  appliedId: string,
  missingSetter: SelectionAttempt['missingSetter'],
): SelectionAttempt {
  return { writes, appliedId, missingSetter }
}

function alternateChannel(order: RoutingChannel[], channel: RoutingChannel): RoutingChannel | undefined {
  return order.find(candidate => candidate !== channel)
}

function hasModel(catalog: HarnessCatalog, channel: RoutingChannel, modelId: string): boolean {
  return channel === 'config'
    ? (catalog.selects.model?.values.has(modelId) ?? false)
    : (catalog.legacy.models?.ids.has(modelId) ?? false)
}

function hasMode(catalog: HarnessCatalog, channel: RoutingChannel, modeId: string): boolean {
  return channel === 'config'
    ? (catalog.selects.mode?.values.has(modeId) ?? false)
    : (catalog.legacy.modes?.ids.has(modeId) ?? false)
}

function modelAttempt(
  catalog: HarnessCatalog,
  channel: RoutingChannel,
  modelId: string,
  missingSetter: SelectionAttempt['missingSetter'],
): SelectionAttempt {
  return channel === 'config' && catalog.selects.model
    ? attempt([configWrite(catalog.selects.model, modelId)], modelId, missingSetter)
    : attempt([legacyWrite(modelId)], modelId, missingSetter)
}

function modeAttempt(
  catalog: HarnessCatalog,
  channel: RoutingChannel,
  modeId: string,
  missingSetter: SelectionAttempt['missingSetter'],
): SelectionAttempt {
  return channel === 'config' && catalog.selects.mode
    ? attempt([configWrite(catalog.selects.mode, modeId)], modeId, missingSetter)
    : attempt([legacyWrite(modeId)], modeId, missingSetter)
}

export function planModelSelection(policy: RoutingPolicy, catalog: HarnessCatalog, modelId: string): SelectionPlan {
  const unavailableMessage = `Model "${modelId}" is not available`
  const config = catalog.selects.model
  const legacy = catalog.legacy.models
  const split = policy.bracketedModelIds === 'decompose' ? splitBracketedModelId(modelId) : undefined

  if (split && config && !config.values.has(modelId) && config.values.has(split.base)) {
    const writes: SelectionWrite[] = []
    if (config.current !== split.base) writes.push(configWrite(config, split.base))
    const thinking = catalog.selects.thinking
    if (thinking && thinking.values.has(split.suffix) && thinking.current !== split.suffix)
      writes.push(configWrite(thinking, split.suffix))
    return { kind: 'model', attempts: [attempt(writes, split.base, 'success')], unavailableMessage }
  }

  let effectiveId = modelId
  if (
    split &&
    !hasModel(catalog, 'config', modelId) &&
    !hasModel(catalog, 'legacy', modelId) &&
    (hasModel(catalog, 'config', split.base) || hasModel(catalog, 'legacy', split.base))
  ) {
    effectiveId = split.base
  }

  const primary = policy.modelOrder.find(channel => hasModel(catalog, channel, effectiveId))
  if (primary) {
    const select = primary === 'config' ? config : legacy
    const current = select?.current
    const attempts = [
      current === effectiveId
        ? attempt([], effectiveId, 'success')
        : modelAttempt(catalog, primary, effectiveId, 'success'),
    ]
    const alternate = alternateChannel(policy.modelOrder, primary)
    if (alternate && hasModel(catalog, alternate, effectiveId) && current !== effectiveId) {
      attempts.push(modelAttempt(catalog, alternate, effectiveId, 'fail'))
    }
    return { kind: 'model', attempts, unavailableMessage }
  }

  const minimal = !config && !legacy
  if (minimal) {
    const base = split?.base
    const attempts: SelectionAttempt[] = policy.minimalModelOrder.map(channel =>
      channel === 'config'
        ? attempt([{ via: 'config', configId: 'model', value: modelId }], modelId, 'continue')
        : attempt([legacyWrite(modelId)], modelId, base ? 'continue' : 'success'),
    )
    if (base) {
      for (const channel of policy.minimalModelOrder) {
        attempts.push(
          channel === 'config'
            ? attempt([{ via: 'config', configId: 'model', value: base }], base, 'continue')
            : attempt([legacyWrite(base)], base, 'success'),
        )
      }
    }
    return { kind: 'model', attempts, unavailableMessage }
  }

  const attempts = [attempt([legacyWrite(effectiveId)], effectiveId, 'fail')]
  if (split && split.base !== effectiveId) attempts.push(attempt([legacyWrite(split.base)], split.base, 'fail'))
  return { kind: 'model', attempts, unavailableMessage }
}

export function planModeSelection(policy: RoutingPolicy, catalog: HarnessCatalog, modeId: string): SelectionPlan {
  const unavailableMessage = `Mode "${modeId}" is not available`
  const config = catalog.selects.mode
  const legacy = catalog.legacy.modes
  const primary = policy.modeOrder.find(channel => hasMode(catalog, channel, modeId))
  if (primary) {
    const select = primary === 'config' ? config : legacy
    const attempts = [
      select?.current === modeId ? attempt([], modeId, 'success') : modeAttempt(catalog, primary, modeId, 'success'),
    ]
    const alternate = alternateChannel(policy.modeOrder, primary)
    if (alternate && hasMode(catalog, alternate, modeId) && select?.current !== modeId) {
      attempts.push(modeAttempt(catalog, alternate, modeId, 'fail'))
    }
    return { kind: 'mode', attempts, unavailableMessage }
  }

  if (!config && !legacy) {
    const attempts = policy.minimalModeConfigIds.map(configId =>
      attempt([{ via: 'config', configId, value: modeId }], modeId, 'continue'),
    )
    attempts.push(attempt([legacyWrite(modeId)], modeId, 'success'))
    return { kind: 'mode', attempts, unavailableMessage }
  }

  return { kind: 'mode', attempts: [attempt([legacyWrite(modeId)], modeId, 'fail')], unavailableMessage }
}

/** Runs attempts in order; the first whose writes all succeed wins. When all
 *  fail, the LAST agent error surfaces (the fallback's own rejection). */
export async function executeSelectionPlan(
  provider: SelectionProvider,
  sessionId: string,
  plan: SelectionPlan,
): Promise<string | undefined> {
  let lastError: unknown
  for (const candidate of plan.attempts) {
    let failed = false
    for (const write of candidate.writes) {
      try {
        if (write.via === 'config') {
          if (!provider.setConfigOption) {
            if (candidate.missingSetter !== 'success') failed = true
            break
          }
          await provider.setConfigOption({ sessionId, configId: write.configId, value: write.value })
        } else {
          const setter = plan.kind === 'model' ? provider.setModel : provider.setMode
          if (!setter) {
            if (candidate.missingSetter !== 'success') failed = true
            break
          }
          await setter(write.value)
        }
      } catch (error) {
        lastError = error
        failed = true
        break
      }
    }
    if (!failed) return candidate.appliedId
  }
  if (lastError) throw lastError
  throw new SelectionUnavailableError({ message: plan.unavailableMessage })
}
