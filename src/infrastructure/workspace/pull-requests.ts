import { join } from 'node:path'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { CommandRunner } from '@/core/ports/process.js'
import { WorkspacePullRequestError, WorkspacePullRequests } from '@/core/ports/workspace-pull-requests.js'
import {
  PULL_REQUEST_DIFF_MAX_BYTES,
  type WorkspacePullRequestDetail,
  type WorkspacePullRequestRepository,
} from '@/shared/schemas/workspace-pull-requests.js'

import {
  GH_DETAIL_FIELDS,
  GH_SUMMARY_FIELDS,
  ghChecksSchema,
  ghDetailSchema,
  ghFilePatchesSchema,
  ghMutationSchema,
  ghRepositorySchema,
  ghSummarySchema,
  ghThreadOwnerSchema,
  ghThreadsSchema,
  normalizeSummary,
  REVIEW_THREADS_QUERY,
  THREAD_OWNER_QUERY,
} from './pull-requests-codecs.js'

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const fail = (code: WorkspacePullRequestError['code']) =>
  new WorkspacePullRequestError({ code, message: `Pull request operation ${code}` })
const scrubbedEnvironment = {
  GH_REPO: undefined,
  GH_HOST: undefined,
  GH_FORCE_TTY: undefined,
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
}

export const WorkspacePullRequestsLive = Layer.effect(
  WorkspacePullRequests,
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    const fs = yield* FileSystem.FileSystem
    const run = Effect.fn('WorkspacePullRequests.command')(function* (
      root: string,
      command: string,
      args: readonly string[],
      accepted: readonly number[] = [0],
    ) {
      const execution = Effect.scoped(
        Effect.gen(function* () {
          const process = yield* runner
            .start(command, args, { cwd: root, extendEnv: true, env: scrubbedEnvironment, windowsHide: true })
            .pipe(Effect.mapError(() => fail('unavailable')))
          const chunks: Uint8Array[] = []
          let size = 0
          yield* Stream.runForEach(process.stdout, chunk => {
            size += chunk.byteLength
            if (size > MAX_OUTPUT_BYTES) return Effect.fail(fail('output-limit'))
            chunks.push(chunk)
            return Effect.void
          }).pipe(Effect.mapError(error => (Schema.is(WorkspacePullRequestError)(error) ? error : fail('failed'))))
          const exitCode = yield* process.exitCode.pipe(Effect.mapError(() => fail('failed')))
          if (!accepted.includes(exitCode)) return yield* fail('failed')
          return Buffer.concat(chunks).toString('utf8')
        }),
      )
      const result = yield* execution.pipe(Effect.timeoutOption(Duration.seconds(30)))
      return Option.isSome(result) ? result.value : yield* fail('timeout')
    })
    function decode<S extends Schema.Top>(schema: S, raw: string) {
      return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(Effect.mapError(() => fail('failed')))
    }
    const repository = Effect.fn('WorkspacePullRequests.repository')(function* (root: string) {
      const raw = yield* run(root, 'gh', ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef']).pipe(
        Effect.mapError(error => (error.code === 'failed' ? fail('unavailable') : error)),
      )
      const repo = yield* decode(ghRepositorySchema, raw)
      const host = new URL(repo.url).host
      return { ...repo, host, argument: `${host}/${repo.nameWithOwner}` }
    })
    const verifiedRepository = Effect.fn('WorkspacePullRequests.verifiedRepository')(function* (
      root: string,
      expected: WorkspacePullRequestRepository,
    ) {
      const repo = yield* repository(root)
      if (
        repo.host.toLowerCase() !== expected.host.toLowerCase() ||
        repo.nameWithOwner.toLowerCase() !== expected.nameWithOwner.toLowerCase()
      )
        return yield* fail('conflict')
      return repo
    })
    const withBody = <A, E, R>(body: string, use: (file: string) => Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs
            .makeTempDirectoryScoped({ prefix: 'watchtower-pr-' })
            .pipe(Effect.mapError(() => fail('failed')))
          const file = join(directory, 'body.txt')
          yield* fs.writeFileString(file, body, { mode: 0o600 }).pipe(Effect.mapError(() => fail('failed')))
          return yield* use(file)
        }),
      )
    const api = Effect.fn('WorkspacePullRequests.api')(function* (
      root: string,
      repo: { readonly host: string },
      endpoint: string,
      data?: unknown,
      method = 'POST',
    ) {
      const args = ['api', '--hostname', repo.host, endpoint]
      if (data === undefined) return yield* run(root, 'gh', args)
      return yield* withBody(JSON.stringify(data), file =>
        run(root, 'gh', [...args, '--method', method, '--input', file]),
      )
    })
    const detail = Effect.fn('WorkspacePullRequests.detail')(function* (
      root: string,
      number: number,
      selectedRepository?: Effect.Success<ReturnType<typeof repository>>,
    ): Effect.fn.Return<WorkspacePullRequestDetail, WorkspacePullRequestError> {
      const repo = selectedRepository ?? (yield* repository(root))
      const raw = yield* run(root, 'gh', [
        'pr',
        'view',
        String(number),
        '--repo',
        repo.argument,
        '--json',
        GH_DETAIL_FIELDS,
      ])
      const data = yield* decode(ghDetailSchema, raw)
      return {
        ...normalizeSummary(data),
        repository: repo.nameWithOwner,
        repositoryIdentity: { host: repo.host, nameWithOwner: repo.nameWithOwner },
        body: data.body.slice(0, 65_536),
        headRevision: data.headRefOid,
        mergeable: data.mergeable,
        mergeStateStatus: data.mergeStateStatus,
        changedFiles: data.changedFiles,
        files: data.files.slice(0, 2000),
        filesTruncated: data.files.length < data.changedFiles || data.files.length > 2000,
        labels: data.labels.map(label => label.name),
        assignees: data.assignees.map(actor => actor.login),
        reviewers: data.reviewRequests.flatMap(actor =>
          actor.login || actor.name ? [actor.login ?? actor.name ?? ''] : [],
        ),
        comments: data.comments
          .slice(0, 100)
          .map(comment => ({ ...comment, body: comment.body.slice(0, 65_536), author: comment.author?.login ?? null })),
        reviews: data.reviews
          .slice(0, 100)
          .map(review => ({ ...review, body: review.body.slice(0, 65_536), author: review.author?.login ?? null })),
      }
    })
    const verifyThread = Effect.fn('WorkspacePullRequests.verifyThread')(function* (
      root: string,
      repo: { readonly host: string; readonly nameWithOwner: string },
      number: number,
      threadId: string,
    ) {
      const owner = yield* decode(
        ghThreadOwnerSchema,
        yield* api(root, repo, 'graphql', { query: THREAD_OWNER_QUERY, variables: { id: threadId } }),
      )
      const pullRequest = owner.data.node?.pullRequest
      if (
        !pullRequest ||
        pullRequest.number !== number ||
        pullRequest.repository.nameWithOwner.toLowerCase() !== repo.nameWithOwner.toLowerCase()
      )
        return yield* fail('not-found')
    })
    return WorkspacePullRequests.of({
      detail,
      list: Effect.fn('WorkspacePullRequests.list')(function* (root, request) {
        const repo = yield* repository(root)
        const branch = yield* run(root, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])
        const currentBranch = branch.trim() || null
        if (request.currentBranchOnly && !currentBranch)
          return {
            repository: repo.nameWithOwner,
            repositoryIdentity: { host: repo.host, nameWithOwner: repo.nameWithOwner },
            repositoryUrl: repo.url,
            defaultBranch: repo.defaultBranchRef?.name ?? null,
            currentBranch,
            items: [],
            truncated: false,
          }
        const args = [
          'pr',
          'list',
          '--repo',
          repo.argument,
          '--state',
          request.state ?? 'open',
          '--limit',
          '100',
          '--json',
          GH_SUMMARY_FIELDS,
        ]
        if (request.query) args.push('--search', request.query)
        if (request.currentBranchOnly && currentBranch) args.push('--head', currentBranch)
        const items = yield* decode(Schema.Array(ghSummarySchema), yield* run(root, 'gh', args))
        return {
          repository: repo.nameWithOwner,
          repositoryIdentity: { host: repo.host, nameWithOwner: repo.nameWithOwner },
          repositoryUrl: repo.url,
          defaultBranch: repo.defaultBranchRef?.name ?? null,
          currentBranch,
          items: items.slice(0, 100).map(normalizeSummary),
          truncated: items.length >= 100,
        }
      }),
      checks: Effect.fn('WorkspacePullRequests.checks')(function* (root, number) {
        const repo = yield* repository(root)
        const items = yield* decode(
          ghChecksSchema,
          yield* run(
            root,
            'gh',
            ['pr', 'checks', String(number), '--repo', repo.argument, '--json', 'name,state,bucket,link,workflow'],
            [0, 1, 8],
          ),
        )
        return {
          items: items.slice(0, 200).map(item => ({ ...item, link: item.link || null, workflow: item.workflow ?? '' })),
          truncated: items.length > 200,
        }
      }),
      diff: Effect.fn('WorkspacePullRequests.diff')(function* (root, number, path) {
        const repo = yield* repository(root)
        if (path !== undefined) {
          for (let page = 1; page <= 20; page += 1) {
            const files = yield* decode(
              ghFilePatchesSchema,
              yield* api(root, repo, `repos/${repo.nameWithOwner}/pulls/${number}/files?per_page=100&page=${page}`),
            )
            const file = files.find(candidate => candidate.filename === path)
            if (file) {
              const patch = file.patch ?? ''
              return {
                available: file.patch !== undefined,
                patch: Buffer.from(patch).subarray(0, PULL_REQUEST_DIFF_MAX_BYTES).toString('utf8'),
                truncated:
                  Buffer.byteLength(patch) > PULL_REQUEST_DIFF_MAX_BYTES ||
                  (file.patch !== undefined &&
                    (patch.split('\n').filter(line => line.startsWith('+')).length !== file.additions ||
                      patch.split('\n').filter(line => line.startsWith('-')).length !== file.deletions)),
              }
            }
            if (files.length < 100) return yield* fail('not-found')
          }
          return yield* fail('output-limit')
        }
        const patch = yield* run(root, 'gh', [
          'pr',
          'diff',
          String(number),
          '--repo',
          repo.argument,
          '--patch',
          '--color',
          'never',
        ])
        return {
          available: true,
          patch: Buffer.from(patch).subarray(0, PULL_REQUEST_DIFF_MAX_BYTES).toString('utf8'),
          truncated: Buffer.byteLength(patch) > PULL_REQUEST_DIFF_MAX_BYTES,
        }
      }),
      threads: Effect.fn('WorkspacePullRequests.threads')(function* (root, number, cursor) {
        const repo = yield* repository(root)
        const [owner, name] = repo.nameWithOwner.split('/')
        const response = yield* decode(
          ghThreadsSchema,
          yield* api(root, repo, 'graphql', {
            query: REVIEW_THREADS_QUERY,
            variables: { owner, name, number, cursor: cursor ?? null },
          }),
        )
        const threads = response.data.repository?.pullRequest?.reviewThreads
        if (!threads) return yield* fail('not-found')
        return {
          items: threads.nodes.map(thread => ({
            id: thread.id,
            path: thread.path,
            line: thread.line,
            resolved: thread.isResolved,
            commentsTruncated: thread.comments.pageInfo.hasNextPage,
            comments: thread.comments.nodes.map(comment => ({
              ...comment,
              body: comment.body.slice(0, 65_536),
              author: comment.author?.login ?? null,
            })),
          })),
          nextCursor: threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null,
        }
      }),
      comment: Effect.fn('WorkspacePullRequests.comment')(function* (root, request) {
        const { number, body } = request
        const repo = yield* verifiedRepository(root, request.expectedRepository)
        yield* withBody(body, file =>
          run(root, 'gh', ['pr', 'comment', String(number), '--repo', repo.argument, '--body-file', file]),
        )
      }),
      review: Effect.fn('WorkspacePullRequests.review')(function* (root, request) {
        const repo = yield* verifiedRepository(root, request.expectedRepository)
        const current = yield* detail(root, request.number, repo)
        if (current.headRevision !== request.headRevision) return yield* fail('conflict')
        if (
          (request.verdict !== 'approve' && !request.body.trim() && !request.comments?.length) ||
          (request.verdict === 'request-changes' && !request.body.trim())
        )
          return yield* fail('invalid-request')
        const events = { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' }
        yield* api(root, repo, `repos/${repo.nameWithOwner}/pulls/${request.number}/reviews`, {
          event: events[request.verdict],
          body: request.body,
          commit_id: request.headRevision,
          comments: request.comments ?? [],
        })
      }),
      reply: Effect.fn('WorkspacePullRequests.reply')(function* (root, request) {
        const { number, threadId, body } = request
        const repo = yield* verifiedRepository(root, request.expectedRepository)
        yield* verifyThread(root, repo, number, threadId)
        yield* decode(
          ghMutationSchema,
          yield* api(root, repo, 'graphql', {
            query:
              'mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}',
            variables: { id: threadId, body },
          }),
        )
      }),
      resolveThread: Effect.fn('WorkspacePullRequests.resolveThread')(function* (root, request) {
        const { number, threadId, resolved } = request
        const repo = yield* verifiedRepository(root, request.expectedRepository)
        yield* verifyThread(root, repo, number, threadId)
        const operation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
        yield* decode(
          ghMutationSchema,
          yield* api(root, repo, 'graphql', {
            query: `mutation($id:ID!){${operation}(input:{threadId:$id}){thread{id}}}`,
            variables: { id: threadId },
          }),
        )
      }),
      action: Effect.fn('WorkspacePullRequests.action')(function* (root, request) {
        const repo = yield* verifiedRepository(root, request.expectedRepository)
        const common = [String(request.number), '--repo', repo.argument]
        if (request.action === 'merge') {
          if (!request.headRevision) return yield* fail('invalid-request')
          yield* run(root, 'gh', [
            'pr',
            'merge',
            ...common,
            `--${request.mergeMethod ?? 'squash'}`,
            '--match-head-commit',
            request.headRevision,
          ])
        } else if (request.action === 'update-branch') yield* run(root, 'gh', ['pr', 'update-branch', ...common])
        else if (request.action === 'draft') yield* run(root, 'gh', ['pr', 'ready', ...common, '--undo'])
        else yield* run(root, 'gh', ['pr', request.action, ...common])
      }),
      update: Effect.fn('WorkspacePullRequests.update')(function* (root, request) {
        const repo = yield* verifiedRepository(root, request.expectedRepository)
        const args = ['pr', 'edit', String(request.number), '--repo', repo.argument]
        if (request.title !== undefined) args.push('--title', request.title)
        for (const [key, flag] of [
          ['addLabels', '--add-label'],
          ['removeLabels', '--remove-label'],
          ['addReviewers', '--add-reviewer'],
          ['removeReviewers', '--remove-reviewer'],
        ] as const) {
          for (const value of request[key] ?? []) args.push(flag, value)
        }
        if (request.body !== undefined)
          yield* withBody(request.body, file => run(root, 'gh', [...args, '--body-file', file]))
        else if (args.length > 5) yield* run(root, 'gh', args)
        else return yield* fail('invalid-request')
      }),
      create: Effect.fn('WorkspacePullRequests.create')(function* (root, request) {
        const repo = yield* verifiedRepository(root, request.expectedRepository)
        const args = ['pr', 'create', '--repo', repo.argument, '--title', request.title, '--base', request.base]
        if (request.head) args.push('--head', request.head)
        if (request.draft) args.push('--draft')
        const created = yield* withBody(request.body, file => run(root, 'gh', [...args, '--body-file', file]))
        const address = created.trim()
        const match = /\/pull\/(\d+)$/.exec(address)
        if (!match) return yield* fail('failed')
        return yield* detail(root, Number(match[1]), repo)
      }),
    })
  }),
)
