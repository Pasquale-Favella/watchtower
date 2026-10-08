import { Effect, Stream } from 'effect'
import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { createInterface } from 'readline'

import { type AppPaths, appPaths, resolveCodexHome } from '../../env.js'
import { billableOutputTokens } from '../billable-output.js'
import {
  fingerprintFile,
  getCachedCodexProject,
  readCachedCodexResults,
  writeCachedCodexResults,
} from '../codex-cache.js'
import { normalizeContentBlocks } from '../content-utils.js'
import { readSessionLinesStream } from '../fs-utils.js'
import { captureScanPricing } from '../models.js'
import { isScanAbortedError, scanAbortError, throwIfScanAborted } from '../scan-control.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import type { DateRange, ToolCall } from '../types.js'
import type {
  ParsedProviderCall,
  ProbeRoot,
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from './types.js'

const modelDisplayNames: Record<string, string> = {
  'codex-auto-review': 'Codex Auto Review',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5': 'GPT-5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
}

// Longest-first + version-boundary match so an unlisted future minor (gpt-5.6)
// falls through to its raw id instead of collapsing into the base "GPT-5" entry.
const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

const toolNameMap: Record<string, string> = {
  exec_command: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  apply_diff: 'Edit',
  apply_patch: 'Edit',
  spawn_agent: 'Agent',
  close_agent: 'Agent',
  wait_agent: 'Agent',
  read_dir: 'Glob',
}

// CLI-based MCP wrappers (e.g. philschmid/mcp-cli) let Codex call an MCP tool
// through a shell command instead of registering the server natively. Codex
// then logs a plain exec_command with no `mcp_tool_call_end` event, so the MCP
// usage would only appear as a shell command and be absent from the MCP
// breakdown (issue #478). Recognize the `mcp-cli [options] call <server>
// <tool>` form and return the canonical mcp__<server>__<tool> so the call is
// also attributed to MCP. Only the `call` subcommand (an actual tool execution)
// is matched; info / grep / bare listing are lookups. The exec_command still
// counts as Bash since it genuinely is a shell exec. Scoped to the mcp-cli
// binary; other wrappers would need their own pattern.
//
// The negative lookbehind keeps `mcp-cli` a standalone binary (a leading
// quote/space/slash from a `bash -lc "..."` wrapper or absolute path is fine,
// but `foo-mcp-cli` is not). `(?:\s+(?!call\b)[^\s;|&]+)*` skips any options and
// their values between the binary and the subcommand (e.g.
// `mcp-cli -c ./mcp.json call ...`) without crossing a shell separator, and
// stops at the `call` token. This is substring matching, so a command that
// merely mentions the phrase (a comment, an echo, a commit message) can
// false-positive, an accepted tradeoff for the common case. \s+ and the token
// class don't overlap, so there is no catastrophic backtracking.
const MCP_CLI_CALL = /(?<![\w.-])mcp-cli(?:\s+(?!call\b)[^\s;|&]+)*\s+call\s+(\S+)\s+(\S+)/
function mcpToolFromShellCommand(command: unknown): string | null {
  const text =
    typeof command === 'string'
      ? command
      : Array.isArray(command)
        ? command.filter(x => typeof x === 'string').join(' ')
        : ''
  if (!text) return null
  const m = MCP_CLI_CALL.exec(text)
  if (!m) return null
  const serverMatch = m[1]
  const toolMatch = m[2]
  if (!serverMatch || !toolMatch) return null
  const server = serverMatch.replace(/['"]/g, '')
  const tool = toolMatch.replace(/['"]/g, '')
  if (!server || !tool) return null
  return `mcp__${server}__${tool}`
}

// Count added/removed lines from a Codex `patch_apply_end` change's
// `unified_diff`. A leading '+' is an added line and '-' a removed line; the
// '+++'/'---' file headers and '@@' hunk headers are excluded. Numbers only —
// the diff text is never stored. Rich-session-capture (capture-only).
export function countUnifiedDiffLoc(diff: unknown): { added: number; removed: number } {
  let added = 0
  let removed = 0
  if (typeof diff !== 'string') return { added, removed }
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

type CodexEntry = {
  type: string
  timestamp?: string
  payload?: {
    type?: string
    role?: string
    cwd?: string
    model_provider?: string
    originator?: string
    session_id?: string
    forked_from_id?: string
    model?: string
    name?: string
    content?: Array<{ type?: string; text?: string }>
    info?: {
      model?: string
      model_name?: string
      last_token_usage?: CodexTokenUsage
      total_token_usage?: CodexTokenUsage
    }
  }
}

type CodexTokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

const RAW_HEAD_BYTES = 64 * 1024
const LARGE_TEXT_CAP = 2000

function sanitizeProject(cwd: string): string {
  return cwd.replace(/^[/\\]+/, '').replace(/[/\\]/g, '-')
}

// Cap how many bytes we'll read while looking for the first newline. Real
// Codex session_meta lines are ~22-27 KB; this leaves plenty of headroom while
// keeping memory bounded if a corrupt file has no newline at all.
const FIRST_LINE_READ_CAP = 1024 * 1024

async function readFirstLine(filePath: string, signal?: AbortSignal): Promise<CodexEntry | null> {
  throwIfScanAborted(signal)
  // Codex CLI 0.128+ writes a session_meta line that can exceed 20 KB because
  // it embeds the full base_instructions / system prompt. A fixed-size buffer
  // would miss the trailing newline and reject the session as invalid.
  // Stream the file via readline so we can read the first line up to
  // FIRST_LINE_READ_CAP, which keeps memory bounded if the file has no newline.
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    start: 0,
    end: FIRST_LINE_READ_CAP - 1,
    ...(signal ? { signal } : {}),
  })
  // Silence stream errors so a late read-ahead error after we've already
  // returned the first line cannot escape as an unhandled 'error' event.
  // readline's async iterator re-throws underlying stream errors (ENOENT,
  // EACCES, etc.) on Node 16+, which the catch below handles for the cases
  // that matter for validation.
  stream.on('error', () => {})
  const closed = new Promise<void>(resolve => stream.once('close', resolve))
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let firstLine: string | undefined
  try {
    for await (const line of rl) {
      firstLine = line
      break
    }
  } catch (error) {
    throwIfScanAborted(signal)
    if (isScanAbortedError(error)) throw error
    return null
  } finally {
    rl.close()
    stream.destroy()
    await closed
  }
  throwIfScanAborted(signal)
  if (!firstLine || !firstLine.trim()) return null
  try {
    return JSON.parse(firstLine) as CodexEntry
  } catch {
    return null
  }
}

async function isValidCodexSession(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ valid: boolean; meta?: CodexEntry }> {
  throwIfScanAborted(signal)
  const entry = await readFirstLine(filePath, signal)
  throwIfScanAborted(signal)
  if (!entry) return { valid: false }
  const valid =
    entry.type === 'session_meta' &&
    typeof entry.payload?.originator === 'string' &&
    entry.payload.originator.toLowerCase().startsWith('codex')
  return { valid, meta: valid ? entry : undefined }
}

function getRawJsonStringField(head: string, field: string): string | undefined {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
  const match = re.exec(head)
  if (!match) return undefined
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
  }
}

function payloadHead(head: string): string {
  const idx = head.indexOf('"payload"')
  return idx === -1 ? head : head.slice(idx)
}

function countJsonStringBytes(source: Buffer, valueStart: number): number {
  let count = 0
  for (let i = valueStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === 0x5c) {
      i++
      count++
      continue
    }
    if (ch === 0x22) return count
    count++
  }
  return count
}

function extractFirstJsonText(source: Buffer, cap = LARGE_TEXT_CAP): string {
  const key = Buffer.from('"text"')
  const idx = source.indexOf(key)
  if (idx === -1) return ''
  const colon = source.indexOf(0x3a, idx + key.length)
  if (colon === -1) return ''
  const qStart = source.indexOf(0x22, colon + 1)
  if (qStart === -1) return ''
  const chunks: number[] = []
  for (let i = qStart + 1; i < source.length && chunks.length < cap; i++) {
    const ch = source[i]
    if (ch === 0x5c) {
      const next = source[++i]
      if (next === 0x6e) chunks.push(0x0a)
      else if (next === 0x72) chunks.push(0x0d)
      else if (next === 0x74) chunks.push(0x09)
      else if (next !== undefined) chunks.push(next)
      continue
    }
    if (ch === 0x22) break
    chunks.push(ch)
  }
  return Buffer.from(chunks).toString('utf-8')
}

function countFirstJsonText(source: Buffer): number {
  const key = Buffer.from('"text"')
  const idx = source.indexOf(key)
  if (idx === -1) return 0
  const colon = source.indexOf(0x3a, idx + key.length)
  if (colon === -1) return 0
  const qStart = source.indexOf(0x22, colon + 1)
  if (qStart === -1) return 0
  return countJsonStringBytes(source, qStart + 1)
}

function parseCodexLine(line: string | Buffer): CodexEntry | null {
  if (typeof line === 'string') {
    const trimmed = line.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed) as CodexEntry
    } catch {
      return null
    }
  }

  if (line.length === 0) return null
  const head = line.subarray(0, RAW_HEAD_BYTES).toString('utf-8')
  const type = getRawJsonStringField(head, 'type')
  if (!type) return null
  const pHead = payloadHead(head)
  const payloadType = getRawJsonStringField(pHead, 'type')
  const role = getRawJsonStringField(pHead, 'role')

  const entry: CodexEntry = {
    type,
    timestamp: getRawJsonStringField(head, 'timestamp'),
    payload: {
      type: payloadType,
      role,
      cwd: getRawJsonStringField(pHead, 'cwd'),
      model_provider: getRawJsonStringField(pHead, 'model_provider'),
      originator: getRawJsonStringField(pHead, 'originator'),
      session_id: getRawJsonStringField(pHead, 'session_id'),
      forked_from_id: getRawJsonStringField(pHead, 'forked_from_id'),
      model: getRawJsonStringField(pHead, 'model'),
      name: getRawJsonStringField(pHead, 'name'),
    },
  }
  const payload = entry.payload
  if (!payload) return entry

  if (type === 'response_item' && payloadType === 'message' && role === 'user') {
    payload.content = [{ type: 'input_text', text: extractFirstJsonText(line) }]
  } else if (type === 'response_item' && payloadType === 'message' && role === 'assistant') {
    payload.content = [{ type: 'output_text', text: 'x'.repeat(Math.min(countFirstJsonText(line), LARGE_TEXT_CAP)) }]
  }

  return entry
}

async function discoverSessionFile(filePath: string, signal?: AbortSignal): Promise<SessionSource | null> {
  throwIfScanAborted(signal)
  const s = await stat(filePath).catch(() => {
    throwIfScanAborted(signal)
    return null
  })
  throwIfScanAborted(signal)
  if (!s?.isFile()) return null

  const cachedProject = await getCachedCodexProject(filePath, signal)
  throwIfScanAborted(signal)
  if (cachedProject) {
    return { path: filePath, project: cachedProject, provider: 'codex' }
  }

  const { valid, meta } = await isValidCodexSession(filePath, signal)
  throwIfScanAborted(signal)
  if (!valid || !meta) return null

  const cwd = meta.payload?.cwd ?? 'unknown'
  // Forward the absolute checkout so the port-in seam can attribute the
  // session even when the file-level cache carries no directory (the
  // call-level fallback in port.ts covers already-cached files; this covers
  // fresh discoveries and keeps `source.workingDirectory` truthful).
  const workingDirectory = cwd !== 'unknown' && cwd.trim() ? cwd : undefined
  return {
    path: filePath,
    project: sanitizeProject(cwd),
    provider: 'codex',
    ...(workingDirectory ? { workingDirectory } : {}),
  }
}

async function readdirOrEmpty(path: string, signal?: AbortSignal): Promise<string[]> {
  throwIfScanAborted(signal)
  try {
    const entries = await readdir(path)
    throwIfScanAborted(signal)
    return entries
  } catch (error) {
    throwIfScanAborted(signal)
    if (isScanAbortedError(error)) throw error
    return []
  }
}

async function discoverSessionsInDir(codexDir: string, signal?: AbortSignal): Promise<SessionSource[]> {
  throwIfScanAborted(signal)
  const sources: SessionSource[] = []
  const sessionsDir = join(codexDir, 'sessions')

  const years = await readdirOrEmpty(sessionsDir, signal)

  for (const year of years) {
    throwIfScanAborted(signal)
    if (!/^\d{4}$/.test(year)) continue
    const yearDir = join(sessionsDir, year)
    const months = await readdirOrEmpty(yearDir, signal)

    for (const month of months) {
      throwIfScanAborted(signal)
      if (!/^\d{2}$/.test(month)) continue
      const monthDir = join(yearDir, month)
      const days = await readdirOrEmpty(monthDir, signal)

      for (const day of days) {
        throwIfScanAborted(signal)
        if (!/^\d{2}$/.test(day)) continue
        const dayDir = join(monthDir, day)
        const files = await readdirOrEmpty(dayDir, signal)

        for (const file of files) {
          throwIfScanAborted(signal)
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
          const filePath = join(dayDir, file)
          const source = await discoverSessionFile(filePath, signal)
          throwIfScanAborted(signal)
          if (source) sources.push(source)
        }
      }
    }
  }

  // Codex moves archived sessions into a flat directory. Keep them in usage
  // reports so archiving a conversation does not erase its historical usage.
  const archivedDir = join(codexDir, 'archived_sessions')
  const archivedFiles = await readdirOrEmpty(archivedDir, signal)
  for (const file of archivedFiles) {
    throwIfScanAborted(signal)
    if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
    const source = await discoverSessionFile(join(archivedDir, file), signal)
    throwIfScanAborted(signal)
    if (source) sources.push(source)
  }

  return sources
}

function resolveModel(info: CodexEntry['payload'], sessionModel?: string): string {
  return info?.model ?? info?.info?.model ?? info?.info?.model_name ?? sessionModel ?? 'gpt-5'
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/**
 * Owns cache/stat Promise IO across interruption. Interruption aborts the
 * local signal and the scope finalizer waits for the underlying Promise to
 * settle before parser state or cache ownership can be released.
 */
function runOwnedParserPromise<A>(
  operation: (signal: AbortSignal) => Promise<A>,
  parentSignal?: AbortSignal,
): Effect.Effect<A, Error, import('effect/Scope').Scope> {
  return Effect.gen(function* () {
    const owned = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const controller = new AbortController()
        let settled = false
        let resolveSettled!: () => void
        const drained = new Promise<void>(resolve => {
          resolveSettled = resolve
        })
        const abortFromParent = (): void => controller.abort(parentSignal?.reason)
        if (parentSignal?.aborted) abortFromParent()
        else parentSignal?.addEventListener('abort', abortFromParent, { once: true })

        const promise = Promise.resolve()
          .then(() => operation(controller.signal))
          .finally(() => {
            settled = true
            parentSignal?.removeEventListener('abort', abortFromParent)
            resolveSettled()
          })
        return { controller, promise, drained, isSettled: () => settled }
      }),
      resource =>
        Effect.promise(async () => {
          if (!resource.isSettled()) {
            if (!resource.controller.signal.aborted) resource.controller.abort()
            await resource.drained
          }
        }),
    )

    return yield* Effect.tryPromise({
      try: () => owned.promise,
      catch: cause => (parentSignal?.aborted ? scanAbortError(parentSignal) : toError(cause)),
    })
  })
}

function createParser(source: SessionSource, seenKeys: Set<string>, context?: ProviderScanContext): SessionParser {
  const pricing = context?.pricing ?? captureScanPricing()
  const parseStream = (): Stream.Stream<ParsedProviderCall, Error> =>
    Stream.scoped(
      Stream.unwrap(
        Effect.gen(function* () {
          const { signal } = context ?? {}
          const checkAbort = Effect.try({ try: () => throwIfScanAborted(signal), catch: toError })
          yield* checkAbort
          const cached = yield* runOwnedParserPromise(
            ownedSignal => readCachedCodexResults(source.path, ownedSignal),
            signal,
          )
          yield* checkAbort
          if (cached) {
            return Stream.fromIterable(cached).pipe(
              Stream.rechunk(1),
              Stream.filterEffect(call =>
                Effect.try({
                  try: () => {
                    throwIfScanAborted(signal)
                    if (seenKeys.has(call.deduplicationKey)) return false
                    seenKeys.add(call.deduplicationKey)
                    return true
                  },
                  catch: toError,
                }),
              ),
            )
          }

          const fp = yield* runOwnedParserPromise(ownedSignal => fingerprintFile(source.path, ownedSignal), signal)
          yield* checkAbort
          if (!fp) return Stream.empty

          let sessionModel: string | undefined
          let sessionId = ''
          let sessionCwd: string | undefined
          let forkedFromId = ''
          let forkCutoff = ''
          // Null sentinel rather than `0` so the FIRST event is never confused
          // with a duplicate. A session that only emits last_token_usage (no
          // total_token_usage) reports cumulativeTotal=0 on every event; with a
          // 0-initialized prev, the first event would have matched and been
          // dropped. Once we've observed any event, we record its cumulative
          // total and dedup on equality regardless of whether it is zero.
          let prevCumulativeTotal: number | null = null
          let prevInput = 0
          let prevCached = 0
          let prevOutput = 0
          let prevReasoning = 0
          let pendingTools: string[] = []
          let pendingToolSequence: ToolCall[][] = []
          let pendingUserMessage = ''
          // Bounded assistant output text for the central PR scan (the agent
          // printing the URL of the PR it just created). Transient evidence only.
          let pendingAssistantText = ''
          let pendingOutputChars = 0
          // Rich-session-capture: edit LOC deltas and failed-patch count accumulated
          // across a turn's patch_apply_end events, flushed onto the turn's call.
          let pendingLocAdded = 0
          let pendingLocRemoved = 0
          let pendingEditFailed = 0
          let estCounter = 0
          let turnCounter = 0
          let currentTurnId = `${sessionId}:t0`
          let sawAnyLine = false
          const results: ParsedProviderCall[] = []

          // Per-line state changes remain synchronous; file IO and stream
          // lifecycle belong to the native Effect workflow below.
          const processLine = (rawLine: string | Buffer): void => {
            throwIfScanAborted(signal)
            const entry = parseCodexLine(rawLine)
            if (!entry) return

            if (entry.type === 'session_meta') {
              sessionId = entry.payload?.session_id ?? basename(source.path, '.jsonl')
              sessionCwd = entry.payload?.cwd ?? sessionCwd
              forkedFromId = entry.payload?.forked_from_id ?? ''
              if (forkedFromId && entry.timestamp) {
                forkCutoff = new Date(new Date(entry.timestamp).getTime() + 5000).toISOString()
              }
              sessionModel = entry.payload?.model ?? sessionModel
              return
            }

            if (entry.type === 'turn_context' && entry.payload?.model) {
              sessionModel = entry.payload.model
              return
            }

            if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
              const rawName = entry.payload.name ?? ''
              const mapped = toolNameMap[rawName] ?? rawName
              pendingTools.push(mapped)
              const call: ToolCall = { tool: mapped }
              const rawArgs = (entry.payload as Record<string, unknown>)['arguments']
              const args =
                typeof rawArgs === 'string'
                  ? (() => {
                      try {
                        return JSON.parse(rawArgs) as Record<string, unknown>
                      } catch {
                        return null
                      }
                    })()
                  : typeof rawArgs === 'object' && rawArgs
                    ? (rawArgs as Record<string, unknown>)
                    : null
              if (args) {
                const fp = args['file_path'] ?? args['path']
                if (typeof fp === 'string') call.file = fp
                const cmd = args['command'] ?? args['cmd']
                if (typeof cmd === 'string') call.command = cmd
                // Attribute a CLI-wrapped MCP call (e.g. `mcp-cli call server tool`)
                // to the MCP breakdown too; the exec still counts as Bash above.
                const mcpTool = mcpToolFromShellCommand(cmd)
                if (mcpTool) {
                  pendingTools.push(mcpTool)
                  pendingToolSequence.push([{ tool: mcpTool }])
                }
              }
              pendingToolSequence.push([call])
              return
            }

            if (entry.type === 'event_msg' && entry.payload?.type === 'patch_apply_end') {
              pendingTools.push('Edit')
              const p = entry.payload as Record<string, unknown>
              const changes = p['changes']
              const changesObj = typeof changes === 'object' && changes ? (changes as Record<string, unknown>) : {}
              const filePaths = Object.keys(changesObj)
              if (filePaths.length > 0) {
                for (const fp of filePaths) {
                  pendingToolSequence.push([{ tool: 'Edit', file: fp }])
                  const diff = (changesObj[fp] as Record<string, unknown> | undefined)?.['unified_diff']
                  const loc = countUnifiedDiffLoc(diff)
                  pendingLocAdded += loc.added
                  pendingLocRemoved += loc.removed
                }
              } else {
                pendingToolSequence.push([{ tool: 'Edit' }])
              }
              // Only an explicit failure counts; a missing `success` is treated as ok.
              if (p['success'] === false) pendingEditFailed++
              return
            }

            // Recent Codex emits MCP calls as `event_msg`/`mcp_tool_call_end`
            // instead of a `function_call` response_item, so the call was never
            // attributed. Rebuild the canonical `mcp__<server>__<tool>` name the
            // classifier recognizes.
            if (entry.type === 'event_msg' && entry.payload?.type === 'mcp_tool_call_end') {
              const inv = (entry.payload as Record<string, unknown>)['invocation'] as
                Record<string, unknown> | undefined
              const server = typeof inv?.['server'] === 'string' ? (inv['server'] as string) : ''
              const tool = typeof inv?.['tool'] === 'string' ? (inv['tool'] as string) : ''
              if (server && tool) {
                const name = `mcp__${server}__${tool}`
                pendingTools.push(name)
                pendingToolSequence.push([{ tool: name }])
              }
              return
            }

            if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
              const texts = normalizeContentBlocks(entry.payload.content)
                .filter(c => c.type === 'input_text')
                .map(c => c.text ?? '')
                .filter(Boolean)
              if (texts.length > 0) {
                pendingUserMessage = texts.join(' ').slice(0, 500)
                currentTurnId = `${sessionId}:t${++turnCounter}`
              }
              return
            }

            if (
              entry.type === 'response_item' &&
              entry.payload?.type === 'message' &&
              entry.payload?.role === 'assistant'
            ) {
              const texts = normalizeContentBlocks(entry.payload.content)
                .filter(c => c.type === 'output_text' || c.type === 'text')
                .map(c => c.text ?? '')
              pendingOutputChars += texts.join('').length
              if (pendingAssistantText.length < 2000) {
                pendingAssistantText = (pendingAssistantText + texts.join(' ')).slice(0, 2000)
              }
              return
            }

            if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
              // Forked sessions replay the parent's entire event history with
              // timestamps clustered at the fork creation time. Skip replayed
              // events (within 5s of fork) to avoid double-counting.
              if (forkCutoff && entry.timestamp && entry.timestamp < forkCutoff) return
              const info = entry.payload.info
              if (!info) {
                if (pendingOutputChars === 0 && pendingUserMessage.length === 0) return
                const estInput = estimateTokensFromChars(pendingUserMessage.length)
                const estOutput = estimateTokensFromChars(pendingOutputChars)
                if (estInput === 0 && estOutput === 0) return

                const model = sessionModel ?? 'gpt-5'
                const timestamp = entry.timestamp ?? ''
                const dedupKey = `codex:${sessionId}:${timestamp}:est${estCounter++}`

                if (seenKeys.has(dedupKey)) {
                  pendingTools = []
                  pendingToolSequence = []
                  pendingUserMessage = ''
                  pendingAssistantText = ''
                  pendingOutputChars = 0
                  pendingLocAdded = 0
                  pendingLocRemoved = 0
                  pendingEditFailed = 0
                  return
                }
                seenKeys.add(dedupKey)

                const costUSD = pricing.calculateCost(model, estInput, estOutput, 0, 0, 0)

                results.push({
                  provider: 'codex',
                  model,
                  inputTokens: estInput,
                  outputTokens: estOutput,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 0,
                  cachedInputTokens: 0,
                  reasoningTokens: 0,
                  webSearchRequests: 0,
                  costUSD,
                  costIsEstimated: true,
                  tools: pendingTools,
                  bashCommands: [],
                  timestamp,
                  speed: 'standard',
                  deduplicationKey: dedupKey,
                  turnId: currentTurnId,
                  toolSequence: pendingToolSequence.length > 0 ? pendingToolSequence : undefined,
                  userMessage: pendingUserMessage,
                  ...(pendingAssistantText ? { assistantText: pendingAssistantText } : {}),
                  sessionId,
                  ...(sessionCwd ? { projectPath: sessionCwd, workingDirectory: sessionCwd } : {}),
                  ...(pendingLocAdded ? { locAdded: pendingLocAdded } : {}),
                  ...(pendingLocRemoved ? { locRemoved: pendingLocRemoved } : {}),
                  ...(pendingEditFailed ? { editFailed: pendingEditFailed } : {}),
                })

                pendingTools = []
                pendingToolSequence = []
                pendingUserMessage = ''
                pendingAssistantText = ''
                pendingOutputChars = 0
                pendingLocAdded = 0
                pendingLocRemoved = 0
                pendingEditFailed = 0
                return
              }

              const cumulativeTotal = info.total_token_usage?.total_tokens ?? 0
              // Dedup guard. Two consecutive events with cumulativeTotal=0 but
              // non-empty last_token_usage would have been double-counted with
              // the previous `> 0` clause. The null sentinel ensures the FIRST
              // event always passes (so a session that never reports cumulative
              // doesn't lose its opening turn).
              if (prevCumulativeTotal !== null && cumulativeTotal === prevCumulativeTotal) return
              prevCumulativeTotal = cumulativeTotal

              const last = info.last_token_usage
              let inputTokens = 0
              let cachedInputTokens = 0
              let outputTokens = 0
              let reasoningTokens = 0

              if (last) {
                inputTokens = last.input_tokens ?? 0
                cachedInputTokens = last.cached_input_tokens ?? 0
                outputTokens = last.output_tokens ?? 0
                reasoningTokens = last.reasoning_output_tokens ?? 0
              } else if (cumulativeTotal > 0) {
                const total = info.total_token_usage
                if (!total) return
                inputTokens = (total.input_tokens ?? 0) - prevInput
                cachedInputTokens = (total.cached_input_tokens ?? 0) - prevCached
                outputTokens = (total.output_tokens ?? 0) - prevOutput
                reasoningTokens = (total.reasoning_output_tokens ?? 0) - prevReasoning
              }

              // Always advance the prev counters to track the cumulative state.
              // Previously prev was only updated on the fallback branch, so a
              // session with mixed last_token_usage / no-last events would
              // compute the next fallback delta against a stale prev=0 baseline,
              // double-counting the entire cumulative window. The prev value
              // must mirror what cumulative reports regardless of whether this
              // event used `last` or fell back to deltas.
              const total = info.total_token_usage
              if (total) {
                prevInput = total.input_tokens ?? 0
                prevCached = total.cached_input_tokens ?? 0
                prevOutput = total.output_tokens ?? 0
                prevReasoning = total.reasoning_output_tokens ?? 0
              }

              const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens
              if (totalTokens === 0) return

              // OpenAI includes cached tokens inside input_tokens; Anthropic does not.
              // Normalize to Anthropic semantics: inputTokens = non-cached only.
              const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)

              const model = resolveModel(entry.payload, sessionModel)
              const timestamp = entry.timestamp ?? ''
              // Forked sessions copy the parent's entire token_count history
              // (re-timestamped), so replays must collide with the parent's events
              // and drop to avoid double-counting -- hence the parent namespace
              // (forkedFromId) and the deliberate omission of the per-session id.
              // But cumulativeTotal alone is too coarse a discriminator: a genuine
              // post-divergence fork event whose running total coincidentally equals
              // some parent total would also collide and be lost (undercount). So we
              // also key on the cumulative token breakdown, which a fork replays
              // verbatim from the parent -- a true replay collides exactly, while
              // genuinely different work at the same total stays distinct. We use the
              // CUMULATIVE figures (not the per-event deltas) on purpose: the deltas
              // are computed against a running `prev` that the fork advances
              // differently once the 5s cutoff skips some replays, so a delta-based
              // key would spuriously diverge on a replay and double-count it.
              const dedupKey = `codex:${forkedFromId || sessionId}:${cumulativeTotal}:${total?.input_tokens ?? 0}:${total?.cached_input_tokens ?? 0}:${total?.output_tokens ?? 0}:${total?.reasoning_output_tokens ?? 0}`

              if (seenKeys.has(dedupKey)) return
              seenKeys.add(dedupKey)

              const costUSD = pricing.calculateCost(
                model,
                uncachedInputTokens,
                // OpenAI's `reasoning_output_tokens` is a breakdown of
                // `output_tokens`, not a sibling of it — the helper keeps the fold
                // from billing the same tokens twice.
                billableOutputTokens('codex', outputTokens, reasoningTokens),
                0,
                cachedInputTokens,
                0,
              )

              results.push({
                provider: 'codex',
                model,
                inputTokens: uncachedInputTokens,
                outputTokens,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: cachedInputTokens,
                cachedInputTokens,
                reasoningTokens,
                webSearchRequests: 0,
                costUSD,
                tools: pendingTools,
                bashCommands: [],
                timestamp,
                speed: 'standard',
                deduplicationKey: dedupKey,
                turnId: currentTurnId,
                toolSequence: pendingToolSequence.length > 0 ? pendingToolSequence : undefined,
                userMessage: pendingUserMessage,
                ...(pendingAssistantText ? { assistantText: pendingAssistantText } : {}),
                sessionId,
                ...(sessionCwd ? { projectPath: sessionCwd, workingDirectory: sessionCwd } : {}),
                ...(pendingLocAdded ? { locAdded: pendingLocAdded } : {}),
                ...(pendingLocRemoved ? { locRemoved: pendingLocRemoved } : {}),
                ...(pendingEditFailed ? { editFailed: pendingEditFailed } : {}),
              })

              pendingTools = []
              pendingToolSequence = []
              pendingUserMessage = ''
              pendingAssistantText = ''
              pendingOutputChars = 0
              pendingLocAdded = 0
              pendingLocRemoved = 0
              pendingEditFailed = 0
            }
          }

          yield* Stream.runForEach(
            readSessionLinesStream(source.path, undefined, {
              largeLineAsBuffer: true,
              ...(signal ? { signal } : {}),
            }),
            rawLine =>
              Effect.try({
                try: () => {
                  sawAnyLine = true
                  processLine(rawLine)
                },
                catch: toError,
              }),
          )

          // If the stream yielded nothing the file was unreadable, oversized, or
          // empty. Skip cache write so a transient failure can't pin an empty
          // result set against a fingerprint that would otherwise be re-parsed.
          yield* checkAbort
          if (!sawAnyLine) return Stream.empty

          yield* runOwnedParserPromise(
            ownedSignal => writeCachedCodexResults(source.path, source.project, results, fp, ownedSignal),
            signal,
          )
          yield* checkAbort

          return Stream.fromIterable(results)
        }),
      ),
    )

  return {
    parseStream,
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      yield* Stream.toAsyncIterable(parseStream())
    },
  }
}

export function createCodexProvider(codexDir?: string, paths?: AppPaths): Provider {
  // One trailing snapshot param, never a second "override" slot: the explicit
  // `codexDir` wins, then `AppPaths.codexHome` — the `CODEX_HOME` value the
  // startup snapshot reports, or the homedir default when the var is unset.
  // The seam keeps its own `??` chain, so an uninitialized snapshot resolves
  // exactly the `process.env['CODEX_HOME']` the pre-snapshot read saw.
  //
  // A FUNCTION, not a value: the dir is resolved per call so this factory is
  // safe to run at module-evaluation time (the registry imports the singleton
  // below, and module bodies evaluate before any importer's body, so a value
  // captured here would freeze the pre-`initAppPaths` snapshot). Every other
  // seam already resolves `appPaths()` inside its call; this one now does too.
  const dir = (): string => resolveCodexHome((paths ?? appPaths()).codexHome, codexDir)

  return {
    name: 'codex',
    displayName: 'Codex',

    modelDisplayName(model: string): string {
      for (const [key, name] of modelDisplayEntries) {
        if (model === key || model.startsWith(key + '-')) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    // `<home>/sessions` (dated rollout files) and `<home>/archived_sessions`
    // are the two roots `discoverSessionsInDir` walks, where `home` is `dir()`
    // resolved at this call. Honors CODEX_HOME.
    async probeRoots(): Promise<ProbeRoot[]> {
      const home = dir()
      return [
        { path: join(home, 'sessions'), label: 'sessions' },
        { path: join(home, 'archived_sessions'), label: 'archived' },
      ]
    },

    async discoverSessions(context?: ProviderScanContext): Promise<SessionSource[]> {
      throwIfScanAborted(context?.signal)
      return discoverSessionsInDir(dir(), context?.signal)
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
      _dateRange?: DateRange,
      context?: ProviderScanContext,
    ): SessionParser {
      return createParser(source, seenKeys, context)
    },
  }
}

// The registry (`providers/index.ts`) imports this singleton, and it is built
// with NO threaded record for the same reason `export const opencode =
// createOpenCodeProvider()` is: the seam falls back to `appPaths()` at CALL
// time, so the record the importer's `initAppPaths` installs is honoured.
//
// LAZY, deliberately — and the ordering constraint that used to force the
// opposite is gone. Module bodies evaluate BEFORE any importer's body, so the
// previous `createCodexProvider(undefined, appPaths())` captured the snapshot
// from BEFORE `initAppPaths` runs in either isolate: a boot-time
// `initAppPaths({ codexHome })` would have been ignored by `codex` while every
// other provider honoured it. That was invisible only because an uninitialized
// `codexHome` falls back to the same `process.env['CODEX_HOME']` the seam
// always read. Per-call resolution is what makes `codex` report the pin the
// moment boot makes it, with no import-order contract to maintain.
export const codex = createCodexProvider()
