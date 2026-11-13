import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'

import { CheckoutInspection } from '@/core/ports/checkout-inspection.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { CheckoutInspectionLive, checkoutPreviewDataUrl } from '@/infrastructure/workspace/checkout-inspector.js'
import {
  CHECKOUT_FILE_MAX_BYTES,
  fileContentSchema,
  writeFileRequestSchema,
} from '@/shared/schemas/checkout-inspection.js'

const directories: string[] = []
const identity = [
  '-c',
  'user.name=Checkout Test',
  '-c',
  'user.email=checkout@example.invalid',
  '-c',
  'commit.gpgsign=false',
]

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-checkout-editing-'))
  directories.push(directory)
  return directory
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function repository(): string {
  const root = scratch()
  git(root, 'init', '--quiet', '--initial-branch=main')
  git(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'file.ts'), 'export const value = 1\n')
  git(root, 'add', '.')
  git(root, ...identity, 'commit', '--quiet', '-m', 'Initial')
  return root
}

async function withInspection(
  use: (
    inspection: CheckoutInspection['Service'],
    run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  ) => Promise<void>,
): Promise<void> {
  const runtime = ManagedRuntime.make(
    CheckoutInspectionLive.pipe(Layer.provideMerge(CommandRunnerLive), Layer.provide(NodePlatformLive)),
  )
  try {
    const inspection = await runtime.runPromise(CheckoutInspection)
    await use(inspection, effect => runtime.runPromise(effect))
  } finally {
    await runtime.dispose()
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory)
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-checkout-editing-`))
      throw new Error('Unexpected test directory')
    rmSync(absolute, { recursive: true, force: true })
  }
})

describe('checkout editing', () => {
  it('shows ignored entries only when explicitly requested and saves their complete contents', async () => {
    const root = repository()
    mkdirSync(join(root, 'cache'))
    writeFileSync(join(root, '.gitignore'), 'cache/\n')
    writeFileSync(join(root, 'cache', 'notes.txt'), 'private draft\n')
    await withInspection(async (inspection, run) => {
      expect((await run(inspection.listEntries(root, ''))).entries.some(entry => entry.path === 'cache')).toBe(false)
      expect((await run(inspection.listEntries(root, '', { includeIgnored: true }))).entries).toContainEqual(
        expect.objectContaining({ path: 'cache', kind: 'directory', ignored: true }),
      )
      const file = await run(inspection.readFile(root, 'cache/notes.txt', { includeIgnored: true }))
      expect(file.content).toBe('private draft\n')
      const saved = await run(
        inspection.writeFile(root, {
          path: 'cache/notes.txt',
          expectedContent: 'private draft\n',
          content: 'updated\n',
          includeIgnored: true,
        }),
      )
      expect(saved.content).toBe('updated\n')
      expect(saved.revision).not.toBe(file.revision)
      expect(
        (await run(inspection.listEntries(root, '', { includeIgnored: true }))).entries.some(
          entry => entry.name === '.git',
        ),
      ).toBe(false)
    })
  })
  it('saves complete UTF-8 content and removes temporary files', async () => {
    const root = repository()
    await withInspection(async (inspection, run) => {
      const saved = await run(
        inspection.writeFile(root, {
          path: 'file.ts',
          expectedContent: 'export const value = 1\n',
          content: 'export const value = "caffè"\n',
        }),
      )
      expect(saved).toEqual({
        path: 'file.ts',
        revision: expect.any(String),
        size: Buffer.byteLength('export const value = "caffè"\n'),
        content: 'export const value = "caffè"\n',
        binary: false,
        truncated: false,
      })
      expect(readFileSync(join(root, 'file.ts'), 'utf8')).toBe(saved.content)
      expect(readdirSync(root).filter(name => name.startsWith('.watchtower-save-'))).toEqual([])
    })
  })

  it('keeps an external modification when the expected content is stale', async () => {
    const root = repository()
    writeFileSync(join(root, 'file.ts'), 'external edit\n')
    await withInspection(async (inspection, run) => {
      await expect(
        run(
          inspection.writeFile(root, {
            path: 'file.ts',
            expectedContent: 'export const value = 1\n',
            content: 'mine\n',
          }),
        ),
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(readFileSync(join(root, 'file.ts'), 'utf8')).toBe('external edit\n')
    })
  })

  it('serializes overlapping saves so only one request with the same baseline succeeds', async () => {
    const root = repository()
    await withInspection(async (inspection, run) => {
      const results = await Promise.allSettled(
        ['first\n', 'second\n'].map(content =>
          run(inspection.writeFile(root, { path: 'file.ts', expectedContent: 'export const value = 1\n', content })),
        ),
      )
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const failed = results.find(result => result.status === 'rejected')
      expect(failed).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } })
    })
  })

  it('rejects binary, truncated and NUL-containing saves without changing the file', async () => {
    const root = scratch()
    writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2]))
    writeFileSync(join(root, 'large'), 'a'.repeat(CHECKOUT_FILE_MAX_BYTES + 1))
    writeFileSync(join(root, 'plain'), 'text')
    await withInspection(async (inspection, run) => {
      for (const path of ['binary', 'large'])
        await expect(
          run(inspection.writeFile(root, { path, content: 'changed', expectedContent: '' })),
        ).rejects.toMatchObject({ code: 'invalid-request' })
      await expect(
        run(inspection.writeFile(root, { path: 'plain', content: 'contains\0nul', expectedContent: 'text' })),
      ).rejects.toMatchObject({ code: 'invalid-request' })
      expect(readFileSync(join(root, 'plain'), 'utf8')).toBe('text')
    })
  })

  it('rejects parent paths, metadata and junctions outside the checkout', async () => {
    const root = scratch()
    const checkout = join(root, 'checkout')
    const outside = join(root, 'outside')
    mkdirSync(join(checkout, '.git'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret'), 'secret')
    writeFileSync(join(checkout, '.git', 'config'), 'metadata')
    symlinkSync(outside, join(checkout, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await withInspection(async (inspection, run) => {
      for (const path of ['../outside/secret', '.git/config', 'link/secret'])
        await expect(
          run(inspection.writeFile(checkout, { path, content: 'overwrite', expectedContent: 'secret' })),
        ).rejects.toMatchObject({ code: 'outside-checkout' })
      expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('secret')
    })
  })

  it('rejects unsafe write requests at the schema boundary', () => {
    expect(Schema.is(writeFileRequestSchema)({ projectId: 'p', path: '../x', content: '', expectedContent: '' })).toBe(
      false,
    )
    expect(Schema.is(writeFileRequestSchema)({ projectId: 'p', path: 'x', content: '' })).toBe(false)
  })
})

describe('checkout staged and commit review', () => {
  it('keeps staged content separate from working edits and untracked files', async () => {
    const root = repository()
    writeFileSync(join(root, 'file.ts'), 'staged\n')
    git(root, 'add', 'file.ts')
    writeFileSync(join(root, 'file.ts'), 'working\n')
    writeFileSync(join(root, 'untracked.ts'), 'loose\n')
    await withInspection(async (inspection, run) => {
      const source = await run(inspection.diffPreview(root, { kind: 'staged' }))
      expect(source.files.map(file => file.path)).toEqual(['file.ts'])
      const patch = await run(
        inspection.filePatch(root, { source: { kind: 'staged' }, path: 'file.ts', includeContents: true }),
      )
      expect(patch.patch).toContain('+staged')
      expect(patch.patch).not.toContain('+working')
      expect(patch).toMatchObject({ oldContent: 'export const value = 1\n', newContent: 'staged\n' })
      const loose = await run(inspection.filePatch(root, { source: { kind: 'staged' }, path: 'untracked.ts' }))
      expect(loose.patch).toBe('')
    })
  })

  it('reviews historical commits including the root commit independently of the checkout', async () => {
    const root = repository()
    const first = git(root, 'rev-parse', 'HEAD')
    writeFileSync(join(root, 'file.ts'), 'second\n')
    git(root, 'add', '.')
    git(root, ...identity, 'commit', '--quiet', '-m', 'Second')
    const second = git(root, 'rev-parse', 'HEAD')
    writeFileSync(join(root, 'file.ts'), 'working\n')
    await withInspection(async (inspection, run) => {
      const commits = await run(inspection.commits(root))
      expect(commits.items.map(commit => [commit.hash, commit.subject])).toEqual([
        [second, 'Second'],
        [first, 'Initial'],
      ])
      const initial = await run(inspection.diffPreview(root, { kind: 'commit', commit: first }))
      expect(initial.files).toMatchObject([{ path: 'file.ts', status: 'added' }])
      const patch = await run(
        inspection.filePatch(root, {
          source: { kind: 'commit', commit: second },
          path: 'file.ts',
          includeContents: true,
        }),
      )
      expect(patch).toMatchObject({ oldContent: 'export const value = 1\n', newContent: 'second\n' })
      expect(patch.patch).not.toContain('working')
    })
  })

  it('honors whitespace filtering and expanded context on the server', async () => {
    const root = repository()
    writeFileSync(join(root, 'file.ts'), 'export  const value = 1\n')
    await withInspection(async (inspection, run) => {
      const ignored = await run(
        inspection.filePatch(root, {
          source: { kind: 'working-tree', ignoreWhitespace: true },
          path: 'file.ts',
          includeContents: true,
          contextLines: 100,
        }),
      )
      expect(ignored.patch).toBe('')
      const visible = await run(inspection.filePatch(root, { source: { kind: 'working-tree' }, path: 'file.ts' }))
      expect(visible.patch).toContain('+export  const')
    })
  })
})

describe('bounded document previews', () => {
  it.each([
    ['application/pdf', Buffer.from('%PDF-1.7\n')],
    ['font/woff2', Buffer.from('wOF2\0abc')],
    ['audio/flac', Buffer.from('fLaC\0abc')],
    ['audio/wav', Buffer.from('RIFF0000WAVEdata')],
    ['video/mp4', Buffer.from('0000ftypisom')],
    ['application/octet-stream', Buffer.from([0, 1, 2])],
  ])('recognizes %s and validates its RPC representation', (mediaType, bytes) => {
    const previewDataUrl = checkoutPreviewDataUrl(bytes, false)
    expect(previewDataUrl).toBe(`data:${mediaType};base64,${bytes.toString('base64')}`)
    expect(
      Schema.is(fileContentSchema)({
        path: 'preview',
        size: bytes.length,
        binary: true,
        content: null,
        truncated: false,
        previewDataUrl,
      }),
    ).toBe(true)
    expect(checkoutPreviewDataUrl(bytes, true)).toBeNull()
  })
})
