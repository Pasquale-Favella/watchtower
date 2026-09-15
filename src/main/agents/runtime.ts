import { existsSync, statSync } from 'node:fs'
import type { ACPProvider, ACPProviderSettings } from '@mcpc-tech/acp-ai-provider'
import type { CoachEvent, CoachSessionModels, CoachSessionModes } from '../../shared/schemas/agents.js'
import type { HarnessInfo } from './detect.js'
import type { AcpMcpServer } from './harnesses/types.js'
import { deriveCoachEvents, type CoachStreamPart } from './events.js'
import { harnessSpecs } from './harnesses/index.js'

/**
 * The HarnessRuntime seam (ticket 18/20): the single main-process module that
 * owns the AI SDK + ACP provider — spawning ACP agents (Claude Code, Codex,
 * OpenCode, Gemini, …) as child processes and streaming their output — and
 * derives the typed CoachEvent stream the renderer consumes. The renderer
 * never touches the SDK. The SDK surface is injected (ADR 0006 isolation), so
 * the seam is testable with a fake SDK; `loadHarnessSdk()` wires the real
 * packages lazily.
 *
 * SDK stack (ADR 0016, revised): the AI SDK (`ai` v6) drives agents over the
 * Agent Client Protocol via `@mcpc-tech/acp-ai-provider`. Each harness spec's
 * `adapter.acpConfig` is the STATIC slice of the real `ACPProviderSettings`;
 * the seam adds the per-run `session.cwd` (the real workspace), the scrubbed
 * env (ADR 0012 — the agent falls back to its own stored login), and the
 * resume handle (`existingSessionId`). There is no sandbox middleware: ACP
 * agents run locally against the workspace.
 *
 * One harness = ONE agent = ONE language model (map 47 tickets 49/51): the
 * seam types against the REAL `ACPProviderSettings`/`ACPProvider` exports —
 * no hand-rolled narrow slices, no `as unknown as` at the provider boundary.
 * Model/mode selection is PROGRESSIVE (ticket 50): `initSession()` may report
 * `models`/`modes` (experimental ACP handshake fields); the seam rides them
 * on the `session` CoachEvent, and passes the renderer's choices (only ever
 * picked from that reported set) to `languageModel(modelId, modeId)`.
 *
 * Packaging constraint (ticket 15): the workspace source must be a REAL
 * on-disk path, never a virtual asar path (child processes cannot read asar).
 * `run` validates this before the SDK is touched.
 */

/** The `createACPProvider` settings — the REAL type, not a local slice. */
export type AcpProviderConfig = ACPProviderSettings

/** The provider surface the seam uses — a structural Pick of the real class,
 *  plus the optional session-config setter the seam adds in loadHarnessSdk
 *  (the real ACPProvider has setModel/setMode for the legacy handshake
 *  fields; configOptions-based agents like claude-agent-acp and opencode need
 *  `session/set_config_option` instead — see applyModelSelection /
 *  applyModeSelection). setModel/setMode are optional so fakes may omit them;
 *  the real provider always exposes them. */
export type AcpProvider = Pick<ACPProvider, 'languageModel' | 'tools' | 'initSession' | 'cleanup'> & {
  setConfigOption?: (args: { sessionId: string; configId: string; value: string }) => Promise<unknown>
  setModel?: (modelId: string) => Promise<unknown>
  setMode?: (modeId: string) => Promise<unknown>
}

/** The SDK surface the seam depends on — a narrow slice of `ai` +
 *  `@mcpc-tech/acp-ai-provider`. Injected so tests use a fake. */
export interface HarnessSdk {
  createACPProvider(config: AcpProviderConfig): AcpProvider
  streamText(options: {
    model: unknown
    prompt: string
    tools?: unknown
  }): AsyncIterable<CoachStreamPart>
}

/** The slice of a run input needed to SPAWN a provider — shared by `run` and
 *  the `inspect` probe (map 47 ticket 50) so both build the agent exactly the
 *  same way. */
export interface HarnessProviderInput {
  harness: HarnessInfo
  /** The user's project repo — must be a real on-disk directory. */
  workspacePath: string
  /** Resume handle from a previous run's session event. */
  sessionId?: string
  /** Opt-in API-key passthrough: when true the harness's API-key env vars
   *  (e.g. ANTHROPIC_API_KEY) are NOT scrubbed before spawn, so the agent
   *  authenticates the same way the user's terminal does. Default
   *  (absent/false) keeps the ADR 0012 stored-login behaviour. The key itself
   *  is never passed explicitly — it is simply left in the inherited env. */
  allowApiKeyEnv?: boolean
  /** Extra MCP servers to attach to the agent session (the injected in-app
   *  ledger server — map 53). Merged AFTER the spec's own servers. */
  mcpServers?: AcpMcpServer[]
}

export interface HarnessRunInput extends HarnessProviderInput {
  /** Agent-declared model id (from a previous session event's models).
   *  Optional — the agent runs with its own configured model when absent. */
  modelId?: string
  /** Agent-declared session mode id (from a previous session event's modes). */
  modeId?: string
  prompt: string
  /** The offered `sessionId` resume is EXPENDABLE — if loading it fails, the
   *  seam silently restarts the provider without the resume handle instead of
   *  erroring the turn. Set by the runner ONLY for a probe-warmed session
   *  (nothing was ever sent to it, so nothing is lost by restarting fresh);
   *  genuine conversation resumes stay strict — silently restarting would
   *  drop the conversation context the user expects to continue. */
  resumeIsExpendable?: boolean
}

/** The handshake probe result — from a pre-flight `initSession` with no
 *  prompt streamed. `sessionId` is the warmed session (the runner resumes it
 *  on the conversation's first run so the agent does not cold-start twice);
 *  absent `models`/`modes` mean the agent declared no such set (progressive:
 *  the pickers render only when present). */
export interface HarnessInspectResult {
  sessionId?: string
  models?: CoachSessionModels
  modes?: CoachSessionModes
}

export interface HarnessRuntime {
  run(input: HarnessRunInput): AsyncGenerator<CoachEvent>
  /** Probes a harness's handshake-declared models/modes WITHOUT running a
   *  prompt (map 47 ticket 50): spawns the ACP provider, initSessions, reads
   *  the session response, and tears the provider down. Throws on failure
   *  (unavailable agent, auth wall) — the runner converts that to the
   *  `{ ok: false }` inspect arm, so a failed probe just leaves the pickers
   *  absent instead of blocking the chat. */
  inspect(input: HarnessProviderInput): Promise<HarnessInspectResult>
}

/** A workspace is drivable only when it is a real directory on disk — a
 *  non-existent path or a virtual asar path is refused before any spawn. */
export function assertRealWorkspacePath(workspacePath: string): void {
  if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
    throw new Error(`workspace must be a real on-disk directory: ${workspacePath}`)
  }
  const segments = workspacePath.split(/[/\\]/)
  if (segments.some(segment => segment.endsWith('.asar'))) {
    throw new Error(`workspace must be a real on-disk path, never an asar path: ${workspacePath}`)
  }
}

/** A single flat value of a session `configOptions` select (ACP spec
 *  `SessionConfigSelectOption`). `options` may also arrive grouped
 *  (`SessionConfigSelectGroup` with nested `options`) — flattenConfigOptions
 *  handles both. */
interface ConfigSelectValue {
  value: string
  name: string
  description?: string | null
}

/** The structural slice of an ACP `NewSessionResponse` the seam reads —
 *  legacy `models`/`modes` plus the canonical `configOptions` both agents
 *  under test actually use (opencode: model+mode only via configOptions;
 *  claude-agent-acp: modes legacy + model/mode/effort via configOptions).
 *  `initSession()` is typed loosely upstream, so every field is optional and
 *  validated defensively below — a malformed agent response must never throw. */
interface AcpSessionResponse {
  sessionId?: unknown
  models?: unknown
  modes?: unknown
  configOptions?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Flattens a `SessionConfigSelectOptions` payload (flat values or grouped
 *  values) into plain { value, name, description } rows. Non-conforming
 *  entries are skipped — one bad option must not drop the whole list. */
function flattenConfigOptions(options: unknown): ConfigSelectValue[] {
  if (!Array.isArray(options)) return []
  const out: ConfigSelectValue[] = []
  for (const entry of options) {
    if (!isRecord(entry)) continue
    // Grouped form: { group, name, options: [...] } — flatten with a
    // "Group / Option" label so grouped values stay distinguishable.
    if (Array.isArray(entry.options)) {
      const groupName = asString(entry.name) ?? asString(entry.group) ?? ''
      for (const nested of entry.options as unknown[]) {
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

/** Finds the select option for a semantic category (`model` | `mode`).
 *  Category is UX-only per the ACP spec and may be missing — fall back to the
 *  conventional `id` so agents that omit it still resolve. */
function findConfigOption(session: AcpSessionResponse, category: 'model' | 'mode'): (Record<string, unknown> & { id: string }) | undefined {
  if (!Array.isArray(session.configOptions)) return undefined
  let byId: (Record<string, unknown> & { id: string }) | undefined
  for (const entry of session.configOptions as unknown[]) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    if (!id) continue
    const candidate = entry as Record<string, unknown> & { id: string }
    if (entry.category === category) return candidate
    if (id === category && !byId) byId = candidate
  }
  return byId
}

/** Finds the thinking-level select (`thought_level` category — pi's
 *  `thought_level`, codex's `reasoning_effort`): the mode-equivalent for
 *  agents without a `mode` select. Category match wins; id match is the
 *  fallback for agents that omit it. */
function findThoughtLevelOption(session: AcpSessionResponse): (Record<string, unknown> & { id: string }) | undefined {
  if (!Array.isArray(session.configOptions)) return undefined
  let byId: (Record<string, unknown> & { id: string }) | undefined
  for (const entry of session.configOptions as unknown[]) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    if (!id) continue
    const candidate = entry as Record<string, unknown> & { id: string }
    if (entry.category === 'thought_level') return candidate
    if ((id === 'thought_level' || id === 'reasoning_effort') && !byId) byId = candidate
  }
  return byId
}

/** A resolved config select: its id plus the valid values and current. */
interface ConfigSelectInfo {
  id: string
  values: Set<string>
  current?: string
}

function configSelectInfo(option: (Record<string, unknown> & { id: string }) | undefined): ConfigSelectInfo | undefined {
  if (!option) return undefined
  const values = new Set(flattenConfigOptions(option.options).map(o => o.value))
  if (values.size === 0) return undefined
  const current = typeof option.currentValue === 'string' && option.currentValue.length > 0
    ? (option.currentValue as string)
    : undefined
  return { id: option.id, values, ...(current ? { current } : {}) }
}

/** The model select for a session (the `model` category only — never the
 *  thinking level). */
function configModelSelect(session: AcpSessionResponse | undefined): ConfigSelectInfo | undefined {
  if (!session) return undefined
  return configSelectInfo(findConfigOption(session, 'model'))
}

/** The mode select for a session: the `mode` select first, else the
 *  thinking-level select (pi exposes thinking levels only there). */
function configModeSelect(session: AcpSessionResponse | undefined): ConfigSelectInfo | undefined {
  if (!session) return undefined
  return configSelectInfo(findConfigOption(session, 'mode')) ?? configSelectInfo(findThoughtLevelOption(session))
}

/** The thinking-level select for a session (pi's `thought_level`, codex's
 *  `reasoning_effort`) — the write target for a bracketed model id's effort
 *  suffix. Distinct from configModeSelect, which prefers the `mode` select. */
function configThinkingSelect(session: AcpSessionResponse | undefined): ConfigSelectInfo | undefined {
  if (!session) return undefined
  return configSelectInfo(findThoughtLevelOption(session))
}

/** Usable legacy model ids + current, or undefined when the handshake
 *  declares no usable legacy set. */
function legacyModelInfo(session: AcpSessionResponse | undefined): { ids: Set<string>; current?: string } | undefined {
  if (!session || !isRecord(session.models)) return undefined
  const available = (session.models as { availableModels?: unknown }).availableModels
  const current = (session.models as { currentModelId?: unknown }).currentModelId
  if (!Array.isArray(available)) return undefined
  const ids = new Set<string>()
  for (const entry of available) {
    if (!isRecord(entry)) continue
    const modelId = asString(entry.modelId)
    if (modelId) ids.add(modelId)
  }
  if (ids.size === 0) return undefined
  const currentId = typeof current === 'string' && current.length > 0 ? current : undefined
  return { ids, ...(currentId ? { current: currentId } : {}) }
}

/** Usable legacy mode ids + current, or undefined when absent. */
function legacyModeInfo(session: AcpSessionResponse | undefined): { ids: Set<string>; current?: string } | undefined {
  if (!session || !isRecord(session.modes)) return undefined
  const available = (session.modes as { availableModes?: unknown }).availableModes
  const current = (session.modes as { currentModeId?: unknown }).currentModeId
  if (!Array.isArray(available)) return undefined
  const ids = new Set<string>()
  for (const entry of available) {
    if (!isRecord(entry)) continue
    const id = asString(entry.id)
    if (id) ids.add(id)
  }
  if (ids.size === 0) return undefined
  const currentId = typeof current === 'string' && current.length > 0 ? current : undefined
  return { ids, ...(currentId ? { current: currentId } : {}) }
}

/** Derives CoachSessionModels from a handshake response: legacy `models`
 *  first, else the `configOptions` model select. Returns undefined when the
 *  agent declared nothing usable (progressive: pickers stay absent). */
function modelsFromSession(session: AcpSessionResponse): CoachSessionModels | undefined {
  if (isRecord(session.models)) {
    const available = (session.models as { availableModels?: unknown }).availableModels
    const current = (session.models as { currentModelId?: unknown }).currentModelId
    if (Array.isArray(available) && typeof current === 'string' && current.length > 0) {
      const rows = available.filter(isRecord).flatMap(entry => {
        const modelId = asString(entry.modelId)
        const name = asString(entry.name)
        return modelId && name
          ? [{ modelId, name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }]
          : []
      })
      if (rows.length > 0) return { availableModels: rows, currentModelId: current }
    }
  }
  const option = findConfigOption(session, 'model')
  if (!option || typeof option.currentValue !== 'string' || option.currentValue.length === 0) return undefined
  const rows = flattenConfigOptions(option.options).map(o => ({
    modelId: o.value,
    name: o.name,
    ...(o.description ? { description: o.description } : {}),
  }))
  if (rows.length === 0) return undefined
  return { availableModels: rows, currentModelId: option.currentValue as string }
}

/** Derives CoachSessionModes the same way (legacy `modes`, else the
 *  `configOptions` mode select — opencode only advertises the latter — else
 *  the thinking-level select, which is pi's mode-equivalent). */
function modesFromSession(session: AcpSessionResponse): CoachSessionModes | undefined {
  if (isRecord(session.modes)) {
    const available = (session.modes as { availableModes?: unknown }).availableModes
    const current = (session.modes as { currentModeId?: unknown }).currentModeId
    if (Array.isArray(available) && typeof current === 'string' && current.length > 0) {
      const rows = available.filter(isRecord).flatMap(entry => {
        const id = asString(entry.id)
        const name = asString(entry.name)
        return id && name
          ? [{ id, name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }]
          : []
      })
      if (rows.length > 0) return { availableModes: rows, currentModeId: current }
    }
  }
  const option = findConfigOption(session, 'mode') ?? findThoughtLevelOption(session)
  if (!option || typeof option.currentValue !== 'string' || option.currentValue.length === 0) return undefined
  const rows = flattenConfigOptions(option.options).map(o => ({
    id: o.value,
    name: o.name,
    ...(o.description ? { description: o.description } : {}),
  }))
  if (rows.length === 0) return undefined
  return { availableModes: rows, currentModeId: option.currentValue as string }
}

/** Splits a legacy codex-style bracketed model id (`gpt-5.6-luna[low]`) into
 *  base + suffix. Codex changed its advertised catalog between versions
 *  (bracketed legacy ids vs base names); a pick cached from the old catalog
 *  must still resolve against the new one. Null when no bracket suffix. */
function splitBracketedModelId(modelId: string): { base: string; suffix: string } | null {
  const match = /^(.*)\[([^\]]+)\]$/.exec(modelId)
  if (!match || !match[1]) return null
  return { base: match[1], suffix: match[2] ?? '' }
}

/** Applies a user's MODEL pick to a live session, routing by where the picked
 *  value is actually valid (verified live against codex + pi):
 *  - codex advertises bracketed legacy ids (`gpt-5.6-luna[high]`) AND base
 *    config values (`gpt-5.6-luna`): only the legacy `unstable_setSessionModel`
 *    accepts the bracketed ids the picker shows — a config write with one
 *    fails with Invalid params.
 *  - pi mirrors its model list in both shapes but only implements the config
 *    write — the legacy call fails with "Method not found".
 *  - opencode/claude-agent-acp advertise models only via configOptions.
 *  Routing: a value present in the config select goes via `setConfigOption`
 *  (config-first, since pi/opencode/claude require it); otherwise a value
 *  present in the legacy set goes via legacy `setModel`. Each path skips when
 *  the pick already equals that path's current (idempotent re-run). A routed
 *  failure falls back to the other path when the value is valid there (covers
 *  agents where both shapes overlap but only one mechanism works); a resumed
 *  session (minimal `{ sessionId }` handshake) tries the conventional config
 *  id first, then legacy. Throws with the agent's message when nothing
 *  applies, so the run surfaces an error event instead of silently running
 *  with the wrong model. Fakes exposing neither setter are skipped
 *  harmlessly (their languageModel assertion still runs).
 *
 *  Backward compat: a bracketed pick cached from an older codex catalog
 *  (`gpt-5.6-luna[low]`) resolves to its base (`gpt-5.6-luna`) when the exact
 *  id is unknown but the base is advertised — the suffix encoded a thinking
 *  level from the old catalog shape, and failing the whole run on a stale
 *  restored pick is worse than running the base model.
 *
 *  Bracketed codex picks with a model config present are DECOMPOSED, never
 *  routed as-is: provider.setModel validates any id against the base-name
 *  config values and throws before reaching the legacy RPC, so `base[effort]`
 *  is applied as setConfigOption(model, base) + setConfigOption(thinking,
 *  effort). An unknown effort suffix (or no thinking select) degrades to the
 *  base model rather than failing the run.
 *
 *  Returns the id `languageModel` must be constructed with: the applied
 *  (possibly base-normalized) id, so the provider never validates a stale raw
 *  id after a successful apply. Anthropic/Claude ids never carry a bracket
 *  suffix, so that path always returns the pick untouched. */
async function applyModelSelection(
  provider: AcpProvider,
  session: AcpSessionResponse | undefined,
  sessionId: string,
  modelId: string,
): Promise<string> {
  const config = configModelSelect(session)
  const legacy = legacyModelInfo(session)
  const split = splitBracketedModelId(modelId)
  // Normalize a stale bracketed pick to its advertised base before routing.
  let effectiveId = modelId
  if (
    split &&
    !(config?.values.has(modelId) ?? false) &&
    !(legacy?.ids.has(modelId) ?? false) &&
    ((config?.values.has(split.base) ?? false) || (legacy?.ids.has(split.base) ?? false))
  ) {
    effectiveId = split.base
  }
  const inConfig = config?.values.has(effectiveId) ?? false
  const inLegacy = legacy?.ids.has(effectiveId) ?? false
  const minimal = !config && !legacy

  // Bracketed codex pick with a model config present (`gpt-5.6-luna[low]`
  // against base-name config values): routing the bracketed id anywhere
  // fails — provider.setModel validates it against the config values and
  // throws before any legacy RPC. Decompose into base model + thinking-level
  // effort, each written only when it differs from current (idempotent).
  if (split && config && !config.values.has(modelId) && config.values.has(split.base)) {
    const thinking = configThinkingSelect(session)
    if (config.current !== split.base) {
      if (!provider.setConfigOption) return split.base
      await provider.setConfigOption({ sessionId, configId: config.id, value: split.base })
    }
    if (thinking && thinking.values.has(split.suffix) && thinking.current !== split.suffix) {
      if (!provider.setConfigOption) return split.base
      await provider.setConfigOption({ sessionId, configId: thinking.id, value: split.suffix })
    }
    return split.base
  }

  if (inConfig && config) {
    if (config.current === effectiveId) return effectiveId
    if (!provider.setConfigOption) return effectiveId
    try {
      await provider.setConfigOption({ sessionId, configId: config.id, value: effectiveId })
      return effectiveId
    } catch (err) {
      if (inLegacy && provider.setModel) {
        await provider.setModel(effectiveId)
        return effectiveId
      }
      throw err
    }
  }
  if (inLegacy) {
    if (legacy?.current === effectiveId) return effectiveId
    if (!provider.setModel) return effectiveId
    try {
      await provider.setModel(effectiveId)
      return effectiveId
    } catch (err) {
      if (inConfig && config && provider.setConfigOption) {
        await provider.setConfigOption({ sessionId, configId: config.id, value: effectiveId })
        return effectiveId
      }
      throw err
    }
  }
  if (minimal) {
    // Resumed sessions carry no catalog. Try the exact pick in PR #69 order
    // first (config, then legacy — a bracketed codex id must reach legacy
    // setModel, never the config path with its base, or the effort suffix is
    // silently lost); only a stale bracketed pick that fails everywhere falls
    // back to its base.
    const base = split && split.base !== modelId ? split.base : null
    if (provider.setConfigOption) {
      try {
        // Minimal handshake (resumed `{ sessionId }`): the id must be
        // guessed — all live config-based agents use the conventional ids.
        await provider.setConfigOption({ sessionId, configId: 'model', value: modelId })
        return modelId
      } catch {
        // Fall through to legacy below (resumed codex: bracketed ids are
        // legacy-only, so the conventional config write must fail there).
      }
    }
    if (provider.setModel) {
      try {
        await provider.setModel(modelId)
        return modelId
      } catch (err) {
        if (!base) throw err
        // Stale bracketed pick against a base-only catalog — retry its base.
      }
    } else if (!base) {
      return modelId
    }
    if (base) {
      if (provider.setConfigOption) {
        try {
          await provider.setConfigOption({ sessionId, configId: 'model', value: base })
          return base
        } catch (err) {
          if (!provider.setModel) throw err
        }
      }
      if (provider.setModel) {
        await provider.setModel(base)
        return base
      }
      return modelId
    }
    return modelId
  }
  if (provider.setModel) {
    try {
      await provider.setModel(effectiveId)
      return effectiveId
    } catch (err) {
      // Last resort already tried the normalized form — retry the alternate
      // bracket form once before surfacing the agent's error.
      const alternate = split && split.base !== effectiveId ? split.base : null
      if (alternate) {
        await provider.setModel(alternate)
        return alternate
      }
      throw err
    }
  }
  throw new Error(`Model "${modelId}" is not available`)
}

/** Applies a user's MODE pick the same way, with the opposite preference
 *  (verified live): pi/codex/claude all accept the legacy `setSessionMode`
 *  for the thinking/mode ids the picker shows, while pi has NO `mode` config
 *  select at all (only `thought_level`) — guessing configId `mode` fails with
 *  "Unknown config option: mode". Routing: a value present in the legacy set
 *  goes via legacy `setMode`; otherwise a value present in the mode (or
 *  thinking-level) config select goes via `setConfigOption`. Resumed sessions
 *  try the conventional `mode` config id, then `thought_level`, then legacy. */
async function applyModeSelection(
  provider: AcpProvider,
  session: AcpSessionResponse | undefined,
  sessionId: string,
  modeId: string,
): Promise<void> {
  const config = configModeSelect(session)
  const legacy = legacyModeInfo(session)
  const inConfig = config?.values.has(modeId) ?? false
  const inLegacy = legacy?.ids.has(modeId) ?? false
  const minimal = !config && !legacy

  if (inLegacy) {
    if (legacy?.current === modeId) return
    if (!provider.setMode) return
    try {
      await provider.setMode(modeId)
      return
    } catch (err) {
      if (inConfig && config && provider.setConfigOption) {
        await provider.setConfigOption({ sessionId, configId: config.id, value: modeId })
        return
      }
      throw err
    }
  }
  if (inConfig && config) {
    if (config.current === modeId) return
    if (!provider.setConfigOption) return
    try {
      await provider.setConfigOption({ sessionId, configId: config.id, value: modeId })
      return
    } catch (err) {
      if (inLegacy && provider.setMode) {
        await provider.setMode(modeId)
        return
      }
      throw err
    }
  }
  if (minimal) {
    if (provider.setConfigOption) {
      // Minimal handshake (resumed `{ sessionId }`): guess the conventional
      // ids — `mode` first, then `thought_level` (pi's thinking select) —
      // before falling back to legacy below.
      for (const configId of ['mode', 'thought_level']) {
        try {
          await provider.setConfigOption({ sessionId, configId, value: modeId })
          return
        } catch {
          // Try the next config id, then legacy below.
        }
      }
    }
    if (provider.setMode) {
      await provider.setMode(modeId)
      return
    }
    return
  }
  if (provider.setMode) {
    await provider.setMode(modeId)
    return
  }
  throw new Error(`Mode "${modeId}" is not available`)
}

/** Runs one initSession on a provider and derives the session CoachEvent
 *  payload it implies (the resume handle + any handshake-declared
 *  models/modes). Shared by the main warm-up and the expendable-resume
 *  fallback so both emit the session event identically. */
async function warmSession(provider: AcpProvider): Promise<{ sessionId?: string; event?: CoachEvent; session?: AcpSessionResponse }> {
  const session = (await provider.initSession()) as unknown as AcpSessionResponse
  const sessionId = asString(session.sessionId)
  if (!sessionId) return { session }
  const event: CoachEvent = { kind: 'session', sessionId }
  const models = modelsFromSession(session)
  const modes = modesFromSession(session)
  if (models) event.models = models
  if (modes) event.modes = modes
  return { sessionId, event, session }
}

/** The env handed to the agent process: the host env MINUS the spec's
 *  scrubEnv keys (ADR 0012) — API keys are never passed, so the CLI uses its
 *  own stored login. The ACP provider's `env` is explicit, so an omitted key
 *  is genuinely absent rather than inherited. The `allowApiKeyEnv` opt-in
 *  (Coach "use API keys from environment") skips scrubbing entirely: the
 *  agent then authenticates exactly like the user's terminal does. */
function scrubbedEnv(scrubEnv: readonly string[], allowApiKeyEnv = false): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!allowApiKeyEnv && scrubEnv.includes(key)) continue
    env[key] = value
  }
  return env
}

/** Signatures of a harness-side AUTHENTICATION failure (stored login expired
 *  or missing, e.g. Claude's "OAuth session expired and could not be
 *  refreshed"). Matched case-insensitively against raw agent/provider error
 *  text. Deliberately narrow: a plain "session expired" (an ACP resume-handle
 *  expiry, which has its own retry path) must NOT match. */
const AUTH_FAILURE_PATTERNS = [
  /failed to authenticate/i,
  /oauth session expired/i,
  /authentication_failed/i,
  /authrequired/i,
  /please run \/login/i,
  /not logged in/i,
]

/** True when a raw agent/provider error message reports an authentication
 *  wall rather than any other failure. Pure — unit-tested directly. */
export function isAuthFailureMessage(message: string): boolean {
  return AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(message))
}

/** Actionable remedy for an authentication wall, per harness. The ACP
 *  handshake reports models/modes WITHOUT authenticating, so by the time
 *  this fires the picker already looked healthy — the message must say what
 *  to do, not just what broke. */
function authHintForHarness(kind: string, displayName: string): string {
  if (kind === 'claude') {
    return (
      `${displayName} sign-in required — run 'claude auth login' in a terminal, then retry. ` +
      `If you sign in with ANTHROPIC_API_KEY in your terminal instead, turn on ` +
      `'Use API keys from environment' in Coach and retry.`
    )
  }
  return `${displayName} sign-in required — sign in with the harness's own CLI, then retry.`
}

/** Raw auth-wall detail is truncated for the hint — the full message stays in
 *  logs, the renderer shows just enough to debug. */
const AUTH_DETAIL_MAX_CHARS = 300

/** Maps a raw run failure onto the CoachEvent the renderer shows: auth walls
 *  become the actionable hint (with the raw detail appended for
 *  debuggability); everything else passes through untouched. */
function toHarnessError(harness: HarnessInfo, rawMessage: string): CoachEvent {
  if (!isAuthFailureMessage(rawMessage)) return { kind: 'error', message: rawMessage }
  const detail = rawMessage.length > AUTH_DETAIL_MAX_CHARS ? `${rawMessage.slice(0, AUTH_DETAIL_MAX_CHARS)}…` : rawMessage
  return { kind: 'error', message: `${authHintForHarness(harness.kind, harness.displayName)} (detail: ${detail})` }
}

export interface HarnessRuntimeOptions {
  /** Platform used for spawn-command wrapping (defaults to process.platform).
   *  Injectable so the win32 shim handling is unit-testable on any host. */
  platform?: NodeJS.Platform
}

/** npm-global CLIs on Windows are `.cmd` shims (with a POSIX-script alias)
 *  that Node's shell-less `spawn` cannot execute — spawning the bare name
 *  fails with ENOENT and an unhandled child-process error. Routing the
 *  command through `cmd.exe /c` lets the shim resolve (verified end-to-end
 *  against `opencode acp`); native `.exe` binaries spawn directly. Other
 *  platforms pass through unchanged.
 *
 *  NOTE: `cmd.exe /c` interprets the rest of the line, so args containing
 *  spaces or cmd metacharacters (`& | ^ % <>`) would be mis-parsed. All
 *  current spec args are single tokens — keep future spec args token-only. */
export function acpSpawnCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (platform !== 'win32' || command.toLowerCase().endsWith('.exe')) {
    return { command, args: [...args] }
  }
  return { command: 'cmd.exe', args: ['/c', command, ...args] }
}

export function createHarnessRuntime(sdk: HarnessSdk, options: HarnessRuntimeOptions = {}): HarnessRuntime {
  const platform = options.platform ?? process.platform

  /** Builds the ACP provider for a harness run — the ONE place the seam maps
   *  a HarnessInfo + workspace + resume handle onto `createACPProvider`
   *  (ADR 0016), shared by `run` and the `inspect` probe so both spawn the
   *  agent exactly the same way. Validates the workspace first: a bad path
   *  must fail loudly and cheaply, never as an inscrutable spawn error
   *  (ticket 15 constraint). */
  function createProvider(input: HarnessProviderInput): AcpProvider {
    assertRealWorkspacePath(input.workspacePath)

    const spec = harnessSpecs.find(s => s.kind === input.harness.kind)
    if (!spec || spec.adapter.kind !== 'acp') {
      throw new Error(`harness ${input.harness.kind} has no ACP adapter`)
    }
    const acp = spec.adapter.acpConfig

    // The ACP provider has no `shell` option — it spawns the command
    // verbatim. A BUNDLED ACP server (resolved from the app's own
    // node_modules, no global install) is run through the app's own Node
    // (`process.execPath` + ELECTRON_RUN_AS_NODE, the ledger-mcp pattern) —
    // no cmd.exe shim, no PATH lookup. PATH-resolved harnesses keep the
    // win32 shim handling below.
    const spawn = input.harness.bundledEntry
      ? { command: process.execPath, args: [input.harness.bundledEntry, ...(acp.args ?? [])] }
      : acpSpawnCommand(acp.command, acp.args ?? [], platform)

    const env = scrubbedEnv(input.harness.scrubEnv, input.allowApiKeyEnv)
    // Bundled JS entries run as plain Node inside the app's binary (dev:
    // electron.exe; packaged: the app exe) — the flag is inert under real
    // Node, so tests are unaffected.
    if (input.harness.bundledEntry) env.ELECTRON_RUN_AS_NODE = '1'

    return sdk.createACPProvider({
      command: spawn.command,
      args: spawn.args,
      env,
      session: {
        cwd: input.workspacePath,
        mcpServers: [...(acp.mcpServers ?? []), ...(input.mcpServers ?? [])],
      },
      ...(acp.authMethodId ? { authMethodId: acp.authMethodId } : {}),
      ...(acp.sessionDelayMs ? { sessionDelayMs: acp.sessionDelayMs } : {}),
      ...(input.sessionId ? { existingSessionId: input.sessionId } : {}),
    })
  }

  return {
    async *run(input: HarnessRunInput): AsyncGenerator<CoachEvent> {
      let provider = createProvider(input)

      yield { kind: 'status', state: 'starting' }

      try {
        // Warm the ACP session up front (cuts time-to-first-token) and grab
        // the resume handle. An unavailable agent (binary missing, auth wall)
        // surfaces here as a cheap error event — never an inscrutable spawn
        // crash mid-stream. The handshake may ALSO report selectable
        // models/modes — legacy `models`/`modes` or the canonical
        // `configOptions` selects (opencode and claude-agent-acp advertise
        // models only there) — those ride the session event so the renderer
        // can show a progressive picker (ticket 50).
        let sessionId: string | undefined = input.sessionId
        let warmSessionData: AcpSessionResponse | undefined
        try {
          const warm = await warmSession(provider)
          sessionId = warm.sessionId ?? sessionId
          warmSessionData = warm.session
          if (warm.event) yield warm.event
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // A failed RESUME of an EXPENDABLE session (a probe-warmed session
          // that never received any prompt) falls back to a fresh session
          // instead of failing the turn — nothing is lost, the agent just
          // cold-starts once. Genuine resumed turns stay strict: silently
          // restarting would drop the conversation context the user expects
          // to continue, so their failure remains an error event.
          if (!input.sessionId || !input.resumeIsExpendable) {
            yield toHarnessError(input.harness, message)
            return
          }
          // Tear the failed resume provider down, then rebuild the provider
          // WITHOUT the resume handle and warm a fresh session (the retry
          // config keeps everything else — model/mode picks, the ledger MCP
          // server — so the fresh session behaves like a normal first run).
          // The provider creation sits INSIDE the try: a throw there becomes
          // a graceful error event, never an uncaught generator rejection.
          provider.cleanup()
          try {
            provider = createProvider({ ...input, sessionId: undefined })
            const warm = await warmSession(provider)
            sessionId = warm.sessionId
            warmSessionData = warm.session
            if (warm.event) yield warm.event
          } catch (err2) {
            yield toHarnessError(input.harness, err2 instanceof Error ? err2.message : String(err2))
            return
          }
        }

        // Progressive selection: the renderer's model/mode ids come from the
        // handshake's own selects, but the warmed session already exists, so
        // the AI SDK provider's automatic setModel/setMode (which only runs
        // inside startSession when no session exists yet) never fires for
        // this turn — apply the picks explicitly before streaming. Routing is
        // value-aware (see applyModelSelection/applyModeSelection): codex's
        // bracketed model ids decompose into base model + thinking effort via
        // `set_config_option` (provider.setModel validates against the
        // base-name config values and would throw), pi/opencode/claude models
        // via `set_config_option`, pi thinking modes via legacy `setMode`. A
        // failure is a real error event, never a silent run with the wrong
        // model. The model constructor takes the APPLIED id back from
        // applyModelSelection (a stale bracketed codex pick resolves to its
        // base), so the provider never validates a stale raw id here.
        let languageModelId = input.modelId
        if ((input.modelId || input.modeId) && sessionId) {
          try {
            if (input.modelId) languageModelId = await applyModelSelection(provider, warmSessionData, sessionId, input.modelId)
            if (input.modeId) await applyModeSelection(provider, warmSessionData, sessionId, input.modeId)
          } catch (err) {
            yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
            return
          }
        }

        const stream = sdk.streamText({
          model: provider.languageModel(languageModelId, input.modeId),
          prompt: input.prompt,
          tools: provider.tools,
        })

        // ONE iterator, used for both the loop and cancellation. Holding a
        // single handle means the finally's return() interrupts the SAME
        // in-flight run (a second stream[Symbol.asyncIterator]() would mint a
        // fresh iterator and cancel nothing). The AI SDK's AsyncIterableStream
        // yields a plain AsyncIterator that is NOT itself async-iterable, so
        // the loop must drive it with explicit next() calls — a `for await`
        // over the held iterator throws 'not async iterable' (the fake SDK's
        // async-generator mask hides this; the real stream does not).
        const iterator = stream[Symbol.asyncIterator]()
        try {
          for (;;) {
            const { done, value } = await iterator.next()
            if (done) break
            // Stream-time failures (e.g. the first prompt turn hitting an
            // expired stored login) ride `error` parts — map auth walls to
            // the actionable hint here too, at the point the harness is
            // still known (events.ts stays harness-agnostic).
            for (const event of deriveCoachEvents(value as CoachStreamPart)) {
              yield event.kind === 'error' ? toHarnessError(input.harness, event.message) : event
            }
          }
        } finally {
          if (typeof iterator.return === 'function') {
            await iterator.return()
          }
        }
      } finally {
        // ACP providers spawn a child process per provider; we never persist
        // sessions, so every run tears its agent process down (normal end,
        // error, or consumer-side cancellation).
        provider.cleanup()
      }
    },

    async inspect(input): Promise<HarnessInspectResult> {
      const provider = createProvider(input)
      try {
        // The same handshake a run performs — spawn + initSession — but with
        // no prompt streamed after it: read the declared selectable set and
        // the warmed session id, then tear the process down immediately (the
        // ACP session itself persists, exactly like a finished turn's). The
        // models/modes ride the same session response `run` rides on the
        // `session` CoachEvent (map 47 ticket 50), so what the pickers show
        // pre-chat is exactly what the first run would have declared anyway;
        // the session id lets the runner RESUME this warm session on that
        // first run (no double cold-start). Legacy `models`/`modes` win when
        // present; otherwise the canonical `configOptions` selects are mapped
        // (opencode and claude-agent-acp advertise models only there).
        const session = (await provider.initSession()) as unknown as AcpSessionResponse
        const models = modelsFromSession(session)
        const modes = modesFromSession(session)
        return {
          ...(asString(session.sessionId) ? { sessionId: session.sessionId as string } : {}),
          ...(models ? { models } : {}),
          ...(modes ? { modes } : {}),
        }
      } finally {
        provider.cleanup()
      }
    },
  }
}

/** Wire the REAL AI SDK + ACP provider lazily (ESM packages, dynamic import
 *  so the seam's import surface stays light and the app boots without them).
 *  The seam has zero per-harness adapter-wiring code (ADR 0016): every spec
 *  carries its own ACP descriptor, and `createHarnessRuntime` reads it. The
 *  created provider is augmented with `setConfigOption` (a thin delegate to
 *  the underlying ACP connection's `setSessionConfigOption`) so runs can apply
 *  model/mode picks for configOptions-based agents — the upstream provider
 *  class only exposes the legacy setModel/setMode pair. */
export async function loadHarnessSdk(): Promise<HarnessSdk> {
  const [{ streamText }, { createACPProvider }] = await Promise.all([
    import('ai'),
    import('@mcpc-tech/acp-ai-provider'),
  ])
  return {
    // The real factory's signature IS `(config: ACPProviderSettings) =>
    // ACPProvider` — the seam's `AcpProviderConfig`/`AcpProvider` are that
    // real type (map 47 ticket 51), so no cast is needed at this boundary
    // except for the additive setConfigOption augmentation below.
    createACPProvider: ((config: AcpProviderConfig): AcpProvider => {
      const provider = createACPProvider(config) as unknown as AcpProvider & {
        model?: { connection?: { setSessionConfigOption?: (args: { sessionId: string; configId: string; value: string }) => Promise<unknown> } }
      }
      provider.setConfigOption = async (args: { sessionId: string; configId: string; value: string }) => {
        const connection = provider.model?.connection
        if (!connection?.setSessionConfigOption) {
          throw new Error('agent does not support session config options')
        }
        return connection.setSessionConfigOption(args)
      }
      return provider
    }) as HarnessSdk['createACPProvider'],
    streamText: (options: {
      model: unknown
      prompt: string
      tools?: unknown
    }) => streamText(options as unknown as Parameters<typeof streamText>[0]).fullStream as unknown as AsyncIterable<CoachStreamPart>,
  }
}
