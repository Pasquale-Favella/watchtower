import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { createWorkspaceAtoms } from '../src/renderer/features/workspace/atoms.js'
import { RendererConnection } from '../src/shared/rpc/reconnecting-protocol.js'
import { type WorkspaceEventFrame, WorkspaceRpcError } from '../src/shared/rpc/workspace.js'
import type { WorkspaceExecutionEvent } from '../src/shared/schemas/workspace-store.js'

const event = (sequence: number): WorkspaceExecutionEvent => ({
  sequence,
  schemaVersion: 1,
  kind: 'runQueued',
  runId: 'run-1' as WorkspaceExecutionEvent['runId'],
  taskId: 'task-1' as WorkspaceExecutionEvent['taskId'],
  generation: 1,
  occurredAt: '2026-10-30T12:00:00Z',
  data: {},
})
const frame = (...sequences: number[]): WorkspaceEventFrame => ({
  protocolVersion: 1,
  _tag: 'Snapshot',
  throughSequence: sequences.at(-1) ?? 0,
  page: { events: sequences.map(event), highWatermark: sequences.at(-1) ?? 0, hasMore: false, nextAfterSequence: null },
})
const connectionLayer = Layer.succeed(RendererConnection, {
  current: Effect.succeed({ _tag: 'Connected' as const, generation: 1 }),
  changes: Stream.empty,
})

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

describe('workspace window subscription', () => {
  it.each(['overflow', 'disconnect', 'eof', 'gap'] as const)(
    'resumes after %s without duplicate transcript items and releases its stream on window disposal',
    async failure => {
      const registry = AtomRegistry.make()
      const cursors: number[] = []
      let released = 0
      const atoms = createWorkspaceAtoms(undefined, {
        runtime: Atom.context(),
        layer: connectionLayer,
        events: (afterSequence: number) => {
          cursors.push(afterSequence)
          let ending: Stream.Stream<never, WorkspaceRpcError | RpcClientError> = Stream.empty
          if (failure === 'overflow') {
            ending = Stream.fail(
              new WorkspaceRpcError({
                code: 'stream-overflow',
                message: 'Workspace stream exceeded its limit. Resume from the last received sequence.',
              }),
            )
          } else if (failure === 'disconnect') {
            ending = Stream.fail(
              new RpcClientError({
                reason: new RpcClientDefect({ message: 'Disconnected', cause: undefined }),
              }),
            )
          }
          const initial = failure === 'gap' ? Stream.make(frame(1, 3)) : Stream.concat(Stream.make(frame(1)), ending)
          const source = cursors.length === 1 ? initial : Stream.concat(Stream.make(frame(2, 3)), Stream.never)
          return source.pipe(
            Stream.ensuring(
              Effect.sync(() => {
                released++
              }),
            ),
          )
        },
      })
      const release = registry.mount(atoms.workspaceSubscriptionAtom)
      try {
        await waitUntil(() => registry.get(atoms.workspaceProjectionAtom).lastAppliedSequence === 3)
        expect(cursors).toEqual([0, 1])
        expect(
          registry.get(atoms.workspaceProjectionAtom).tasks['task-1']?.transcript.map(item => item.sequence),
        ).toEqual([1, 2, 3])
        expect(registry.get(atoms.workspaceStreamStateAtom).status).toBe('live')
      } finally {
        release()
        registry.dispose()
      }
      await waitUntil(() => released === 2)
    },
  )
})
