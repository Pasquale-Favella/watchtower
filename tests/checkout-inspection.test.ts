import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterEach, describe, expect, it } from 'vitest'

import { CheckoutInspection } from '@/core/ports/checkout-inspection.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { CheckoutInspectionLive } from '@/infrastructure/workspace/checkout-inspector.js'
import { parseNameStatusZ, parseNulList, parseNumstatZ } from '@/infrastructure/workspace/checkout-inspector-git.js'
import {
  CHECKOUT_FILE_MAX_BYTES,
  CHECKOUT_PATCH_MAX_BYTES,
  type DiffSourceSelector,
} from '@/shared/schemas/checkout-inspection.js'

const roots: string[] = []
const identity = [
  '-c',
  'user.name=Checkout Test',
  '-c',
  'user.email=checkout@example.invalid',
  '-c',
  'commit.gpgsign=false',
]
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd: string, message: string) =>
  git(cwd, ...identity, 'commit', '--quiet', '--allow-empty', '-m', message)

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'watchtower-checkout-inspect-'))
  roots.push(root)
  return root
}

/** A repository with one commit containing the given files. */
function repository(directory: string, files: Record<string, string | Buffer>): string {
  mkdirSync(directory, { recursive: true })
  git(directory, 'init', '--quiet', '--initial-branch=main')
  git(directory, 'config', 'core.autocrlf', 'false')
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true })
    writeFileSync(join(directory, name), content)
  }
  git(directory, 'add', '--all')
  commit(directory, 'Initial')
  return directory
}

function withInspection(
  use: (
    inspection: CheckoutInspection['Service'],
    run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  ) => Promise<void>,
) {
  const runtime = ManagedRuntime.make(
    CheckoutInspectionLive.pipe(Layer.provideMerge(CommandRunnerLive), Layer.provide(NodePlatformLive)),
  )
  return runtime
    .runPromise(CheckoutInspection)
    .then(inspection => use(inspection, effect => runtime.runPromise(effect)))
    .finally(() => runtime.dispose())
}

/** Symlinks to files need developer mode on some Windows setups; the containment test runs only where they work. */
function canCreateFileLink(): boolean {
  const directory = scratch()
  const target = join(directory, 'target.txt')
  writeFileSync(target, 'target')
  try {
    symlinkSync(target, join(directory, 'link.txt'))
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const working: DiffSourceSelector = { kind: 'working-tree' }

describe('checkout inspection: working tree', () => {
  it('reports modified, deleted, renamed, binary and untracked files without ignored paths', async () => {
    const main = repository(join(scratch(), 'main'), {
      'tracked.txt': 'original\n',
      'gone.txt': 'goodbye\n',
      'moved.txt': 'a long line that keeps rename detection stable across the move\n'.repeat(3),
      'binary.bin': Buffer.from([0, 1, 2, 3]),
      'src/nested/deep.ts': 'export const deep = 1\n',
      '.gitignore': 'ignored.log\n',
    })
    writeFileSync(join(main, 'tracked.txt'), 'original\nchanged\n')
    rmSync(join(main, 'gone.txt'))
    git(main, 'mv', 'moved.txt', 'renamed.txt')
    writeFileSync(join(main, 'binary.bin'), Buffer.from([0, 9, 9, 0]))
    writeFileSync(join(main, 'added.txt'), 'one\ntwo\n')
    writeFileSync(join(main, 'no-newline.txt'), 'a\nb')
    writeFileSync(join(main, 'ignored.log'), 'secret\n')
    writeFileSync(join(main, 'src/nested/deep.ts'), 'export const deep = 2\n')

    await withInspection(async (inspection, run) => {
      const source = await run(inspection.diffPreview(main, working))
      expect(source).toMatchObject({
        id: 'working-tree',
        kind: 'working-tree',
        baseRef: 'HEAD',
        headRef: 'main',
        truncated: false,
      })
      expect(
        source.files.map(file => [
          file.path,
          file.status,
          file.additions,
          file.deletions,
          file.binary,
          file.previousPath ?? null,
        ]),
      ).toEqual([
        ['added.txt', 'added', 2, 0, false, null],
        ['binary.bin', 'modified', 0, 0, true, null],
        ['gone.txt', 'deleted', 0, 1, false, null],
        ['no-newline.txt', 'added', 2, 0, false, null],
        ['renamed.txt', 'renamed', 0, 0, false, 'moved.txt'],
        ['src/nested/deep.ts', 'modified', 1, 1, false, null],
        ['tracked.txt', 'modified', 1, 0, false, null],
      ])
    })
  })

  it('returns unified patches for tracked, untracked, binary and renamed files', async () => {
    const main = repository(join(scratch(), 'main'), {
      'tracked.txt': 'original\n',
      'moved.txt': 'a long line that keeps rename detection stable across the move\n'.repeat(3),
      'binary.bin': Buffer.from([0, 1]),
      '.gitignore': 'ignored.log\n',
    })
    writeFileSync(join(main, 'tracked.txt'), 'original\nchanged\n')
    git(main, 'mv', 'moved.txt', 'renamed.txt')
    writeFileSync(join(main, 'binary.bin'), Buffer.from([0, 7]))
    writeFileSync(join(main, 'fresh.txt'), 'one\ntwo\n')
    writeFileSync(join(main, 'ignored.log'), 'secret\n')

    await withInspection(async (inspection, run) => {
      const tracked = await run(inspection.filePatch(main, { source: working, path: 'tracked.txt' }))
      expect(tracked).toMatchObject({ binary: false, truncated: false })
      expect(tracked.patch).toContain('+changed')
      expect(tracked.patch).toContain('@@ ')

      const fresh = await run(inspection.filePatch(main, { source: working, path: 'fresh.txt' }))
      expect(fresh.patch).toBe(
        'diff --git a/fresh.txt b/fresh.txt\nnew file mode 100644\n--- /dev/null\n+++ b/fresh.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
      )

      const binary = await run(inspection.filePatch(main, { source: working, path: 'binary.bin' }))
      expect(binary).toEqual({ binary: true, patch: '', truncated: false })

      const renamed = await run(
        inspection.filePatch(main, { source: working, path: 'renamed.txt', previousPath: 'moved.txt' }),
      )
      expect(renamed.patch).toContain('rename from moved.txt')
      expect(renamed.patch).toContain('rename to renamed.txt')

      expect(await run(inspection.filePatch(main, { source: working, path: 'ignored.log' }))).toEqual({
        binary: false,
        patch: '',
        truncated: false,
      })
    })
  })

  it('reports an unborn repository as all-added content against the empty tree', async () => {
    const directory = join(scratch(), 'unborn')
    mkdirSync(directory)
    git(directory, 'init', '--quiet', '--initial-branch=main')
    writeFileSync(join(directory, 'draft.md'), '# Draft\n')

    await withInspection(async (inspection, run) => {
      const source = await run(inspection.diffPreview(directory, working))
      expect(source).toMatchObject({ baseRef: null, headRef: 'main' })
      expect(source.files).toEqual([{ path: 'draft.md', status: 'added', additions: 1, deletions: 0, binary: false }])
    })
  })

  it('caps the file list at 2,000 entries and reports truncation', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 2001; index += 1) files[`pkg/file-${String(index).padStart(4, '0')}.txt`] = 'v1\n'
    const main = repository(join(scratch(), 'many'), files)
    for (const name of Object.keys(files)) writeFileSync(join(main, name), 'v2\n')

    await withInspection(async (inspection, run) => {
      const source = await run(inspection.diffPreview(main, working))
      expect(source.files).toHaveLength(2000)
      expect(source.truncated).toBe(true)
    })
  }, 60_000)

  it('stops scanning untracked files at 5,000 entries', async () => {
    const main = repository(join(scratch(), 'scan'), { 'anchor.txt': 'anchor\n' })
    for (let index = 0; index < 5001; index += 1) writeFileSync(join(main, `loose-${index}.txt`), 'x\n')

    await withInspection(async (inspection, run) => {
      const source = await run(inspection.diffPreview(main, working))
      expect(source.truncated).toBe(true)
      expect(source.files).toHaveLength(2000)
    })
  }, 120_000)

  it('reports a directory outside a repository as Not a Git repository', async () => {
    const plain = join(scratch(), 'plain')
    mkdirSync(plain)
    writeFileSync(join(plain, 'note.txt'), 'note\n')

    await withInspection(async (inspection, run) => {
      await expect(run(inspection.diffPreview(plain, working))).rejects.toMatchObject({ code: 'not-repository' })
      const listing = await run(inspection.listEntries(plain, ''))
      expect(listing.entries.map(entry => entry.name)).toEqual(['note.txt'])
    })
  })
})

describe('checkout inspection: branch range', () => {
  it('compares the working tree with the merge-base of HEAD and the chosen base', async () => {
    const main = repository(join(scratch(), 'branch'), { 'base.txt': 'base\n' })
    git(main, 'checkout', '--quiet', '-b', 'feature')
    writeFileSync(join(main, 'feature.txt'), 'feature\n')
    git(main, 'add', 'feature.txt')
    commit(main, 'Feature work')
    git(main, 'checkout', '--quiet', 'main')
    writeFileSync(join(main, 'main-only.txt'), 'main\n')
    git(main, 'add', 'main-only.txt')
    commit(main, 'Main work')
    git(main, 'checkout', '--quiet', 'feature')
    writeFileSync(join(main, 'feature.txt'), 'feature\nedited\n')

    await withInspection(async (inspection, run) => {
      const source = await run(inspection.diffPreview(main, { kind: 'branch-range', baseRef: 'main' }))
      expect(source).toMatchObject({
        id: 'branch-range:main',
        kind: 'branch-range',
        baseRef: 'main',
        headRef: 'feature',
        truncated: false,
      })
      expect(source.files).toEqual([
        { path: 'feature.txt', status: 'added', additions: 2, deletions: 0, binary: false },
      ])

      const defaulted = await run(inspection.diffPreview(main, { kind: 'branch-range' }))
      expect(defaulted.baseRef).toBe('main')
    })
  })

  it('refuses a base that does not exist, without echoing Git diagnostics', async () => {
    const main = repository(join(scratch(), 'missing-base'), { 'a.txt': 'a\n' })

    await withInspection(async (inspection, run) => {
      await expect(
        run(inspection.diffPreview(main, { kind: 'branch-range', baseRef: 'no-such-branch' })),
      ).rejects.toMatchObject({ code: 'base-unavailable' })
    })
  })

  it('prefers the remote default branch when origin/HEAD is recorded', async () => {
    const main = repository(join(scratch(), 'origin'), { 'a.txt': 'a\n' })
    git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')

    await withInspection(async (inspection, run) => {
      const source = await run(inspection.diffPreview(main, { kind: 'branch-range' }))
      expect(source.baseRef).toBe('origin/main')
      const branches = await run(inspection.branches(main))
      expect(branches.items).toEqual([
        { name: 'main', kind: 'local', current: true },
        { name: 'origin/main', kind: 'remote', current: false },
      ])
    })
  })
})

describe('checkout inspection: containment', () => {
  it('rejects parent, absolute and metadata paths before reading anything', async () => {
    const main = repository(join(scratch(), 'contained'), { 'tracked.txt': 'x\n' })

    await withInspection(async (inspection, run) => {
      await expect(run(inspection.readFile(main, '../outside.txt'))).rejects.toMatchObject({ code: 'outside-checkout' })
      await expect(run(inspection.readFile(main, join(main, 'tracked.txt')))).rejects.toMatchObject({
        code: 'outside-checkout',
      })
      await expect(run(inspection.readFile(main, 'nested/../../escape.txt'))).rejects.toMatchObject({
        code: 'outside-checkout',
      })
      await expect(run(inspection.readFile(main, '.git/config'))).rejects.toMatchObject({ code: 'outside-checkout' })
      await expect(run(inspection.filePatch(main, { source: working, path: '../outside.txt' }))).rejects.toMatchObject({
        code: 'outside-checkout',
      })
      await expect(run(inspection.listEntries(main, '../'))).rejects.toMatchObject({ code: 'outside-checkout' })
    })
  })

  it('rejects a Windows short-name alias of the metadata folder', async () => {
    // Without a HEAD, Git does not treat this folder as a repository, so only containment protects it.
    const main = join(scratch(), 'damaged')
    mkdirSync(join(main, '.git'), { recursive: true })
    writeFileSync(join(main, '.git', 'config'), '[remote "origin"]\n')
    if (!existsSync(join(main, 'GIT~1'))) return

    await withInspection(async (inspection, run) => {
      await expect(run(inspection.readFile(main, 'GIT~1/config'))).rejects.toMatchObject({ code: 'outside-checkout' })
      await expect(run(inspection.listEntries(main, 'GIT~1'))).rejects.toMatchObject({ code: 'outside-checkout' })
    })
  })

  it('does not read through a directory link that leaves the checkout', async () => {
    const root = scratch()
    const main = repository(join(root, 'linked'), { 'tracked.txt': 'x\n' })
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside the checkout\n')
    symlinkSync(outside, join(main, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir')

    await withInspection(async (inspection, run) => {
      await expect(run(inspection.readFile(main, 'linked-dir/secret.txt'))).rejects.toMatchObject({
        code: 'outside-checkout',
      })
      await expect(run(inspection.listEntries(main, 'linked-dir'))).rejects.toMatchObject({
        code: 'outside-checkout',
      })
    })
  })

  it('does not read through a file link that leaves the checkout', async context => {
    if (!canCreateFileLink()) return context.skip()
    const root = scratch()
    const main = repository(join(root, 'file-link'), { 'tracked.txt': 'x\n' })
    const outsideFile = join(root, 'secret.txt')
    writeFileSync(outsideFile, 'outside the checkout\n')
    symlinkSync(outsideFile, join(main, 'secret-link.txt'))

    await withInspection(async (inspection, run) => {
      await expect(run(inspection.readFile(main, 'secret-link.txt'))).rejects.toMatchObject({
        code: 'outside-checkout',
      })
    })
  })
})

describe('checkout inspection: files and directories', () => {
  it('lists one level honouring .gitignore, hides .git and sorts directories first', async () => {
    const main = repository(join(scratch(), 'tree'), {
      'src/app.ts': 'export {}\n',
      'tracked.txt': 'tracked\n',
      '.gitignore': 'build/\n',
    })
    mkdirSync(join(main, 'build'))
    writeFileSync(join(main, 'build', 'out.log'), 'ignored\n')
    writeFileSync(join(main, 'notes.md'), '# Notes\n')

    await withInspection(async (inspection, run) => {
      const root = await run(inspection.listEntries(main, ''))
      expect(root.entries.map(entry => [entry.name, entry.kind, entry.size])).toEqual([
        ['src', 'directory', null],
        ['.gitignore', 'file', 7],
        ['notes.md', 'file', 8],
        ['tracked.txt', 'file', 8],
      ])
      expect(root.truncated).toBe(false)
      const src = await run(inspection.listEntries(main, 'src'))
      expect(src.entries.map(entry => entry.path)).toEqual(['src/app.ts'])
    })
  })

  it('reads text, reports binary content without bytes, and hides ignored files', async () => {
    const main = repository(join(scratch(), 'read'), {
      'tracked.txt': 'original\n',
      'binary.bin': Buffer.from([0, 1, 2]),
      '.gitignore': 'hidden.env\n',
    })
    writeFileSync(join(main, 'hidden.env'), 'TOKEN=1\n')

    await withInspection(async (inspection, run) => {
      expect(await run(inspection.readFile(main, 'tracked.txt'))).toEqual({
        path: 'tracked.txt',
        size: 9,
        binary: false,
        content: 'original\n',
        truncated: false,
      })
      expect(await run(inspection.readFile(main, 'binary.bin'))).toMatchObject({ binary: true, content: null })
      await expect(run(inspection.readFile(main, 'hidden.env'))).rejects.toMatchObject({ code: 'path-not-found' })
      await expect(run(inspection.readFile(main, 'tracked.txt/'))).rejects.toMatchObject({ code: 'outside-checkout' })
    })
  })

  it('bounds one file read and one patch to 1 MiB and reports truncation', async () => {
    const main = repository(join(scratch(), 'large'), { 'seed.txt': 'seed\n' })
    const line = `${'x'.repeat(99)}\n`
    writeFileSync(join(main, 'huge.txt'), line.repeat(Math.ceil((CHECKOUT_FILE_MAX_BYTES * 3) / 2 / line.length)))

    await withInspection(async (inspection, run) => {
      const file = await run(inspection.readFile(main, 'huge.txt'))
      expect(file.truncated).toBe(true)
      expect(file.size).toBeGreaterThan(CHECKOUT_FILE_MAX_BYTES)
      expect(Buffer.byteLength(file.content ?? '', 'utf8')).toBeLessThanOrEqual(CHECKOUT_FILE_MAX_BYTES)

      const patch = await run(inspection.filePatch(main, { source: working, path: 'huge.txt' }))
      expect(patch.truncated).toBe(true)
      expect(Buffer.byteLength(patch.patch, 'utf8')).toBeLessThanOrEqual(CHECKOUT_PATCH_MAX_BYTES)
    })
  })
})

describe('git output parsers', () => {
  it('keys numstat by destination path, including renames with empty path fields', () => {
    const numstat = '1\t0\tsrc/a.ts\0-\t-\tbin.dat\0\t\0old name.txt\0new name.txt\0'
    const parsed = parseNumstatZ(numstat)
    expect(parsed.get('src/a.ts')).toEqual({ additions: 1, deletions: 0, binary: false })
    expect(parsed.get('bin.dat')).toEqual({ additions: 0, deletions: 0, binary: true })
    expect(parsed.get('new name.txt')).toEqual({ additions: 0, deletions: 0, binary: false })
  })

  it('parses name-status records with rename sources', () => {
    expect(parseNameStatusZ('M\0a.ts\0A\0b.ts\0D\0c.ts\0R100\0old.ts\0new.ts\0')).toEqual([
      { status: 'modified', path: 'a.ts' },
      { status: 'added', path: 'b.ts' },
      { status: 'deleted', path: 'c.ts' },
      { status: 'renamed', path: 'new.ts', previousPath: 'old.ts' },
    ])
    expect(parseNulList('one\0two\0')).toEqual(['one', 'two'])
  })
})
