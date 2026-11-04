import { existsSync, readFileSync } from 'node:fs'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { CommandRunner, type CommandStartOptions } from '@/core/ports/process.js'
import { WorkspacePullRequests } from '@/core/ports/workspace-pull-requests.js'
import { WorkspacePullRequestsLive } from '@/infrastructure/workspace/pull-requests.js'
import {
  parsePullRequestNumber,
  pullRequestReference,
} from '@/renderer/features/workspace/pull-requests/pull-request-presentation.js'
import type { ProjectId } from '@/shared/schemas/workspace.js'

const root = '/canonical/checkout'
const projectId = 'project-test' as ProjectId
const expectedRepository = { host: 'github.com', nameWithOwner: 'owner/repository' }
const head = 'a'.repeat(40)
const repository = {
  nameWithOwner: 'owner/repository',
  url: 'https://github.com/owner/repository',
  defaultBranchRef: { name: 'main' },
}
const summary = {
  number: 7,
  title: 'Fix the reader',
  url: 'https://github.com/owner/repository/pull/7',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'author' },
  headRefName: 'fix/reader',
  baseRefName: 'main',
  updatedAt: '2026-11-02T10:00:00Z',
  additions: 2,
  deletions: 1,
  reviewDecision: '',
}
const detail = {
  ...summary,
  body: 'PR body',
  headRefOid: head,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  changedFiles: 1,
  files: [{ path: 'src/reader.ts', additions: 2, deletions: 1 }],
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'maintainer' }],
  reviewRequests: [{ login: 'reviewer' }],
  comments: [],
  reviews: [],
}
interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CommandStartOptions
  readonly body?: string
}
interface Answer {
  readonly stdout: string
  readonly exitCode?: number
  readonly chunks?: readonly Uint8Array[]
}

function harness(respond: (call: Call) => Answer = () => ({ stdout: '' }), resolvedRepository = repository) {
  const calls: Call[] = []
  let finalized = 0
  const layer = CommandRunner.layerWithRunner(
    () => Effect.die('Unexpected unbounded run'),
    (command, args, options = {}) =>
      Effect.gen(function* () {
        const inputIndex = Math.max(args.indexOf('--body-file'), args.indexOf('--input'))
        const file = inputIndex >= 0 ? args[inputIndex + 1] : undefined
        const call: Call = { command, args, options, ...(file ? { body: readFileSync(file, 'utf8') } : {}) }
        calls.push(call)
        const answer =
          command === 'gh' && args[0] === 'repo'
            ? { stdout: JSON.stringify(resolvedRepository) }
            : command === 'git'
              ? { stdout: 'fix/reader\n' }
              : respond(call)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized += 1
          }),
        )
        const stdout = Stream.fromIterable(answer.chunks ?? [new TextEncoder().encode(answer.stdout)])
        return {
          pid: 1,
          exitCode: Effect.succeed(answer.exitCode ?? 0),
          isRunning: Effect.succeed(false),
          stdout,
          stderr: Stream.empty,
          all: stdout,
          kill: Effect.void,
        }
      }),
  )
  const serviceLayer = WorkspacePullRequestsLive.pipe(Layer.provide(Layer.merge(layer, NodeFileSystem.layer)))
  return {
    calls,
    get finalized() {
      return finalized
    },
    run: <A, E>(use: (service: WorkspacePullRequests['Service']) => Effect.Effect<A, E>) =>
      Effect.runPromise(Effect.flatMap(WorkspacePullRequests, use).pipe(Effect.provide(serviceLayer))),
  }
}

describe('workspace pull request services', () => {
  it('routes reads through the selected checkout and explicit repository while preserving literal search text', async () => {
    const query = 'author:me `literal` $(literal)'
    const rig = harness(() => ({ stdout: JSON.stringify([summary]) }))
    const result = await rig.run(service =>
      service.list(root, { projectId, currentBranchOnly: true, state: 'all', query }),
    )
    expect(result).toMatchObject({
      repository: 'owner/repository',
      repositoryUrl: repository.url,
      defaultBranch: 'main',
      currentBranch: 'fix/reader',
      items: [{ number: 7, state: 'open', author: 'author' }],
    })
    expect(rig.calls.every(call => call.options.cwd === root && call.options.windowsHide)).toBe(true)
    const request = rig.calls.find(call => call.args[1] === 'list')
    expect(request?.args).toEqual(
      expect.arrayContaining(['--repo', 'github.com/owner/repository', '--head', 'fix/reader', '--search', query]),
    )
    expect(request?.options.env).toMatchObject({
      GH_REPO: undefined,
      GH_HOST: undefined,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GH_PROMPT_DISABLED: '1',
    })
  })

  it('normalizes details without inventing deleted authors and reports incomplete file lists', async () => {
    const rig = harness(() => ({ stdout: JSON.stringify({ ...detail, author: null, changedFiles: 2 }) }))
    const result = await rig.run(service => service.detail(root, 7))
    expect(result).toMatchObject({
      author: null,
      headRevision: head,
      filesTruncated: true,
      labels: ['bug'],
      reviewers: ['reviewer'],
      assignees: ['maintainer'],
    })
  })

  it.each([1, 8])('keeps real check results when gh exits with failure/pending status %s', async exitCode => {
    const rig = harness(() => ({
      stdout: JSON.stringify([
        { name: 'CI', bucket: exitCode === 1 ? 'fail' : 'pending', state: 'IN_PROGRESS', link: '', workflow: null },
      ]),
      exitCode,
    }))
    expect(await rig.run(service => service.checks(root, 7))).toMatchObject({
      items: [{ name: 'CI', link: null, workflow: '' }],
    })
  })

  it('rejects a stale review before making a write and binds matching reviews to the inspected head', async () => {
    const rig = harness(call => ({ stdout: JSON.stringify(call.args[1] === 'view' ? detail : {}) }))
    const rejected = await rig.run(service =>
      Effect.flip(
        service.review(root, {
          projectId,
          expectedRepository,
          number: 7,
          verdict: 'approve',
          body: '',
          headRevision: 'b'.repeat(40),
        }),
      ),
    )
    expect(rejected.code).toBe('conflict')
    expect(rig.calls.some(call => call.args.includes('--input'))).toBe(false)
    await rig.run(service =>
      service.review(root, {
        projectId,
        expectedRepository,
        number: 7,
        verdict: 'comment',
        body: 'Review\nwith `literal` and $(literal)',
        headRevision: head,
        comments: [{ path: 'src/reader.ts', line: 2, side: 'RIGHT', body: 'Inline\ncomment' }],
      }),
    )
    const written = rig.calls.find(call => call.args.includes('--input'))
    expect(JSON.parse(written?.body ?? '')).toMatchObject({
      event: 'COMMENT',
      commit_id: head,
      body: 'Review\nwith `literal` and $(literal)',
      comments: [{ path: 'src/reader.ts', line: 2, side: 'RIGHT', body: 'Inline\ncomment' }],
    })
    const file = written?.args[(written?.args.indexOf('--input') ?? -1) + 1]
    expect(file && existsSync(file)).toBe(false)
  })

  it('requires a known revision for merging and supplies an atomic expected-head guard', async () => {
    const rig = harness()
    expect(
      await rig.run(service =>
        Effect.flip(service.action(root, { projectId, expectedRepository, number: 7, action: 'merge' })),
      ),
    ).toMatchObject({ code: 'invalid-request' })
    await rig.run(service =>
      service.action(root, {
        projectId,
        expectedRepository,
        number: 7,
        action: 'merge',
        mergeMethod: 'rebase',
        headRevision: head,
      }),
    )
    expect(rig.calls.at(-1)?.args).toEqual([
      'pr',
      'merge',
      '7',
      '--repo',
      'github.com/owner/repository',
      '--rebase',
      '--match-head-commit',
      head,
    ])
  })

  it('verifies review-thread ownership before replying or changing resolution', async () => {
    const rig = harness(call => {
      const body = JSON.parse(call.body ?? '{}') as { query?: string }
      return {
        stdout: JSON.stringify(
          body.query?.startsWith('query')
            ? { data: { node: { pullRequest: { number: 8, repository: { nameWithOwner: 'owner/repository' } } } } }
            : { data: {} },
        ),
      }
    })
    expect(
      await rig.run(service =>
        Effect.flip(
          service.reply(root, { projectId, expectedRepository, number: 7, threadId: 'thread-1', body: 'reply' }),
        ),
      ),
    ).toMatchObject({ code: 'not-found' })
    expect(rig.calls.filter(call => call.args[0] === 'api')).toHaveLength(1)
    const accepted = harness(call => {
      const body = JSON.parse(call.body ?? '{}') as { query?: string }
      return {
        stdout: JSON.stringify(
          body.query?.startsWith('query')
            ? { data: { node: { pullRequest: { number: 7, repository: { nameWithOwner: 'owner/repository' } } } } }
            : { data: { resolveReviewThread: { thread: { id: 'thread-1' } } } },
        ),
      }
    })
    await accepted.run(service =>
      service.resolveThread(root, { projectId, expectedRepository, number: 7, threadId: 'thread-1', resolved: true }),
    )
    expect(accepted.calls.filter(call => call.args[0] === 'api')).toHaveLength(2)
    expect(JSON.parse(accepted.calls.at(-1)?.body ?? '')).toMatchObject({ variables: { id: 'thread-1' } })
  })

  it('reads per-file patches and identifies absent or incomplete patches', async () => {
    const rig = harness(() => ({
      stdout: JSON.stringify([
        { filename: 'src/reader.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
      ]),
    }))
    expect(await rig.run(service => service.diff(root, 7, 'src/reader.ts'))).toMatchObject({
      available: true,
      truncated: true,
    })
    const binary = harness(() => ({
      stdout: JSON.stringify([{ filename: 'image.png', status: 'modified', additions: 0, deletions: 0 }]),
    }))
    expect(await binary.run(service => service.diff(root, 7, 'image.png'))).toEqual({
      available: false,
      patch: '',
      truncated: false,
    })
  })

  it('caps subprocess output and finalizes the owned command on overflow', async () => {
    const rig = harness(() => ({ stdout: '', chunks: [new Uint8Array(4 * 1024 * 1024), new Uint8Array(1)] }))
    expect(await rig.run(service => Effect.flip(service.checks(root, 7)))).toMatchObject({ code: 'output-limit' })
    expect(rig.finalized).toBeGreaterThan(0)
  })

  it('preserves multiline comments in scoped files and never passes a body through a shell', async () => {
    const body = 'Line one\n`backticks` $(literal) "quotes"\nLine three'
    const rig = harness()
    await rig.run(service => service.comment(root, { projectId, expectedRepository, number: 7, body }))
    const call = rig.calls.at(-1)
    expect(call?.command).toBe('gh')
    expect(call?.body).toBe(body)
    expect(call?.args).toContain('--body-file')
    expect(call?.args).not.toContain(body)
  })

  it('creates a PR explicitly without auto-pushing or switching the local checkout', async () => {
    const rig = harness(call => ({ stdout: call.args[1] === 'create' ? `${summary.url}\n` : JSON.stringify(detail) }))
    const created = await rig.run(service =>
      service.create(root, {
        projectId,
        expectedRepository,
        title: 'New PR',
        body: 'Body\ntext',
        base: 'main',
        head: 'feature',
        draft: true,
      }),
    )
    expect(created.number).toBe(7)
    expect(rig.calls.find(call => call.args[1] === 'create')?.args).toEqual(
      expect.arrayContaining(['--title', 'New PR', '--base', 'main', '--head', 'feature', '--draft', '--body-file']),
    )
    expect(rig.calls.some(call => call.command === 'git')).toBe(false)
  })

  it.each([
    { ...repository, nameWithOwner: 'other/repository', url: 'https://github.com/other/repository' },
    { ...repository, url: 'https://enterprise.example/owner/repository' },
  ])(
    'rejects every mutation when checkout discovery no longer matches the displayed repository: $url',
    async changed => {
      const mutations = [
        (service: WorkspacePullRequests['Service']) =>
          service.comment(root, { projectId, expectedRepository, number: 7, body: 'body' }),
        (service: WorkspacePullRequests['Service']) =>
          service.review(root, {
            projectId,
            expectedRepository,
            number: 7,
            verdict: 'approve',
            body: '',
            headRevision: head,
          }),
        (service: WorkspacePullRequests['Service']) =>
          service.reply(root, { projectId, expectedRepository, number: 7, threadId: 'thread', body: 'reply' }),
        (service: WorkspacePullRequests['Service']) =>
          service.resolveThread(root, { projectId, expectedRepository, number: 7, threadId: 'thread', resolved: true }),
        (service: WorkspacePullRequests['Service']) =>
          service.action(root, { projectId, expectedRepository, number: 7, action: 'merge', headRevision: head }),
        (service: WorkspacePullRequests['Service']) =>
          service.action(root, { projectId, expectedRepository, number: 7, action: 'close' }),
        (service: WorkspacePullRequests['Service']) =>
          service.action(root, { projectId, expectedRepository, number: 7, action: 'update-branch' }),
        (service: WorkspacePullRequests['Service']) =>
          service.update(root, { projectId, expectedRepository, number: 7, title: 'new title' }),
        (service: WorkspacePullRequests['Service']) =>
          service
            .create(root, { projectId, expectedRepository, title: 'title', body: '', base: 'main', draft: false })
            .pipe(Effect.asVoid),
      ]
      for (const mutation of mutations) {
        const rig = harness(() => ({ stdout: JSON.stringify(detail) }), changed)
        expect(await rig.run(service => Effect.flip(mutation(service)))).toMatchObject({ code: 'conflict' })
        expect(rig.calls).toHaveLength(1)
        expect(rig.calls[0].args).toEqual(['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'])
      }
    },
  )

  it('uses one verified repository for both review inspection and submission', async () => {
    const rig = harness(call => ({ stdout: JSON.stringify(call.args[1] === 'view' ? detail : {}) }))
    await rig.run(service =>
      service.review(root, {
        projectId,
        expectedRepository,
        number: 7,
        verdict: 'approve',
        body: '',
        headRevision: head,
      }),
    )
    expect(rig.calls.filter(call => call.args[0] === 'repo')).toHaveLength(1)
    expect(rig.calls.at(-1)?.args).toContain('repos/owner/repository/pulls/7/reviews')
    expect(rig.calls.at(-1)?.args).toEqual(expect.arrayContaining(['--hostname', 'github.com']))
  })

  it('rejects malformed native responses through the typed failure channel', async () => {
    const rig = harness(() => ({ stdout: 'not json with /private/credentials' }))
    expect(await rig.run(service => Effect.flip(service.detail(root, 7)))).toMatchObject({ code: 'failed' })
  })
})

describe('pull request references', () => {
  it('accepts current-repository numbers/URLs and rejects unrelated URLs', () => {
    expect(parsePullRequestNumber('#7', repository.url)).toBe(7)
    expect(parsePullRequestNumber(summary.url, repository.url)).toBe(7)
    expect(parsePullRequestNumber('https://other.invalid/owner/repository/pull/7', repository.url)).toBeNull()
    expect(parsePullRequestNumber('https://github.com/other/repository/pull/7', repository.url)).toBeNull()
    expect(parsePullRequestNumber('0')).toBeNull()
    expect(parsePullRequestNumber('999999999999999999999')).toBeNull()
    expect(pullRequestReference(7, 'Fix', summary.url, ' selected text ')).toBe(
      `Pull request #7: Fix\n${summary.url}\n\nselected text`,
    )
  })
})
