import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Schema from 'effect/Schema'
import { describe, expect, it, vi } from 'vitest'

import { CheckoutInspection, CheckoutInspectionError } from '@/core/ports/checkout-inspection.js'
import { checkoutInspectionHandlers } from '@/platform/electron/main/rpc/checkout-inspection-handlers.js'
import { CheckoutInspectionRpcError, CheckoutInspectionRpcGroup } from '@/shared/rpc/checkout-inspection.js'
import { projectIdSchema, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'

const projectId = Schema.decodeUnknownSync(projectIdSchema)('project-1')
const missingCheckout = Schema.decodeUnknownSync(workspaceCheckoutIdSchema)('missing')
const siblingCheckout = Schema.decodeUnknownSync(workspaceCheckoutIdSchema)('checkout-2')
const leaked = 'fatal: /private/user/checkout: unable to read tree'
const emptyFile = { path: 'x', size: 0, binary: false, content: '', truncated: false }

const clientEffect = RpcTest.makeClient(CheckoutInspectionRpcGroup)
type Client = Effect.Success<typeof clientEffect>

/** The typed failure in an exit. Defects and request-decoding throws carry none. */
const typedFailure = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

/** Every operation fails with diagnostic text unless a test overrides it. */
function fakeInspection(overrides: Partial<CheckoutInspection['Service']> = {}) {
  const diagnostic = (code: CheckoutInspectionError['code']) =>
    Effect.fail(new CheckoutInspectionError({ code, message: leaked }))
  return Layer.succeed(
    CheckoutInspection,
    CheckoutInspection.of({
      diffPreview: () => diagnostic('failed'),
      filePatch: () => diagnostic('failed'),
      branches: () => diagnostic('failed'),
      listEntries: () => diagnostic('failed'),
      readFile: () => diagnostic('failed'),
      ...overrides,
    }),
  )
}

const resolveCheckoutPath = (request: { readonly checkoutId?: string | undefined }) =>
  request.checkoutId === missingCheckout
    ? Effect.fail(new CheckoutInspectionRpcError({ code: 'not-found', message: 'Checkout record was not found.' }))
    : Effect.succeed('/canonical/checkout')

/** Runs one body against the real RPC group, with handlers wired to the fake service and resolver. */
function run<A, E>(
  inspection: Layer.Layer<CheckoutInspection>,
  body: (client: Client) => Effect.Effect<A, E>,
): Promise<A> {
  const handlers = checkoutInspectionHandlers({ resolveCheckoutPath }).pipe(Layer.provide(inspection))
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* clientEffect
      return yield* body(client)
    }).pipe(Effect.scoped, Effect.provide(handlers)),
  )
}

describe('checkout inspection RPC handlers', () => {
  it('replaces diagnostic text with fixed messages and never forwards Git output', async () => {
    const error = await run(fakeInspection(), client =>
      Effect.flip(client['checkout:diffPreview']({ projectId, source: { kind: 'working-tree' } })),
    )
    expect(error).toBeInstanceOf(CheckoutInspectionRpcError)
    expect(error).toMatchObject({ code: 'failed', message: 'Checkout inspection failed.' })
    expect(JSON.stringify(error)).not.toContain('private')
    expect(JSON.stringify(error)).not.toContain('fatal')
  })

  it('maps known core codes to their fixed RPC messages', async () => {
    const error = await run(
      fakeInspection({
        branches: () => Effect.fail(new CheckoutInspectionError({ code: 'not-repository', message: leaked })),
      }),
      client => Effect.flip(client['checkout:branches']({ projectId })),
    )
    expect(error).toMatchObject({ code: 'not-repository', message: 'Not a Git repository.' })
    expect(JSON.stringify(error)).not.toContain('private')
  })

  it('maps untyped defects to the generic failure', async () => {
    const error = await run(fakeInspection({ readFile: () => Effect.die(new Error(leaked)) }), client =>
      Effect.flip(client['checkout:readFile']({ projectId, path: 'README.md' })),
    )
    expect(error).toMatchObject({ code: 'failed', message: 'Checkout inspection failed.' })
    expect(JSON.stringify(error)).not.toContain('private')
  })

  it('passes resolver failures through and never reaches the inspection service', async () => {
    const readFile = vi.fn(() => Effect.succeed(emptyFile))
    const error = await run(fakeInspection({ readFile }), client =>
      Effect.flip(client['checkout:readFile']({ projectId, checkoutId: missingCheckout, path: 'x' })),
    )
    expect(error).toMatchObject({ code: 'not-found', message: 'Checkout record was not found.' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('resolves each request through the injected checkout path only', async () => {
    const seen: string[] = []
    const listEntries = vi.fn((root: string, path: string) => {
      seen.push(root)
      return Effect.succeed({ path, entries: [], truncated: false })
    })
    const result = await run(fakeInspection({ listEntries }), client =>
      client['checkout:listEntries']({ projectId, checkoutId: siblingCheckout, path: 'src' }),
    )
    expect(result).toEqual({ path: 'src', entries: [], truncated: false })
    expect(seen).toEqual(['/canonical/checkout'])
  })

  it('rejects paths that leave the checkout before any handler runs', async () => {
    const readFile = vi.fn(() => Effect.succeed(emptyFile))
    const exit = await run(fakeInspection({ readFile }), client =>
      Effect.exit(Effect.suspend(() => client['checkout:readFile']({ projectId, path: '../outside.txt' }))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(typedFailure(exit)).not.toBeInstanceOf(CheckoutInspectionRpcError)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects absolute, parent-segment and option-like inputs at the request boundary', async () => {
    const filePatch = vi.fn(() => Effect.succeed({ binary: false, patch: '', truncated: false }))
    const diffPreview = vi.fn(() =>
      Effect.succeed({
        id: 'x',
        kind: 'branch-range' as const,
        title: '',
        baseRef: null,
        headRef: null,
        files: [],
        truncated: false,
      }),
    )
    const exits = await run(fakeInspection({ filePatch, diffPreview }), client =>
      Effect.all([
        Effect.exit(
          Effect.suspend(() =>
            client['checkout:filePatch']({ projectId, source: { kind: 'working-tree' }, path: 'C:\\secret.txt' }),
          ),
        ),
        Effect.exit(
          Effect.suspend(() =>
            client['checkout:filePatch']({ projectId, source: { kind: 'working-tree' }, path: 'src/../../x' }),
          ),
        ),
        Effect.exit(
          Effect.suspend(() =>
            client['checkout:diffPreview']({
              projectId,
              source: { kind: 'branch-range', baseRef: '--output=/tmp/x' },
            }),
          ),
        ),
      ]),
    )
    const settled: ReadonlyArray<Exit.Exit<unknown, unknown>> = exits
    for (const exit of settled) {
      expect(Exit.isFailure(exit)).toBe(true)
      expect(typedFailure(exit)).not.toBeInstanceOf(CheckoutInspectionRpcError)
    }
    expect(filePatch).not.toHaveBeenCalled()
    expect(diffPreview).not.toHaveBeenCalled()
  })
})
