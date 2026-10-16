import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fileHooks = vi.hoisted(() => ({ oversizePath: null as string | null, readPaths: [] as string[] }))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]) === fileHooks.oversizePath) {
        return Promise.resolve({ size: 128 * 1024 * 1024 + 1 } as Awaited<ReturnType<typeof actual.stat>>)
      }
      return actual.stat(...args)
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      fileHooks.readPaths.push(String(args[0]))
      return actual.readFile(...args)
    },
  }
})

import { appPaths, Env } from '../src/main/env.js'
import { createCopilotProvider } from '../src/main/pipeline/providers/copilot.js'
import type { Provider, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-copilot-discovery-'))
  fileHooks.oversizePath = null
  fileHooks.readPaths.length = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function nativeDiscovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Copilot Effect discovery is unavailable')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

async function makeFile(path: string, contents = ''): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents)
}

describe('Copilot Effect discovery', () => {
  it('keeps CLI store first, uses OTel before chat journals, and discovers CLI JSONL', async () => {
    const sessionState = join(root, 'session-state')
    const cliHome = join(root, 'copilot-home')
    const otelDb = join(root, 'agent-traces.db')
    await makeFile(join(cliHome, 'session-store.db'))
    await makeFile(otelDb)
    await makeFile(join(sessionState, 'session-1', 'events.jsonl'))
    await makeFile(join(root, 'workspace', 'hash', 'chatSessions', 'chat.jsonl'))

    const paths = {
      ...appPaths(),
      overrides: {
        ...appPaths().overrides,
        WATCHTOWER_COPILOT_SESSION_STORE_DB: cliHome,
        WATCHTOWER_COPILOT_OTEL_DB: otelDb,
      },
    }
    const provider = createCopilotProvider(
      sessionState,
      join(root, 'workspace'),
      join(root, 'global'),
      join(root, 'jb'),
      paths,
    )
    const sources = await Effect.runPromise(nativeDiscovery(provider))
    const sourceTypes = sources.map(source => ('sourceType' in source ? source.sourceType : undefined))

    expect(sourceTypes).toEqual(['sessionstore', 'otel', 'jsonl'])
    expect(sources[0]?.path).toBe(join(cliHome, 'session-store.db'))
  })

  it('decodes workspace metadata through Schema and keeps the storage hash on malformed data', async () => {
    const workspace = join(root, 'workspace')
    const chatPath = join(workspace, 'workspace-hash', 'chatSessions', 'chat.jsonl')
    await makeFile(chatPath)
    await makeFile(join(workspace, 'workspace-hash', 'workspace.json'), '{"folder":42}')

    const provider = createCopilotProvider(
      join(root, 'missing-cli'),
      workspace,
      join(root, 'missing-global'),
      join(root, 'missing-jb'),
      {
        ...appPaths(),
        overrides: { ...appPaths().overrides, WATCHTOWER_COPILOT_DISABLE_OTEL: '1' },
      },
    )
    const sources: SessionSource[] = await Effect.runPromise(nativeDiscovery(provider))

    expect(sources).toContainEqual(
      expect.objectContaining({
        path: chatPath,
        project: 'workspace-hash',
        sourceType: 'chatsession',
      }),
    )
  })

  it('keeps the storage hash and skips reading workspace metadata above the capped file size', async () => {
    const workspace = join(root, 'workspace')
    const chatPath = join(workspace, 'workspace-hash', 'chatSessions', 'chat.jsonl')
    const workspaceJson = join(workspace, 'workspace-hash', 'workspace.json')
    await makeFile(chatPath)
    await makeFile(workspaceJson, '{"folder":"file:///C:/workspace/project"}')

    fileHooks.oversizePath = workspaceJson
    const provider = createCopilotProvider(
      join(root, 'missing-cli'),
      workspace,
      join(root, 'missing-global'),
      join(root, 'missing-jb'),
      {
        ...appPaths(),
        overrides: { ...appPaths().overrides, WATCHTOWER_COPILOT_DISABLE_OTEL: '1' },
      },
    )

    const sources = await Effect.runPromise(nativeDiscovery(provider))

    expect(sources).toContainEqual(
      expect.objectContaining({ path: chatPath, project: 'workspace-hash', sourceType: 'chatsession' }),
    )
    expect(fileHooks.readPaths).not.toContain(workspaceJson)
  })

  it('fails discovery with the typed abort when the scan is already stopped', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = createCopilotProvider(join(root, 'missing-cli'), join(root, 'missing-workspace'))

    await expect(Effect.runPromise(nativeDiscovery(provider, controller.signal))).rejects.toBeInstanceOf(
      ScanAbortedError,
    )
  })
})
