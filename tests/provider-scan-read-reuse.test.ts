import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({
  home: '',
  paths: [] as string[],
  pendingPath: undefined as string | undefined,
  readStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as (() => void) | undefined,
}))

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => reads.home || actual.homedir() }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0])
      reads.paths.push(path)
      if (path !== reads.pendingPath) return actual.readFile(...args)
      reads.readStarted?.()
      return new Promise<string>((resolve, reject) => {
        reads.releaseRead = () => {
          void actual.readFile(...args).then(value => resolve(value.toString()), reject)
        }
      }) as ReturnType<typeof actual.readFile>
    },
  }
})

import { Env } from '../src/main/env.js'
import { createDevinProvider, createDevinScanReads, DevinScanReads } from '../src/main/pipeline/providers/devin.js'
import { createKiroProvider, createKiroScanReads, KiroScanReads } from '../src/main/pipeline/providers/kiro.js'
import type { Provider, SessionParser } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-scan-reads-'))
  reads.home = join(root, 'home')
  reads.paths.length = 0
  reads.pendingPath = undefined
  reads.readStarted = undefined
  reads.releaseRead = undefined
})

afterEach(() => {
  reads.pendingPath = undefined
  reads.readStarted = undefined
  reads.releaseRead = undefined
  const directory = resolve(root)
  const prefix = 'watchtower-scan-reads-'
  if (
    !root ||
    dirname(directory) !== resolve(tmpdir()) ||
    !basename(directory).startsWith(prefix) ||
    basename(directory).length === prefix.length
  ) {
    throw new Error('Refusing to remove an unexpected scan-read fixture directory')
  }
  rmSync(directory, { recursive: true, force: true })
})

function collect(parser: SessionParser) {
  if (!parser.parseStream) throw new Error('Provider parser did not expose its native stream')
  return Stream.runCollect(parser.parseStream())
}

function discover(provider: Provider) {
  if (!provider.discoverSessionsEffect) throw new Error('Provider did not expose native discovery')
  return provider.discoverSessionsEffect()
}

function writeDevinFixtures(): { configPath: string; cliDir: string; transcriptPath: string } {
  const configPath = join(reads.home, '.config', 'watchtower', 'config.json')
  mkdirSync(join(reads.home, '.config', 'watchtower'), { recursive: true })
  writeFileSync(configPath, JSON.stringify({ devin: { acuUsdRate: 0.05 } }))

  const cliDir = join(root, 'devin', 'cli')
  const transcripts = join(cliDir, 'transcripts')
  mkdirSync(transcripts, { recursive: true })
  const db = new DatabaseSync(join(cliDir, 'sessions.db'))
  db.exec(
    'CREATE TABLE sessions(id TEXT, working_directory TEXT, model TEXT, title TEXT, created_at REAL, last_activity_at REAL, hidden INTEGER)',
  )
  db.close()

  const transcriptPath = join(transcripts, 'session-one.json')
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      schema_version: 'ATIF-v1.7',
      session_id: 'session-one',
      agent: { name: 'Devin', version: '1', model_name: 'gpt-4.1' },
      steps: [{ step_id: 1, message: 'prompt', metadata: { is_user_input: true } }],
    }),
  )
  return { configPath, cliDir, transcriptPath }
}

describe('per-scan provider read capabilities', () => {
  it('reuses Devin config between discovery and parsing, then refreshes in a new scan', async () => {
    const { configPath, cliDir, transcriptPath } = writeDevinFixtures()
    const provider = createDevinProvider(cliDir)
    const source = { path: transcriptPath, project: 'devin', provider: 'devin' }

    const firstReads = await Effect.runPromise(createDevinScanReads())
    await Effect.runPromise(
      discover(provider).pipe(Effect.provideService(DevinScanReads, firstReads), Effect.provide(Env.layer)),
    )
    await Effect.runPromise(
      collect(provider.createSessionParser(source, new Set())).pipe(Effect.provideService(DevinScanReads, firstReads)),
    )
    expect(reads.paths.filter(path => path === configPath)).toHaveLength(1)

    const secondReads = await Effect.runPromise(createDevinScanReads())
    await Effect.runPromise(
      discover(provider).pipe(Effect.provideService(DevinScanReads, secondReads), Effect.provide(Env.layer)),
    )
    expect(reads.paths.filter(path => path === configPath)).toHaveLength(2)
  })

  it('reuses decoded Kiro companion metadata between discovery and parsing, then refreshes next scan', async () => {
    const cliDir = join(root, 'kiro', 'sessions', 'cli')
    mkdirSync(cliDir, { recursive: true })
    const sessionPath = join(cliDir, 'cli.jsonl')
    const companionPath = join(cliDir, 'cli.json')
    writeFileSync(
      sessionPath,
      [
        { kind: 'Prompt', data: { content: [{ kind: 'text', data: 'prompt' }] } },
        { kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'answer' }] } },
      ]
        .map(entry => JSON.stringify(entry))
        .join('\n'),
    )
    writeFileSync(companionPath, JSON.stringify({ session_id: 'scan-one', cwd: join(root, 'project') }))
    const provider = createKiroProvider(join(root, 'agent'), join(root, 'workspace'), cliDir)
    const makeScan = () => Effect.runPromise(createKiroScanReads())

    const firstReads = await makeScan()
    const found = await Effect.runPromise(
      discover(provider).pipe(Effect.provideService(KiroScanReads, firstReads), Effect.provide(Env.layer)),
    )
    expect(found).toContainEqual({ path: sessionPath, project: 'project', provider: 'kiro' })
    const [source] = found
    if (!source) throw new Error('Kiro discovery did not return the CLI source')
    await Effect.runPromise(
      collect(provider.createSessionParser(source, new Set())).pipe(Effect.provideService(KiroScanReads, firstReads)),
    )
    expect(reads.paths.filter(path => path === companionPath)).toHaveLength(1)

    const secondReads = await makeScan()
    await Effect.runPromise(
      discover(provider).pipe(Effect.provideService(KiroScanReads, secondReads), Effect.provide(Env.layer)),
    )
    expect(reads.paths.filter(path => path === companionPath)).toHaveLength(2)
  })

  it('checks abort before a cached Devin lookup', async () => {
    const { configPath } = writeDevinFixtures()
    const controller = new AbortController()
    const scanReads = await Effect.runPromise(createDevinScanReads(controller.signal))

    await Effect.runPromise(scanReads.readCostFactor(configPath))
    controller.abort()
    await expect(Effect.runPromise(scanReads.readCostFactor(configPath))).rejects.toBeInstanceOf(ScanAbortedError)
    expect(reads.paths.filter(path => path === configPath)).toHaveLength(1)
  })

  it('drains a pending Kiro companion read before reporting scan abort', async () => {
    const companionPath = join(root, 'pending.json')
    writeFileSync(companionPath, JSON.stringify({ session_id: 'pending' }))
    reads.pendingPath = companionPath
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    reads.readStarted = markStarted
    const controller = new AbortController()
    const scanReads = await Effect.runPromise(createKiroScanReads(controller.signal))
    const lookup = Effect.runPromise(scanReads.readCompanionRecord(companionPath))

    await started
    controller.abort()
    reads.releaseRead?.()
    await expect(lookup).rejects.toBeInstanceOf(ScanAbortedError)
    expect(reads.paths.filter(path => path === companionPath)).toHaveLength(1)
  })
})
