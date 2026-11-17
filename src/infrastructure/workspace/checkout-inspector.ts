import { open, readlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Semaphore from 'effect/Semaphore'

import {
  type CheckoutFilePatchRequest,
  CheckoutInspection,
  CheckoutInspectionError,
  type CheckoutReadOptions,
  type CheckoutWriteFileRequest,
} from '@/core/ports/checkout-inspection.js'
import { CommandRunner } from '@/core/ports/process.js'
import {
  CHECKOUT_BRANCH_LIMIT,
  CHECKOUT_COMMIT_LIMIT,
  CHECKOUT_DIFF_FILE_LIMIT,
  CHECKOUT_DIRECTORY_ENTRY_LIMIT,
  CHECKOUT_FILE_MAX_BYTES,
  CHECKOUT_PATCH_MAX_BYTES,
  CHECKOUT_PREVIEW_MAX_BYTES,
  CHECKOUT_UNTRACKED_SCAN_LIMIT,
  type CheckoutBranchList,
  type CheckoutCommitList,
  type DiffFile,
  type DiffSource,
  type DiffSourceSelector,
  type DirectoryEntry,
  type DirectoryListing,
  type FileContent,
  type FilePatch,
  isContainedCheckoutPath,
} from '@/shared/schemas/checkout-inspection.js'

import {
  type CommandRunnerService,
  compareText,
  emptyTreeRevision,
  gitLine,
  type GitResult,
  type NameStatusEntry,
  type NumstatEntry,
  parseNameStatusZ,
  parseNulList,
  parseNumstatZ,
  runGit,
} from './checkout-inspector-git.js'
import {
  canonicalPath,
  decodeUtf8,
  entryMetadata,
  looksBinary,
  readBoundedFile,
  readDirectoryEntries,
  regularFileSize,
  resolveContainedPath,
  resolveInCanonicalRoot,
} from './checkout-inspector-paths.js'

interface RepositoryState {
  /** Canonical checkout path. Git commands run here. */
  readonly root: string
  /** True only when the checkout is the top level of a Git work tree. */
  readonly repository: boolean
}

interface ChangeEntry extends NumstatEntry {
  readonly status: NameStatusEntry['status']
  readonly path: string
  readonly previousPath?: string
}

interface ResolvedBase {
  readonly name: string
  readonly commit: string
}

const fail = (code: CheckoutInspectionError['code'], message: string) => new CheckoutInspectionError({ code, message })

const repositoryState = Effect.fn('CheckoutInspection.repositoryState')(function* (
  runner: CommandRunnerService,
  root: string,
): Effect.fn.Return<RepositoryState, CheckoutInspectionError> {
  const canonical = yield* canonicalPath(root)
  const inside = yield* runGit(runner, canonical, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return { root: canonical, repository: false }
  const top = yield* gitLine(runner, canonical, ['rev-parse', '--show-toplevel'])
  const topCanonical = yield* canonicalPath(top)
  return { root: canonical, repository: topCanonical === canonical }
})

const requireRepository = Effect.fn('CheckoutInspection.requireRepository')(function* (
  runner: CommandRunnerService,
  root: string,
): Effect.fn.Return<string, CheckoutInspectionError> {
  const state = yield* repositoryState(runner, root)
  if (!state.repository) return yield* fail('not-repository', 'Checkout is not a Git repository top level')
  return state.root
})

const currentBranch = Effect.fn('CheckoutInspection.currentBranch')(function* (
  runner: CommandRunnerService,
  cwd: string,
): Effect.fn.Return<string | null, CheckoutInspectionError> {
  const result = yield* runGit(runner, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return result.exitCode === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null
})

const verifiedCommit = Effect.fn('CheckoutInspection.verifiedCommit')(function* (
  runner: CommandRunnerService,
  cwd: string,
  ref: string,
): Effect.fn.Return<string | null, CheckoutInspectionError> {
  const result = yield* runGit(runner, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return result.exitCode === 0 && !result.truncated ? result.stdout.trim() : null
})

/** origin/HEAD first, then the conventional local defaults. */
const defaultBaseName = Effect.fn('CheckoutInspection.defaultBaseName')(function* (
  runner: CommandRunnerService,
  cwd: string,
): Effect.fn.Return<string | null, CheckoutInspectionError> {
  const remoteHead = yield* runGit(runner, cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const remoteName = remoteHead.exitCode === 0 ? remoteHead.stdout.trim() : ''
  if (remoteName && (yield* verifiedCommit(runner, cwd, remoteName)) !== null) return remoteName
  for (const name of ['main', 'master']) {
    if ((yield* verifiedCommit(runner, cwd, `refs/heads/${name}`)) !== null) return name
  }
  return null
})

const resolveBase = Effect.fn('CheckoutInspection.resolveBase')(function* (
  runner: CommandRunnerService,
  cwd: string,
  requested: string | undefined,
): Effect.fn.Return<ResolvedBase, CheckoutInspectionError> {
  const name = requested ?? (yield* defaultBaseName(runner, cwd))
  if (!name) return yield* fail('base-unavailable', 'No base branch could be selected')
  const commit = yield* verifiedCommit(runner, cwd, name)
  if (commit === null) return yield* fail('base-unavailable', 'The base branch does not exist in this checkout')
  return { name, commit }
})

const mergeBaseOf = Effect.fn('CheckoutInspection.mergeBaseOf')(function* (
  runner: CommandRunnerService,
  cwd: string,
  head: string,
  base: string,
): Effect.fn.Return<string, CheckoutInspectionError> {
  const result = yield* runGit(runner, cwd, ['merge-base', head, base])
  if (result.exitCode === 1) return yield* fail('base-unavailable', 'The base branch shares no history with HEAD')
  if (result.exitCode !== 0 || result.truncated) return yield* fail('failed', 'Git could not find a merge base')
  return result.stdout.trim()
})

/** The base a branch range compares from: the merge-base of HEAD and the chosen base branch. */
const branchRangeBase = Effect.fn('CheckoutInspection.branchRangeBase')(function* (
  runner: CommandRunnerService,
  cwd: string,
  head: string | null,
  requested: string | undefined,
): Effect.fn.Return<{ readonly base: ResolvedBase; readonly revision: string }, CheckoutInspectionError> {
  if (head === null) return yield* fail('base-unavailable', 'The repository has no commits to compare')
  const base = yield* resolveBase(runner, cwd, requested)
  const revision = yield* mergeBaseOf(runner, cwd, head, base.commit)
  return { base, revision }
})

/** Counts added lines the way `git diff --numstat` does: a final unterminated line also counts. */
const countTextFile = (absolute: string) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(absolute, 'r')
      try {
        const chunk = Buffer.alloc(64 * 1024)
        let newlines = 0
        let size = 0
        let last = -1
        let binary = false
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
          if (bytesRead === 0) break
          if (size === 0 && looksBinary(chunk.subarray(0, bytesRead))) binary = true
          for (let index = 0; index < bytesRead; index += 1) if (chunk[index] === 0x0a) newlines += 1
          last = chunk[bytesRead - 1] ?? last
          size += bytesRead
          // Counting stops where a patch would truncate, so one large untracked file cannot stall the preview.
          if (binary || size >= CHECKOUT_PATCH_MAX_BYTES) break
        }
        const unterminated = last === 0x0a ? 0 : 1
        const additions = binary || size === 0 ? 0 : newlines + unterminated
        return { binary, additions }
      } finally {
        await handle.close()
      }
    },
    catch: () => fail('path-not-found', 'The untracked file could not be read'),
  })

/** Untracked files are added content. Symbolic links report their target text without being followed. */
const untrackedChange = Effect.fn('CheckoutInspection.untrackedChange')(function* (
  cwd: string,
  path: string,
): Effect.fn.Return<ChangeEntry | null> {
  const metadata = yield* entryMetadata(join(cwd, path)).pipe(Effect.option)
  if (Option.isNone(metadata)) return null
  if (metadata.value.isSymbolicLink()) return { status: 'added', path, additions: 1, deletions: 0, binary: false }
  if (!metadata.value.isFile()) return null
  const contained = yield* resolveInCanonicalRoot(cwd, path).pipe(Effect.option)
  if (Option.isNone(contained)) return null
  const counted = yield* countTextFile(contained.value.absolute).pipe(Effect.option)
  if (Option.isNone(counted)) return null
  return { status: 'added', path, additions: counted.value.additions, deletions: 0, binary: counted.value.binary }
})

const collectChanges = Effect.fn('CheckoutInspection.collectChanges')(function* (
  runner: CommandRunnerService,
  cwd: string,
  comparison: readonly string[],
  includeUntracked = true,
  ignoreWhitespace = false,
): Effect.fn.Return<{ readonly files: readonly DiffFile[]; readonly truncated: boolean }, CheckoutInspectionError> {
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', ...(ignoreWhitespace ? ['-w'] : [])]
  const numstat = yield* runGit(runner, cwd, ['diff', ...flags, '--numstat', '-z', ...comparison, '--'])
  const nameStatus = yield* runGit(runner, cwd, ['diff', ...flags, '--name-status', '-z', ...comparison, '--'])
  if (numstat.exitCode !== 0 || nameStatus.exitCode !== 0)
    return yield* fail('failed', 'Git could not compare the checkout')
  let truncated = numstat.truncated || nameStatus.truncated
  const stats = parseNumstatZ(numstat.stdout)
  const tracked: ChangeEntry[] = parseNameStatusZ(nameStatus.stdout).map(entry => ({
    ...entry,
    ...(stats.get(entry.path) ?? { additions: 0, deletions: 0, binary: false }),
  }))

  const untracked = includeUntracked
    ? yield* runGit(runner, cwd, ['ls-files', '-z', '--others', '--exclude-standard'])
    : { exitCode: 0, stdout: '', truncated: false }
  if (untracked.exitCode !== 0) return yield* fail('failed', 'Git could not list untracked files')
  truncated = truncated || untracked.truncated
  let untrackedPaths = parseNulList(untracked.stdout).filter(path => !path.endsWith('/'))
  if (untrackedPaths.length > CHECKOUT_UNTRACKED_SCAN_LIMIT) {
    truncated = true
    untrackedPaths = untrackedPaths.slice(0, CHECKOUT_UNTRACKED_SCAN_LIMIT)
  }
  const scanned = yield* Effect.forEach(untrackedPaths, path => untrackedChange(cwd, path), { concurrency: 8 })
  const changes = [...tracked, ...scanned.filter((entry): entry is ChangeEntry => entry !== null)].sort((a, b) =>
    compareText(a.path, b.path),
  )
  if (changes.length > CHECKOUT_DIFF_FILE_LIMIT) truncated = true
  const files = changes.slice(0, CHECKOUT_DIFF_FILE_LIMIT).map((entry): DiffFile => ({
    path: entry.path,
    ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
    status: entry.status,
    additions: entry.additions,
    deletions: entry.deletions,
    binary: entry.binary,
  }))
  return { files, truncated }
})

const diffPreview = Effect.fn('CheckoutInspection.diffPreview')(function* (
  runner: CommandRunnerService,
  root: string,
  source: DiffSourceSelector,
): Effect.fn.Return<DiffSource, CheckoutInspectionError> {
  const cwd = yield* requireRepository(runner, root)
  const head = yield* verifiedCommit(runner, cwd, 'HEAD')
  const headRef = yield* currentBranch(runner, cwd)
  if (source.kind === 'working-tree') {
    const base = head ?? (yield* emptyTreeRevision(runner, cwd))
    const changes = yield* collectChanges(runner, cwd, [base], true, source.ignoreWhitespace)
    return {
      id: 'working-tree',
      kind: 'working-tree',
      title: 'Uncommitted changes',
      baseRef: head === null ? null : 'HEAD',
      headRef,
      files: [...changes.files],
      truncated: changes.truncated,
    }
  }
  if (source.kind === 'staged') {
    const base = head ?? (yield* emptyTreeRevision(runner, cwd))
    const changes = yield* collectChanges(runner, cwd, ['--cached', base], false, source.ignoreWhitespace)
    return {
      id: 'staged',
      kind: 'staged',
      title: 'Staged changes',
      baseRef: head === null ? null : 'HEAD',
      headRef,
      files: [...changes.files],
      truncated: changes.truncated,
    }
  }
  if (source.kind === 'commit') {
    const revision = yield* verifiedCommit(runner, cwd, source.commit)
    if (revision === null) return yield* fail('base-unavailable', 'The commit does not exist in this checkout')
    const parent = (yield* verifiedCommit(runner, cwd, `${revision}^`)) ?? (yield* emptyTreeRevision(runner, cwd))
    const changes = yield* collectChanges(runner, cwd, [parent, revision], false, source.ignoreWhitespace)
    return {
      id: `commit:${revision}`,
      kind: 'commit',
      title: `Commit ${revision.slice(0, 8)}`,
      baseRef: parent,
      headRef: revision,
      files: [...changes.files],
      truncated: changes.truncated,
    }
  }
  const range = yield* branchRangeBase(runner, cwd, head, source.baseRef)
  const changes = yield* collectChanges(runner, cwd, [range.revision], true, source.ignoreWhitespace)
  return {
    id: `branch-range:${range.base.name}`,
    kind: 'branch-range',
    title: `Changes since ${range.base.name}`,
    baseRef: range.base.name,
    headRef,
    files: [...changes.files],
    truncated: changes.truncated,
  }
})

const patchBaseRevision = Effect.fn('CheckoutInspection.patchBaseRevision')(function* (
  runner: CommandRunnerService,
  cwd: string,
  source: DiffSourceSelector,
): Effect.fn.Return<string, CheckoutInspectionError> {
  const head = yield* verifiedCommit(runner, cwd, 'HEAD')
  if (source.kind === 'working-tree' || source.kind === 'staged') return head ?? (yield* emptyTreeRevision(runner, cwd))
  if (source.kind === 'commit') {
    const revision = yield* verifiedCommit(runner, cwd, source.commit)
    if (revision === null) return yield* fail('base-unavailable', 'The commit does not exist in this checkout')
    return (yield* verifiedCommit(runner, cwd, `${revision}^`)) ?? (yield* emptyTreeRevision(runner, cwd))
  }
  return (yield* branchRangeBase(runner, cwd, head, source.baseRef)).revision
})

/** Builds the unified diff Git would print for a new file, bounded to the patch budget. */
function addedFilePatch(path: string, text: string, mode: '100644' | '120000', truncated: boolean): string {
  const header = `diff --git a/${path} b/${path}\nnew file mode ${mode}\n`
  if (text === '') return header
  const endsWithNewline = text.endsWith('\n')
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n')
  const body = lines.map(line => `+${line}\n`).join('')
  const marker = endsWithNewline || truncated ? '' : '\\ No newline at end of file\n'
  return `${header}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}${marker}`
}

const untrackedPatch = Effect.fn('CheckoutInspection.untrackedPatch')(function* (
  cwd: string,
  path: string,
  includeContents = false,
): Effect.fn.Return<FilePatch, CheckoutInspectionError> {
  const metadata = yield* entryMetadata(join(cwd, path))
  if (metadata.isSymbolicLink()) {
    const target = yield* Effect.tryPromise({
      try: () => readlink(join(cwd, path)),
      catch: () => fail('path-not-found', 'The link could not be read'),
    })
    const patch = toPatch(addedFilePatch(path, target, '120000', false), false)
    return includeContents ? { ...patch, oldContent: '', newContent: target } : patch
  }
  const contained = yield* resolveContainedPath(cwd, path)
  const read = yield* readBoundedFile(contained.absolute, CHECKOUT_FILE_MAX_BYTES)
  if (looksBinary(read.bytes)) return { binary: true, patch: '', truncated: false }
  const text = decodeUtf8(read.bytes, read.truncated)
  if (text === null) return { binary: true, patch: '', truncated: false }
  const patch = toPatch(addedFilePatch(path, text, '100644', read.truncated), read.truncated)
  return includeContents && !patch.truncated ? { ...patch, oldContent: '', newContent: text } : patch
})

/** Caps the patch text to its byte budget; a cut at a multi-byte boundary decodes as a replacement character. */
function toPatch(patch: string, truncated: boolean): FilePatch {
  const bytes = Buffer.from(patch, 'utf8')
  if (bytes.length <= CHECKOUT_PATCH_MAX_BYTES) return { binary: false, patch, truncated }
  return { binary: false, patch: bytes.subarray(0, CHECKOUT_PATCH_MAX_BYTES).toString('utf8'), truncated: true }
}

const filePatch = Effect.fn('CheckoutInspection.filePatch')(function* (
  runner: CommandRunnerService,
  root: string,
  request: CheckoutFilePatchRequest,
): Effect.fn.Return<FilePatch, CheckoutInspectionError> {
  const paths = request.previousPath === undefined ? [request.path] : [request.path, request.previousPath]
  if (!paths.every(path => isContainedCheckoutPath(path)))
    return yield* fail('outside-checkout', 'Paths must stay inside the checkout')
  const cwd = yield* requireRepository(runner, root)
  if (request.source.kind === 'working-tree' || request.source.kind === 'branch-range') {
    const untracked = yield* runGit(runner, cwd, [
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
      '--',
      request.path,
    ])
    if (untracked.exitCode === 0 && parseNulList(untracked.stdout).includes(request.path)) {
      return yield* untrackedPatch(cwd, request.path, request.includeContents)
    }
  }
  const base = yield* patchBaseRevision(runner, cwd, request.source)
  const result = yield* runGit(
    runner,
    cwd,
    [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '-M',
      `-U${request.contextLines ?? 3}`,
      ...(request.source.ignoreWhitespace ? ['-w'] : []),
      ...(request.source.kind === 'staged'
        ? ['--cached', base]
        : request.source.kind === 'commit'
          ? [base, request.source.commit]
          : [base]),
      '--',
      ...paths,
    ],
    CHECKOUT_PATCH_MAX_BYTES,
  )
  if (result.exitCode !== 0 && !result.truncated) return yield* fail('failed', 'Git could not produce the patch')
  if (/^Binary files .+ differ$/m.test(result.stdout) || /^GIT binary patch$/m.test(result.stdout))
    return { binary: true, patch: '', truncated: false }
  const patch: FilePatch = { binary: false, patch: result.stdout, truncated: result.truncated }
  if (!request.includeContents || patch.truncated || patch.patch === '') return patch
  const oldContent = yield* gitFileContent(runner, cwd, base, request.previousPath ?? request.path)
  let newContent: string | null
  if (request.source.kind === 'commit')
    newContent = yield* gitFileContent(runner, cwd, request.source.commit, request.path)
  else if (request.source.kind === 'staged') newContent = yield* gitFileContent(runner, cwd, '', request.path)
  else {
    const current = yield* readFile(runner, cwd, request.path).pipe(Effect.option)
    newContent = Option.isSome(current) ? current.value.content : ''
  }
  return { ...patch, ...(oldContent === null ? {} : { oldContent }), ...(newContent === null ? {} : { newContent }) }
})

const gitFileContent = Effect.fn('CheckoutInspection.gitFileContent')(function* (
  runner: CommandRunnerService,
  cwd: string,
  revision: string,
  path: string,
): Effect.fn.Return<string | null, CheckoutInspectionError> {
  const result = yield* runGit(runner, cwd, ['show', `${revision}:${path}`], CHECKOUT_FILE_MAX_BYTES)
  if (result.exitCode !== 0) return ''
  if (result.truncated || result.stdout.includes('\0') || result.stdout.includes('\uFFFD')) return null
  return result.stdout
})

const commits = Effect.fn('CheckoutInspection.commits')(function* (
  runner: CommandRunnerService,
  root: string,
): Effect.fn.Return<CheckoutCommitList, CheckoutInspectionError> {
  const cwd = yield* requireRepository(runner, root)
  if ((yield* verifiedCommit(runner, cwd, 'HEAD')) === null) return { items: [], truncated: false }
  const result = yield* runGit(runner, cwd, [
    'log',
    `--max-count=${CHECKOUT_COMMIT_LIMIT + 1}`,
    '--format=%H%x00%s%x00%aI%x00',
    '--',
  ])
  if (result.exitCode !== 0) return yield* fail('failed', 'Git could not list commits')
  const fields = result.stdout.split('\0')
  const items: CheckoutCommitList['items'][number][] = []
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const hash = fields[index]?.trim() ?? ''
    if (!/^[0-9a-f]{40,64}$/.test(hash)) continue
    items.push({ hash, subject: fields[index + 1] ?? '', authoredAt: fields[index + 2] ?? '' })
  }
  return {
    items: items.slice(0, CHECKOUT_COMMIT_LIMIT),
    truncated: result.truncated || items.length > CHECKOUT_COMMIT_LIMIT,
  }
})

const branches = Effect.fn('CheckoutInspection.branches')(function* (
  runner: CommandRunnerService,
  root: string,
): Effect.fn.Return<CheckoutBranchList, CheckoutInspectionError> {
  const cwd = yield* requireRepository(runner, root)
  const current = yield* currentBranch(runner, cwd)
  const count = `--count=${CHECKOUT_BRANCH_LIMIT + 1}`
  const local = yield* runGit(runner, cwd, ['for-each-ref', count, '--format=%(refname)', 'refs/heads/'])
  const remote = yield* runGit(runner, cwd, ['for-each-ref', count, '--format=%(refname)%09%(symref)', 'refs/remotes/'])
  if (local.exitCode !== 0 || remote.exitCode !== 0) return yield* fail('failed', 'Git could not list branches')
  const localRefs = parseLines(local.stdout)
  const remoteRefs = parseLines(remote.stdout).flatMap(line => {
    const [ref = '', symref = ''] = line.split('\t')
    return symref === '' && ref !== '' ? [ref] : []
  })
  const items = [
    ...localRefs.map(ref => {
      const name = ref.slice('refs/heads/'.length)
      return { name, kind: 'local' as const, current: name === current }
    }),
    ...remoteRefs.map(ref => ({ name: ref.slice('refs/remotes/'.length), kind: 'remote' as const, current: false })),
  ]
  const truncated = items.length > CHECKOUT_BRANCH_LIMIT || localRefs.length > CHECKOUT_BRANCH_LIMIT
  return { items: items.slice(0, CHECKOUT_BRANCH_LIMIT), truncated }
})

function parseLines(stdout: string): string[] {
  return stdout.split('\n').filter(line => line.length > 0)
}

/** Tracked files and untracked files Git does not ignore, limited to the pathspec. */
function listedPaths(
  runner: CommandRunnerService,
  cwd: string,
  pathspec: readonly string[],
): Effect.Effect<GitResult, CheckoutInspectionError> {
  return runGit(runner, cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspec])
}

/** Git-visible names under one directory. Null means the checkout is not a repository, so nothing is hidden. */
const visibleChildren = Effect.fn('CheckoutInspection.visibleChildren')(function* (
  runner: CommandRunnerService,
  root: string,
  path: string,
): Effect.fn.Return<Map<string, boolean> | null, CheckoutInspectionError> {
  const state = yield* repositoryState(runner, root)
  if (!state.repository) return null
  const prefix = path === '' ? '' : `${path}/`
  const listed = yield* listedPaths(runner, state.root, prefix === '' ? [] : [prefix])
  if (listed.exitCode !== 0 || listed.truncated) return yield* fail('failed', 'Git could not list the checkout')
  const children = new Map<string, boolean>()
  for (const entry of parseNulList(listed.stdout)) {
    if (!entry.startsWith(prefix)) continue
    const rest = entry.slice(prefix.length)
    const slash = rest.indexOf('/')
    const name = slash === -1 ? rest : rest.slice(0, slash)
    if (name === '') continue
    children.set(name, (children.get(name) ?? false) || slash !== -1)
  }
  return children
})

const listEntries = Effect.fn('CheckoutInspection.listEntries')(function* (
  runner: CommandRunnerService,
  root: string,
  path: string,
  options: CheckoutReadOptions = {},
): Effect.fn.Return<DirectoryListing, CheckoutInspectionError> {
  const target = yield* resolveContainedPath(root, path)
  const info = yield* regularFileSize(target.absolute)
  if (!info.isDirectory()) return yield* fail('path-not-found', 'The path is not a directory')
  const visible = yield* visibleChildren(runner, root, path)
  const dirents = yield* readDirectoryEntries(target.absolute)
  const candidates = dirents.filter(
    dirent =>
      dirent.name.toLowerCase() !== '.git' && (options.includeIgnored || visible === null || visible.has(dirent.name)),
  )
  const built = yield* Effect.forEach(
    candidates,
    dirent =>
      Effect.gen(function* () {
        const kind = dirent.isDirectory() ? ('directory' as const) : ('file' as const)
        const size =
          kind === 'directory'
            ? null
            : yield* entryMetadata(join(target.absolute, dirent.name)).pipe(
                Effect.map(metadata => metadata.size),
                Effect.option,
                Effect.map(Option.getOrNull),
              )
        const entry: DirectoryEntry = {
          name: dirent.name,
          ...(visible !== null && !visible.has(dirent.name) ? { ignored: true } : {}),
          path: path === '' ? dirent.name : `${path}/${dirent.name}`,
          kind,
          size,
        }
        return entry
      }),
    { concurrency: 8 },
  )
  const sorted = built.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return compareText(a.name, b.name)
  })
  return {
    path,
    entries: sorted.slice(0, CHECKOUT_DIRECTORY_ENTRY_LIMIT),
    truncated: sorted.length > CHECKOUT_DIRECTORY_ENTRY_LIMIT,
  }
})

/** Files that the Files tab lists: tracked, or untracked and not ignored. Non-repositories have no ignore rules. */
const isListedFile = Effect.fn('CheckoutInspection.isListedFile')(function* (
  runner: CommandRunnerService,
  root: string,
  path: string,
): Effect.fn.Return<boolean, CheckoutInspectionError> {
  const state = yield* repositoryState(runner, root)
  if (!state.repository) return true
  const listed = yield* listedPaths(runner, state.root, [path])
  return listed.exitCode === 0 && !listed.truncated && parseNulList(listed.stdout).includes(path)
})

/** Image formats are recognized from their bytes, never from a repository-controlled extension. */
export function checkoutImagePreviewDataUrl(bytes: Uint8Array, truncated: boolean): string | null {
  return imagePreviewDataUrl(bytes, truncated, CHECKOUT_FILE_MAX_BYTES)
}

function imagePreviewDataUrl(bytes: Uint8Array, truncated: boolean, limit: number): string | null {
  if (truncated || bytes.byteLength === 0 || bytes.byteLength > limit) return null
  const header = Buffer.from(bytes.subarray(0, 16))
  let mediaType: string | null = null
  if (
    bytes.length >= 33 &&
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    header.toString('ascii', 12, 16) === 'IHDR'
  )
    mediaType = 'image/png'
  else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mediaType = 'image/jpeg'
  else if (
    bytes.length >= 13 &&
    (header.toString('ascii', 0, 6) === 'GIF87a' || header.toString('ascii', 0, 6) === 'GIF89a')
  )
    mediaType = 'image/gif'
  else if (
    bytes.length >= 16 &&
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WEBP'
  )
    mediaType = 'image/webp'
  else if (bytes.length >= 26 && header.toString('ascii', 0, 2) === 'BM') mediaType = 'image/bmp'
  return mediaType ? `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}` : null
}

/** Passive preview formats. Active documents use octet-stream and are rendered in a sandbox by the UI. */
export function checkoutPreviewDataUrl(bytes: Uint8Array, truncated: boolean): string | null {
  if (truncated || bytes.byteLength === 0 || bytes.byteLength > CHECKOUT_PREVIEW_MAX_BYTES) return null
  const image = imagePreviewDataUrl(bytes, truncated, CHECKOUT_PREVIEW_MAX_BYTES)
  if (image !== null) return image
  const header = Buffer.from(bytes.subarray(0, 16))
  let mediaType: string | null = null
  if (header.toString('ascii', 0, 5) === '%PDF-') mediaType = 'application/pdf'
  else if (header.toString('ascii', 0, 4) === 'wOFF') mediaType = 'font/woff'
  else if (header.toString('ascii', 0, 4) === 'wOF2') mediaType = 'font/woff2'
  else if (header.toString('ascii', 0, 4) === 'OTTO') mediaType = 'font/otf'
  else if (header.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]))) mediaType = 'font/ttf'
  else if (header.toString('ascii', 0, 4) === 'fLaC') mediaType = 'audio/flac'
  else if (header.toString('ascii', 0, 4) === 'OggS') mediaType = 'audio/ogg'
  else if (header.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    mediaType = 'audio/mpeg'
  else if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE')
    mediaType = 'audio/wav'
  else if (header.toString('ascii', 4, 8) === 'ftyp') mediaType = 'video/mp4'
  else if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) mediaType = 'video/webm'
  else if (looksBinary(bytes) || decodeUtf8(bytes, false) === null) mediaType = 'application/octet-stream'
  return mediaType ? `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}` : null
}

const readFile = Effect.fn('CheckoutInspection.readFile')(function* (
  runner: CommandRunnerService,
  root: string,
  path: string,
  options: CheckoutReadOptions = {},
): Effect.fn.Return<FileContent, CheckoutInspectionError> {
  if (path === '') return yield* fail('invalid-request', 'A file path is required')
  const target = yield* resolveContainedPath(root, path)
  const info = yield* regularFileSize(target.absolute)
  if (!info.isFile()) return yield* fail('path-not-found', 'The path is not a file')
  if (!options.includeIgnored && !(yield* isListedFile(runner, root, path)))
    return yield* fail('path-not-found', 'The file is not listed')
  let read = yield* readBoundedFile(target.absolute, CHECKOUT_FILE_MAX_BYTES)
  const text = looksBinary(read.bytes) ? null : decodeUtf8(read.bytes, read.truncated)
  if (read.truncated && read.size <= CHECKOUT_PREVIEW_MAX_BYTES && checkoutPreviewDataUrl(read.bytes, false) !== null)
    read = yield* readBoundedFile(target.absolute, CHECKOUT_PREVIEW_MAX_BYTES)
  const textDocument = /\.(?:ipynb|rtf)$/i.test(path)
  if (read.truncated && textDocument && read.size <= 8 * 1024 * 1024)
    read = yield* readBoundedFile(target.absolute, 8 * 1024 * 1024)
  const previewDataUrl =
    checkoutPreviewDataUrl(read.bytes, read.truncated) ??
    (textDocument && read.size > CHECKOUT_FILE_MAX_BYTES && !read.truncated
      ? `data:application/octet-stream;base64,${read.bytes.toString('base64')}`
      : null)
  return {
    path,
    revision: read.revision,
    size: read.size,
    binary: text === null || previewDataUrl !== null,
    content: previewDataUrl ? null : text,
    truncated: read.truncated,
    ...(previewDataUrl ? { previewDataUrl } : {}),
  }
})

const writeFile = Effect.fn('CheckoutInspection.writeFile')(function* (
  runner: CommandRunnerService,
  fs: FileSystem.FileSystem,
  root: string,
  request: CheckoutWriteFileRequest,
): Effect.fn.Return<FileContent, CheckoutInspectionError> {
  const bytes = Buffer.from(request.content, 'utf8')
  if (
    bytes.byteLength > CHECKOUT_FILE_MAX_BYTES ||
    request.content.includes('\0') ||
    request.expectedContent.includes('\0') ||
    decodeUtf8(bytes, false) !== request.content
  )
    return yield* fail('invalid-request', 'Only complete UTF-8 text files can be saved')
  const target = yield* resolveContainedPath(root, request.path)
  const current = yield* readFile(runner, root, request.path, request)
  if (current.binary || current.truncated || current.content === null)
    return yield* fail('invalid-request', 'Only complete UTF-8 text files can be saved')
  if (current.content !== request.expectedContent)
    return yield* fail('conflict', 'The file changed before it could be saved')
  if (current.content === request.content) return current
  const metadata = yield* regularFileSize(target.absolute)
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempFileScoped({
        directory: dirname(target.absolute),
        prefix: '.watchtower-save-',
      })
      yield* fs.writeFile(temporary, bytes)
      yield* fs.chmod(temporary, metadata.mode)
      const rechecked = yield* resolveContainedPath(root, request.path)
      if (rechecked.absolute !== target.absolute)
        return yield* fail('conflict', 'The file moved before it could be saved')
      const latest = yield* readFile(runner, root, request.path, request)
      if (latest.content !== request.expectedContent || latest.binary || latest.truncated)
        return yield* fail('conflict', 'The file changed before it could be saved')
      yield* fs.rename(temporary, target.absolute)
      return yield* readFile(runner, root, request.path, request)
    }),
  ).pipe(
    Effect.catch(error =>
      error instanceof CheckoutInspectionError
        ? Effect.fail(error)
        : Effect.fail(fail('failed', 'The file could not be saved')),
    ),
  )
})

/** Checkout review and serialized text saves. Callers pass canonical checkout paths. */
export const CheckoutInspectionLive = Layer.effect(
  CheckoutInspection,
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    const fs = yield* FileSystem.FileSystem
    const writeGate = yield* Semaphore.make(1)
    return CheckoutInspection.of({
      diffPreview: (root, source) => diffPreview(runner, root, source),
      filePatch: (root, request) => filePatch(runner, root, request),
      branches: root => branches(runner, root),
      commits: root => commits(runner, root),
      listEntries: (root, path, options) => listEntries(runner, root, path, options),
      readFile: (root, path, options) => readFile(runner, root, path, options),
      writeFile: (root, request) => writeGate.withPermits(1)(writeFile(runner, fs, root, request)),
    })
  }),
)
