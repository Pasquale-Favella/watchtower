import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Schema from 'effect/Schema'
import { describe, expect, it, vi } from 'vitest'

import { WorkspacePullRequestError, WorkspacePullRequests } from '@/core/ports/workspace-pull-requests.js'
import { workspacePullRequestHandlers } from '@/platform/electron/main/rpc/workspace-pull-request-handlers.js'
import { WorkspacePullRequestRpcError, WorkspacePullRequestRpcGroup } from '@/shared/rpc/workspace-pull-requests.js'
import type { ProjectId } from '@/shared/schemas/workspace.js'
import * as PullRequestSchemas from '@/shared/schemas/workspace-pull-requests.js'

const expectedRepository = { host: 'github.com', nameWithOwner: 'owner/repository' }
const projectId = 'p' as ProjectId
const makeClient = RpcTest.makeClient(WorkspacePullRequestRpcGroup)
type Client = Effect.Success<typeof makeClient>

function service(overrides: Partial<WorkspacePullRequests['Service']> = {}) {
  const failure = () =>
    Effect.fail(new WorkspacePullRequestError({ code: 'failed', message: '/private/repo token:secret' }))
  return Layer.succeed(
    WorkspacePullRequests,
    WorkspacePullRequests.of({
      list: failure,
      detail: failure,
      checks: failure,
      diff: failure,
      threads: failure,
      comment: failure,
      review: failure,
      reply: failure,
      resolveThread: failure,
      action: failure,
      update: failure,
      create: failure,
      ...overrides,
    }),
  )
}

function run<A, E>(
  layer: Layer.Layer<WorkspacePullRequests>,
  use: (client: Client) => Effect.Effect<A, E>,
  refuse = false,
) {
  const handlers = workspacePullRequestHandlers({
    resolveCheckoutPath: () =>
      refuse
        ? Effect.fail(
            new WorkspacePullRequestRpcError({
              code: 'not-found',
              message: 'The pull request or checkout was not found.',
            }),
          )
        : Effect.succeed('/canonical/registered-checkout'),
  }).pipe(Layer.provide(layer))
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* makeClient
      return yield* use(client)
    }).pipe(Effect.scoped, Effect.provide(handlers)),
  )
}

describe('pull request RPC boundaries', () => {
  it('requires the displayed repository identity on every mutation schema', () => {
    const schemas: readonly Schema.Top[] = [
      PullRequestSchemas.pullRequestCommentRequestSchema,
      PullRequestSchemas.pullRequestReviewRequestSchema,
      PullRequestSchemas.pullRequestThreadReplyRequestSchema,
      PullRequestSchemas.pullRequestThreadResolutionRequestSchema,
      PullRequestSchemas.pullRequestActionRequestSchema,
      PullRequestSchemas.pullRequestUpdateRequestSchema,
      PullRequestSchemas.pullRequestCreateRequestSchema,
    ]
    const request = {
      projectId,
      number: 7,
      title: 'title',
      body: 'body',
      base: 'main',
      draft: false,
      threadId: 'thread',
      verdict: 'approve',
      headRevision: 'a'.repeat(40),
      action: 'close',
      resolved: true,
    }
    for (const schema of schemas) {
      expect(Schema.is(schema)({ ...request, expectedRepository })).toBe(true)
      expect(Schema.is(schema)(request)).toBe(false)
      expect(
        Schema.is(schema)({ ...request, expectedRepository: { ...expectedRepository, host: '../other-host' } }),
      ).toBe(false)
    }
  })

  it('redacts native diagnostic text and untyped defects', async () => {
    const failure = await run(service(), client =>
      Effect.flip(client['pull-requests:detail']({ projectId, number: 7 })),
    )
    expect(failure).toMatchObject({ code: 'failed', message: 'The pull request operation failed.' })
    expect(JSON.stringify(failure)).not.toContain('secret')
    const defect = await run(service({ detail: () => Effect.die(new Error('token:secret')) }), client =>
      Effect.flip(client['pull-requests:detail']({ projectId, number: 7 })),
    )
    expect(defect).toMatchObject({ code: 'failed' })
    expect(JSON.stringify(defect)).not.toContain('secret')
  })

  it('does not invoke the service when checkout ownership cannot be resolved', async () => {
    const list = vi.fn(() => Effect.die('must not run'))
    const result = await run(
      service({ list }),
      client => Effect.flip(client['pull-requests:list']({ projectId })),
      true,
    )
    expect(result).toMatchObject({ code: 'not-found' })
    expect(list).not.toHaveBeenCalled()
  })

  it('passes only the server-resolved root to the native service', async () => {
    const comment = vi.fn(() => Effect.void)
    await run(service({ comment }), client =>
      client['pull-requests:comment']({ projectId, expectedRepository, number: 7, body: 'Literal\ncomment' }),
    )
    expect(comment).toHaveBeenCalledWith('/canonical/registered-checkout', {
      projectId,
      expectedRepository,
      number: 7,
      body: 'Literal\ncomment',
    })
  })

  it('rejects invalid PR identities, paths and revisions before native calls', async () => {
    const diff = vi.fn(() => Effect.die('must not run'))
    const review = vi.fn(() => Effect.die('must not run'))
    const result = await run(service({ diff, review }), client =>
      Effect.all([
        Effect.exit(Effect.suspend(() => client['pull-requests:diff']({ projectId, number: 0 }))),
        Effect.exit(Effect.suspend(() => client['pull-requests:diff']({ projectId, number: 7, path: '../outside' }))),
        Effect.exit(
          Effect.suspend(() =>
            client['pull-requests:review']({
              projectId,
              expectedRepository,
              number: 7,
              headRevision: '--inject',
              body: 'body',
              verdict: 'approve',
            }),
          ),
        ),
      ]),
    )
    expect(result.every(exit => exit._tag === 'Failure')).toBe(true)
    expect(diff).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
  })
})
