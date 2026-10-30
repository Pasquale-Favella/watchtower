import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { HarnessConnectionResolver } from '@/core/ports/harness-connections.js'
import type { HarnessConnection } from '@/shared/schemas/harness-connections.js'

const resolve = (definitions: ReadonlyArray<HarnessConnection>, id: string, driverId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const resolver = yield* HarnessConnectionResolver
      return yield* resolver.resolve(id, driverId)
    }).pipe(Effect.provide(HarnessConnectionResolver.layer(definitions))),
  )

const acquireResolver = (layer: ReturnType<typeof HarnessConnectionResolver.layer>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* HarnessConnectionResolver
    }).pipe(Effect.provide(layer)),
  )

describe('HarnessConnectionResolver', () => {
  it('forwards ACP command and arguments in order through the driver connect options', async () => {
    await expect(
      resolve(
        [{ id: 'work-acp', driverId: 'acp', command: 'custom-acp', args: ['--mode', 'stdio', 'two words'] }],
        'work-acp',
        'acp',
      ),
    ).resolves.toEqual({
      connectionId: 'work-acp',
      configuration: { command: 'custom-acp', argsJson: '["--mode","stdio","two words"]' },
    })
  })

  it('keeps the requested connection and exact driver identity', async () => {
    const definitions: HarnessConnection[] = [
      { id: 'codex-local', driverId: 'codex-app-server', command: 'codex-custom' },
      { id: 'claude-local', driverId: 'claude-agent-sdk' },
    ]
    await expect(resolve(definitions, 'codex-local', 'codex-app-server')).resolves.toEqual({
      connectionId: 'codex-local',
      configuration: { command: 'codex-custom' },
    })
    await expect(resolve(definitions, 'codex-local', 'claude-agent-sdk')).rejects.toMatchObject({
      _tag: 'HarnessConnectionResolutionError',
      code: 'driver-mismatch',
    })
  })

  it('rejects duplicate IDs and missing connections with typed errors', async () => {
    const duplicateLayer = HarnessConnectionResolver.layer([
      { id: 'duplicate', driverId: 'claude-agent-sdk' },
      { id: 'duplicate', driverId: 'codex-app-server' },
    ])

    await expect(acquireResolver(duplicateLayer)).rejects.toMatchObject({
      _tag: 'HarnessConnectionResolutionError',
      code: 'duplicate-id',
    })

    await expect(
      resolve([{ id: 'known', driverId: 'claude-agent-sdk' }], 'missing', 'claude-agent-sdk'),
    ).rejects.toMatchObject({
      _tag: 'HarnessConnectionResolutionError',
      code: 'not-found',
    })
  })

  it('rejects unsupported fields and secret values outside reference fields', async () => {
    await expect(
      resolve(
        [{ id: 'unsafe', driverId: 'claude-agent-sdk', apiKey: 'plaintext-secret' } as unknown as HarnessConnection],
        'unsafe',
        'claude-agent-sdk',
      ),
    ).rejects.toMatchObject({ _tag: 'HarnessConnectionResolutionError', code: 'invalid-definition' })

    await expect(
      resolve(
        [{ id: 'credential-arg', driverId: 'acp', command: 'agent', args: ['--api-key=sk-examplecredential'] }],
        'credential-arg',
        'acp',
      ),
    ).rejects.toMatchObject({ _tag: 'HarnessConnectionResolutionError', code: 'invalid-definition' })
  })

  it('copies and freezes nested configuration so later caller mutation has no effect', async () => {
    const args = ['--stdio']
    const definition = { id: 'immutable', driverId: 'acp', command: 'agent', args }
    const resolver = HarnessConnectionResolver.layer([definition as HarnessConnection])
    args[0] = '--changed'
    definition.command = 'changed-agent'

    const options = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HarnessConnectionResolver
        return yield* service.resolve('immutable', 'acp')
      }).pipe(Effect.provide(resolver)),
    )
    expect(options).toEqual({
      connectionId: 'immutable',
      configuration: { command: 'agent', argsJson: '["--stdio"]' },
    })
    expect(Object.isFrozen(options)).toBe(true)
    expect(Object.isFrozen(options.configuration)).toBe(true)
  })

  it('rejects secret references until the driver can resolve them instead of using ambient authentication', async () => {
    await expect(
      resolve(
        [{ id: 'keychain', driverId: 'acp', command: 'agent', args: [], secretReferences: ['keychain://token'] }],
        'keychain',
        'acp',
      ),
    ).rejects.toMatchObject({ _tag: 'HarnessConnectionResolutionError', code: 'unsupported-secret-reference' })
  })

  it('accepts ASCII control arguments under budget and rejects JSON UTF-8 aggregate overflow', async () => {
    await expect(
      resolve([{ id: 'control', driverId: 'acp', command: 'agent', args: ['\u0001'] }], 'control', 'acp'),
    ).resolves.toMatchObject({ configuration: { argsJson: '["\\u0001"]' } })

    const tooLargeArgs = Array.from({ length: 4 }, () => 'é'.repeat(8192))
    await expect(
      resolve([{ id: 'oversized', driverId: 'acp', command: 'agent', args: tooLargeArgs }], 'oversized', 'acp'),
    ).rejects.toMatchObject({ _tag: 'HarnessConnectionResolutionError', code: 'invalid-definition' })
  })
})
