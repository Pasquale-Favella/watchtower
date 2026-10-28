import { writeFile } from 'node:fs/promises'

import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Stream from 'effect/Stream'

import { createCoachAtoms, mountCoachAtoms } from '../../src/renderer/src/features/coach-skills/atoms.js'
import type { CoachRunFrame } from '../../src/shared/rpc/coach.js'
import type { CoachHarnessRow } from '../../src/shared/schemas/agents.js'
import { makeCoachRpcTestClient } from '../../tests/coach-rpc-test-helper.js'

const runId = 'retention-probe-run'
const chunk = 'x'.repeat(64)
const harnesses: CoachHarnessRow[] = [
  {
    instanceId: 'retention-probe-harness',
    kind: 'codex',
    displayName: 'Controlled probe harness',
    status: 'ready',
    auth: { status: 'configured' },
  },
]

interface RunResult {
  readonly chunks: number
  readonly textFrameCount: number
  readonly toolFrameCount: number
  readonly terminalStatusFrameCount: number
  readonly completedCommandTag: 'Success'
  readonly messageCount: number
  readonly assistantToolNoticeCount: number
  readonly controlledTranscriptUtf8Bytes: number
  readonly peakRegistryNodeCount: number
  readonly resetMessageCount: number
  readonly resetTranscriptUtf8Bytes: number
  readonly disposedRegistryNodeCount: number
}

const waitUntil = async (label: string, predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`)
}

const measureRun = async (chunks: number): Promise<RunResult> => {
  const registry = AtomRegistry.make()
  let peakRegistryNodeCount = 0
  registry.onNodeAdded = () => {
    peakRegistryNodeCount = Math.max(peakRegistryNodeCount, registry.getNodes().size)
  }
  const runtime = Atom.context()
  let runInvocationCount = 0
  let textFrameCount = 0
  let toolFrameCount = 0
  let terminalStatusFrameCount = 0
  const client = makeCoachRpcTestClient(runtime, {
    harnesses: () => Effect.succeed(harnesses),
    refreshHarnesses: () => Effect.succeed(harnesses),
    inspect: () => Effect.succeed({ ok: true }),
    run: () => {
      runInvocationCount += 1
      const frames: CoachRunFrame[] = [{ _tag: 'Started', runId }]
      for (let index = 0; index < chunks; index += 1) {
        frames.push({ _tag: 'Event', runId, event: { kind: 'text', delta: chunk } })
      }
      frames.push(
        {
          _tag: 'Event',
          runId,
          event: { kind: 'tool', tool: 'controlled-probe', id: 'probe-tool', state: 'started', input: '{}' },
        },
        {
          _tag: 'Event',
          runId,
          event: { kind: 'tool', tool: 'controlled-probe', id: 'probe-tool', state: 'completed', output: 'ok' },
        },
        { _tag: 'Event', runId, event: { kind: 'status', state: 'done' } },
      )
      return Stream.fromIterable(frames).pipe(
        Stream.mapEffect(frame =>
          Effect.as(
            Effect.sync(() => {
              if (frame._tag !== 'Event') return
              if (frame.event.kind === 'text') textFrameCount += 1
              if (frame.event.kind === 'tool') toolFrameCount += 1
              if (frame.event.kind === 'status' && frame.event.state === 'done') terminalStatusFrameCount += 1
            }).pipe(Effect.andThen(Effect.yieldNow)),
            frame,
          ),
        ),
      )
    },
  })
  const atoms = createCoachAtoms(client)
  registry.mount(atoms.coachStateAtom)
  const release = mountCoachAtoms(registry, atoms)

  try {
    registry.set(atoms.replaceHarnessesAtom, harnesses)
    await waitUntil(
      'ready harness selection',
      () => registry.get(atoms.coachStateAtom).harnessKind === harnesses[0]?.instanceId,
    )
    registry.set(atoms.sendCoachAtom, 'controlled retention probe prompt')
    const isComplete = (): boolean => {
      const state = registry.get(atoms.coachStateAtom)
      const command = registry.get(atoms.sendCoachAtom)
      const assistant = state.messages.at(-1)
      return (
        !state.running &&
        assistant?.streaming === false &&
        assistant.content.length === chunks * chunk.length &&
        command._tag === 'Success' &&
        !command.waiting
      )
    }
    try {
      await waitUntil('Coach run completion', isComplete)
    } catch (error) {
      const state = registry.get(atoms.coachStateAtom)
      const command = registry.get(atoms.sendCoachAtom)
      const assistant = state.messages.at(-1)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify({
          running: state.running,
          harnessKind: state.harnessKind,
          runInvocationCount,
          messageCount: state.messages.length,
          assistantContentLength: assistant?.content.length ?? null,
          assistantStreaming: assistant?.streaming ?? null,
          commandTag: command._tag,
          commandWaiting: command.waiting,
        })}`,
      )
    }

    const state = registry.get(atoms.coachStateAtom)
    const command = registry.get(atoms.sendCoachAtom)
    if (command._tag !== 'Success') throw new Error('Coach send command did not complete successfully')
    const assistant = state.messages.at(-1)
    if (runInvocationCount !== 1) throw new Error(`Expected one Coach RPC run, received ${runInvocationCount}`)
    if (textFrameCount !== chunks)
      throw new Error(`Expected ${chunks} consumed text frames, received ${textFrameCount}`)
    if (toolFrameCount !== 2) throw new Error(`Expected 2 consumed tool frames, received ${toolFrameCount}`)
    if (terminalStatusFrameCount !== 1) throw new Error('Expected one consumed terminal status frame')
    if (assistant?.tools.length !== 1 || assistant.tools[0]?.state !== 'completed') {
      throw new Error(`Expected one completed assistant tool notice, received ${assistant?.tools.length ?? 0}`)
    }
    const messageCount = state.messages.length
    const controlledTranscriptUtf8Bytes = Buffer.byteLength(
      state.messages.map(message => message.content).join(''),
      'utf8',
    )

    registry.set(atoms.resetSessionAtom, undefined)
    await waitUntil('Coach reset completion', () => {
      const reset = registry.get(atoms.resetSessionAtom)
      return reset._tag === 'Success' && !reset.waiting && registry.get(atoms.coachStateAtom).messages.length === 0
    })
    const resetState = registry.get(atoms.coachStateAtom)
    const resetMessageCount = resetState.messages.length
    const resetTranscriptUtf8Bytes = Buffer.byteLength(
      resetState.messages.map(message => message.content).join(''),
      'utf8',
    )
    release()
    registry.dispose()

    return {
      chunks,
      textFrameCount,
      toolFrameCount,
      terminalStatusFrameCount,
      completedCommandTag: command._tag,
      messageCount,
      assistantToolNoticeCount: assistant.tools.length,
      controlledTranscriptUtf8Bytes,
      peakRegistryNodeCount,
      resetMessageCount,
      resetTranscriptUtf8Bytes,
      disposedRegistryNodeCount: registry.getNodes().size,
    }
  } catch (error) {
    release()
    registry.dispose()
    throw error
  }
}

const main = async (): Promise<void> => {
  const output = process.argv[2]
  if (!output) throw new Error('Pass the output JSON path as the first argument')
  const runs = [await measureRun(32), await measureRun(1024)]
  if (runs[0]?.peakRegistryNodeCount !== runs[1]?.peakRegistryNodeCount) {
    throw new Error(
      `Registry node peak changed with transcript size: ${runs[0]?.peakRegistryNodeCount} vs ${runs[1]?.peakRegistryNodeCount}`,
    )
  }
  if ((runs[1]?.controlledTranscriptUtf8Bytes ?? 0) <= (runs[0]?.controlledTranscriptUtf8Bytes ?? 0)) {
    throw new Error('Controlled transcript bytes did not increase with the text frame count')
  }
  if (
    runs.some(
      run => run.resetMessageCount !== 0 || run.resetTranscriptUtf8Bytes !== 0 || run.disposedRegistryNodeCount !== 0,
    )
  ) {
    throw new Error('Coach reset or registry disposal retained state')
  }
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    fixture: 'in-memory Effect RpcTest stream; synthetic text only; no real harness, prompts, network, or Electron',
    measurements: runs,
    interpretation: {
      peakRegistryNodeCountStable: runs[0]?.peakRegistryNodeCount === runs[1]?.peakRegistryNodeCount,
      transcriptBytesIncreaseWithFrames:
        (runs[1]?.controlledTranscriptUtf8Bytes ?? 0) > (runs[0]?.controlledTranscriptUtf8Bytes ?? 0),
      transportLimitNote:
        'This probe does not measure network queues or RSS. Production Coach server separately bounds each connection to 128 events, 2 MiB queued JSON bytes, and 1 MiB per frame.',
    },
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
