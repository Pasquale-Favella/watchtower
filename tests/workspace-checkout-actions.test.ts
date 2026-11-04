import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { afterEach, describe, expect, it } from 'vitest'

import { CheckoutActions } from '@/core/ports/checkout-actions.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { CheckoutActionsLive, parseCheckoutGitStatus } from '@/infrastructure/workspace/checkout-actions.js'

const directories: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-checkout-actions-'))
  directories.push(directory)
  git(directory, 'init', '--quiet')
  git(directory, 'config', 'user.name', 'Checkout actions test')
  git(directory, 'config', 'user.email', 'actions@example.invalid')
  git(directory, 'config', 'commit.gpgsign', 'false')
  git(directory, 'config', 'core.autocrlf', 'false')
  return directory
}

async function withActions(
  use: (actions: CheckoutActions['Service'], run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>) => Promise<void>,
): Promise<void> {
  const runtime = ManagedRuntime.make(
    CheckoutActionsLive.pipe(Layer.provideMerge(CommandRunnerLive), Layer.provide(NodePlatformLive)),
  )
  try {
    const actions = await runtime.runPromise(CheckoutActions)
    await use(actions, effect => runtime.runPromise(effect))
  } finally {
    await runtime.dispose()
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory)
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-checkout-actions-`))
      throw new Error('Unexpected test directory')
    rmSync(absolute, { recursive: true, force: true })
  }
})

describe('checkout actions', () => {
  it('stages literal paths and commits only the staged changes', async () => {
    const directory = repository()
    writeFileSync(join(directory, '[literal].txt'), 'selected\n')
    writeFileSync(join(directory, 'other.txt'), 'leave untracked\n')
    await withActions(async (actions, run) => {
      await run(actions.stage(directory, ['[literal].txt']))
      expect(await run(actions.status(directory))).toMatchObject({
        files: expect.arrayContaining([
          { path: '[literal].txt', index: 'A', workingTree: ' ' },
          { path: 'other.txt', index: '?', workingTree: '?' },
        ]),
      })
      const receipt = await run(actions.commit(directory, 'Add selected file'))
      expect(receipt.revision).toBe(git(directory, 'rev-parse', 'HEAD'))
      expect(git(directory, 'ls-tree', '--name-only', 'HEAD')).toBe('[literal].txt')
      expect(existsSync(join(directory, 'other.txt'))).toBe(true)
    })
  })

  it('unstages an unborn repository without deleting files', async () => {
    const directory = repository()
    writeFileSync(join(directory, 'new file.txt'), 'retain\n')
    await withActions(async (actions, run) => {
      await run(actions.stage(directory, ['new file.txt']))
      await run(actions.unstage(directory, ['new file.txt']))
      expect(existsSync(join(directory, 'new file.txt'))).toBe(true)
      expect((await run(actions.status(directory))).files).toEqual([
        { path: 'new file.txt', index: '?', workingTree: '?' },
      ])
    })
  })

  it('unstages tracked changes and rejects an empty commit or paths outside the checkout', async () => {
    const directory = repository()
    writeFileSync(join(directory, 'tracked.txt'), 'before\n')
    git(directory, 'add', '.')
    git(directory, 'commit', '--quiet', '-m', 'Initial')
    writeFileSync(join(directory, 'tracked.txt'), 'after\n')
    await withActions(async (actions, run) => {
      await run(actions.stage(directory, ['tracked.txt']))
      await run(actions.unstage(directory, ['tracked.txt']))
      expect((await run(actions.status(directory))).files).toEqual([
        { path: 'tracked.txt', index: ' ', workingTree: 'M' },
      ])
      await expect(run(actions.commit(directory, 'Nothing staged'))).rejects.toThrow('Stage changes')
      await expect(run(actions.stage(directory, ['../outside.txt']))).rejects.toThrow('inside the checkout')
      await expect(run(actions.stage(directory, ['.git/config']))).rejects.toThrow('inside the checkout')
    })
  })

  it('parses rename pairs and paths with newlines without splitting their identity', () => {
    expect(parseCheckoutGitStatus('R  new name.txt\0old name.txt\0 M line\nbreak.txt\0')).toEqual({
      files: [
        { path: 'new name.txt', previousPath: 'old name.txt', index: 'R', workingTree: ' ' },
        { path: 'line\nbreak.txt', index: ' ', workingTree: 'M' },
      ],
      truncated: false,
    })
  })
})
