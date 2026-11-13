import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'

import { CheckoutInspection } from '@/core/ports/checkout-inspection.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { checkoutImagePreviewDataUrl, CheckoutInspectionLive } from '@/infrastructure/workspace/checkout-inspector.js'
import { CHECKOUT_FILE_MAX_BYTES, fileContentSchema } from '@/shared/schemas/checkout-inspection.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=',
  'base64',
)
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory)
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}watchtower-image-preview-`))
      throw new Error('Unexpected test directory')
    rmSync(absolute, { recursive: true, force: true })
  }
})

describe('checkout image previews', () => {
  it.each([
    ['png', PNG],
    ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['gif', Buffer.from('GIF89a\x01\0\x01\0\0\0\0', 'binary')],
    ['webp', Buffer.from('RIFF\x08\0\0\0WEBPVP8 ', 'binary')],
    ['bmp', Buffer.concat([Buffer.from('BM'), Buffer.alloc(24)])],
  ])('detects %s from file bytes', (kind, bytes) => {
    expect(checkoutImagePreviewDataUrl(bytes, false)).toBe(`data:image/${kind};base64,${bytes.toString('base64')}`)
  })

  it('refuses unsupported, empty and truncated image data', () => {
    expect(checkoutImagePreviewDataUrl(Buffer.from('<svg><script>alert(1)</script></svg>'), false)).toBeNull()
    expect(checkoutImagePreviewDataUrl(Buffer.alloc(0), false)).toBeNull()
    expect(checkoutImagePreviewDataUrl(PNG, true)).toBeNull()
    expect(checkoutImagePreviewDataUrl(Buffer.alloc(CHECKOUT_FILE_MAX_BYTES + 1), false)).toBeNull()
    expect(
      Schema.is(fileContentSchema)({
        path: 'x',
        size: 1,
        binary: true,
        content: null,
        truncated: false,
        previewDataUrl: 'data:text/html;base64,PGI+eDwvYj4=',
      }),
    ).toBe(false)
  })

  it('returns an image preview independent of its extension and leaves text responses unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'watchtower-image-preview-'))
    directories.push(root)
    writeFileSync(join(root, 'image.bin'), PNG)
    writeFileSync(join(root, 'plain.txt'), 'plain text\n')
    writeFileSync(join(root, 'large.png'), Buffer.concat([PNG, Buffer.alloc(CHECKOUT_FILE_MAX_BYTES)]))
    const runtime = ManagedRuntime.make(
      CheckoutInspectionLive.pipe(Layer.provideMerge(CommandRunnerLive), Layer.provide(NodePlatformLive)),
    )
    try {
      const inspection = await runtime.runPromise(CheckoutInspection)
      const image = await runtime.runPromise(inspection.readFile(root, 'image.bin'))
      expect(image).toMatchObject({
        binary: true,
        content: null,
        truncated: false,
        previewDataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
      })
      expect(Schema.is(fileContentSchema)(image)).toBe(true)
      expect(await runtime.runPromise(inspection.readFile(root, 'plain.txt'))).toEqual({
        path: 'plain.txt',
        revision: expect.any(String),
        size: 11,
        binary: false,
        content: 'plain text\n',
        truncated: false,
      })
      const large = await runtime.runPromise(inspection.readFile(root, 'large.png'))
      expect(large).toMatchObject({ binary: true, truncated: false })
      expect(large.previewDataUrl?.startsWith('data:image/png;base64,')).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
