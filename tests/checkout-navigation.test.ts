import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Effect from 'effect/Effect'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  checkoutEditorUri,
  checkoutNavigationHandlers,
  type CheckoutNavigationNative,
} from '@/platform/electron/main/rpc/checkout-navigation-handlers.js'
import { CheckoutNavigationRpcGroup, checkoutOpenFileSchema } from '@/shared/rpc/checkout-navigation.js'
import { projectIdSchema } from '@/shared/schemas/workspace.js'

const directories: string[] = []
const projectId = Schema.decodeUnknownSync(projectIdSchema)('project-navigation')
const clientEffect = RpcTest.makeClient(CheckoutNavigationRpcGroup)
type Client = Effect.Success<typeof clientEffect>

function fixture(): { readonly directory: string; readonly root: string } {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-file-navigation-'))
  directories.push(directory)
  const root = join(directory, 'checkout')
  mkdirSync(root)
  return { directory, root }
}

function native(): CheckoutNavigationNative & {
  readonly openPath: ReturnType<typeof vi.fn<CheckoutNavigationNative['openPath']>>
  readonly openExternal: ReturnType<typeof vi.fn<CheckoutNavigationNative['openExternal']>>
  readonly reveal: ReturnType<typeof vi.fn<CheckoutNavigationNative['reveal']>>
} {
  return { openPath: vi.fn(async () => ''), openExternal: vi.fn(async () => undefined), reveal: vi.fn(() => undefined) }
}

function run<A, E>(
  root: string,
  adapter: CheckoutNavigationNative,
  use: (client: Client) => Effect.Effect<A, E>,
): Promise<A> {
  const handlers = checkoutNavigationHandlers({ resolveCheckoutPath: () => Effect.succeed(root), native: adapter })
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* clientEffect)
    }).pipe(Effect.scoped, Effect.provide(handlers), Effect.provide(NodeFileSystem.layer)),
  )
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory)
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-file-navigation-`))
      throw new Error('Unexpected test directory')
    rmSync(absolute, { recursive: true, force: true })
  }
})

describe('checkout file navigation', () => {
  it('downloads complete files through an explicit save destination without preview limits', async () => {
    const { root, directory } = fixture()
    const source = Buffer.alloc(2 * 1024 * 1024, 'x')
    writeFileSync(join(root, 'large.txt'), source)
    const destination = join(directory, 'copy.txt')
    const adapter = { ...native(), chooseSavePath: vi.fn(async () => destination) }
    expect(await run(root, adapter, client => client['checkout:downloadFile']({ projectId, path: 'large.txt' }))).toBe(
      true,
    )
    expect(readFileSync(destination)).toEqual(source)
    expect(adapter.chooseSavePath).toHaveBeenCalledWith('large.txt')
  })

  it('leaves disk unchanged when the file save dialog is canceled', async () => {
    const { root, directory } = fixture()
    writeFileSync(join(root, 'source.txt'), 'source')
    const adapter = { ...native(), chooseSavePath: vi.fn(async () => null) }
    expect(await run(root, adapter, client => client['checkout:downloadFile']({ projectId, path: 'source.txt' }))).toBe(
      false,
    )
    expect(existsSync(join(directory, 'source.txt'))).toBe(false)
  })
  it('encodes reserved characters and Unicode in editor paths on Windows and POSIX', () => {
    expect(checkoutEditorUri('vscode', 'C:\\repo\\a #?.ts')).toBe('vscode://file/C:/repo/a%20%23%3F.ts')
    expect(checkoutEditorUri('cursor', '/repo/你好 file.ts')).toBe('cursor://file/repo/%E4%BD%A0%E5%A5%BD%20file.ts')
    expect(checkoutEditorUri('vscodium', '/repo/percent%25.ts')).toBe('vscodium://file/repo/percent%2525.ts')
  })

  it('opens the contained canonical file in the chosen editor and reveals that same file', async () => {
    const { root } = fixture()
    writeFileSync(join(root, 'source #你好.ts'), 'export const value = 1\n')
    const adapter = native()
    await run(root, adapter, client =>
      Effect.gen(function* () {
        yield* client['checkout:openFile']({ projectId, path: 'source #你好.ts', editor: 'cursor' })
        yield* client['checkout:revealFile']({ projectId, path: 'source #你好.ts' })
      }),
    )
    expect(adapter.openExternal).toHaveBeenCalledWith(expect.stringContaining('/source%20%23%E4%BD%A0%E5%A5%BD.ts'))
    expect(adapter.reveal).toHaveBeenCalledWith(realpathSync.native(join(root, 'source #你好.ts')))
    expect(adapter.openPath).not.toHaveBeenCalled()
  })

  it('uses the default app for documents and refuses executable default associations', async () => {
    const { root } = fixture()
    writeFileSync(join(root, 'readme.txt'), 'text')
    writeFileSync(join(root, 'run.js'), 'throw new Error("never execute")')
    const adapter = native()
    await run(root, adapter, client => client['checkout:openFile']({ projectId, path: 'readme.txt', editor: 'system' }))
    expect(adapter.openPath).toHaveBeenCalledOnce()
    const error = await run(root, adapter, client =>
      Effect.flip(client['checkout:openFile']({ projectId, path: 'run.js', editor: 'system' })),
    )
    expect(error).toMatchObject({ code: 'choose-editor', message: 'Choose a code editor to open this file.' })
    expect(adapter.openPath).toHaveBeenCalledOnce()
  })

  it('rejects traversal, arbitrary editor schemes, private Git metadata and missing paths', async () => {
    expect(Schema.is(checkoutOpenFileSchema)({ projectId, path: '../secret.txt' })).toBe(false)
    expect(Schema.is(checkoutOpenFileSchema)({ projectId, path: 'file.txt', editor: 'javascript' })).toBe(false)
    const { root } = fixture()
    const adapter = native()
    const error = await run(root, adapter, client =>
      Effect.flip(client['checkout:revealFile']({ projectId, path: 'missing.txt' })),
    )
    expect(error).toMatchObject({ code: 'not-found' })
    expect(Schema.is(checkoutOpenFileSchema)({ projectId, path: '.git/config' })).toBe(false)
    expect(adapter.reveal).not.toHaveBeenCalled()
  })

  it('refuses a directory link whose target escapes the selected checkout', async () => {
    const { directory, root } = fixture()
    const outside = join(directory, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'private.txt'), 'private')
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const adapter = native()
    const error = await run(root, adapter, client =>
      Effect.flip(client['checkout:openFile']({ projectId, path: 'escape/private.txt' })),
    )
    expect(error).toMatchObject({ code: 'outside-checkout', message: 'The file must stay inside the checkout.' })
    expect(adapter.openExternal).not.toHaveBeenCalled()
  })

  it('replaces native error text and openPath errors with a fixed message', async () => {
    const { root } = fixture()
    writeFileSync(join(root, 'file.txt'), 'text')
    const adapter = native()
    adapter.openExternal.mockRejectedValueOnce(new Error('private directory credentials'))
    const error = await run(root, adapter, client =>
      Effect.flip(client['checkout:openFile']({ projectId, path: 'file.txt' })),
    )
    expect(error.message).toBe('Could not open the file. Check that the selected editor is installed.')
    expect(JSON.stringify(error)).not.toContain('credentials')
    adapter.openPath.mockResolvedValueOnce('private OS diagnostic')
    expect(
      await run(root, adapter, client =>
        Effect.flip(client['checkout:openFile']({ projectId, path: 'file.txt', editor: 'system' })),
      ),
    ).toMatchObject({ code: 'failed' })
  })
})
