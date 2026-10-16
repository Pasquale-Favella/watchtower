import * as Effect from 'effect/Effect'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { parseClaudeEntriesEffect, readAgentTypeEffect } from '../src/main/pipeline/parser.js'

describe('native Claude session reader', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('reads full and offset regions through the owned native stream', async () => {
    directory = await mkdtemp(join(tmpdir(), 'watchtower-claude-native-'))
    const filePath = join(directory, 'session.jsonl')
    const first = JSON.stringify({ type: 'user', sessionId: 'first' })
    const second = JSON.stringify({ type: 'assistant', sessionId: 'second' })
    await writeFile(filePath, `${first}\n${second}\n`)

    const fullTracker = { lastCompleteLineOffset: 0 }
    const full = await Effect.runPromise(parseClaudeEntriesEffect(filePath, fullTracker))

    expect(full?.map(entry => entry.sessionId)).toEqual(['first', 'second'])
    expect(fullTracker.lastCompleteLineOffset).toBe(Buffer.byteLength(`${first}\n${second}\n`))

    const appendTracker = { lastCompleteLineOffset: fullTracker.lastCompleteLineOffset }
    const third = JSON.stringify({ type: 'user', sessionId: 'third' })
    await writeFile(filePath, `${first}\n${second}\n${third}\n`)
    const appended = await Effect.runPromise(
      parseClaudeEntriesEffect(filePath, appendTracker, fullTracker.lastCompleteLineOffset),
    )

    expect(appended?.map(entry => entry.sessionId)).toEqual(['third'])
    expect(appendTracker.lastCompleteLineOffset).toBe(Buffer.byteLength(`${first}\n${second}\n${third}\n`))

    const fullLatest = await Effect.runPromise(parseClaudeEntriesEffect(filePath, { lastCompleteLineOffset: 0 }))
    expect([...(full ?? []), ...(appended ?? [])]).toEqual(fullLatest)
  })

  it('decodes subagent metadata and keeps the workflow fallback for invalid sidecars', async () => {
    directory = await mkdtemp(join(tmpdir(), 'watchtower-claude-meta-'))
    const workflowPath = join(directory, 'subagents', 'workflows', 'agent-a.jsonl')
    const ordinaryPath = join(directory, 'subagents', 'agent-b.jsonl')
    await mkdir(join(directory, 'subagents', 'workflows'), { recursive: true })
    await writeFile(workflowPath.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: '  Explore  ' }))
    await writeFile(ordinaryPath.replace(/\.jsonl$/, '.meta.json'), '{invalid')

    expect(await Effect.runPromise(readAgentTypeEffect(workflowPath))).toBe('Explore')
    expect(await Effect.runPromise(readAgentTypeEffect(ordinaryPath))).toBeUndefined()
  })
})
