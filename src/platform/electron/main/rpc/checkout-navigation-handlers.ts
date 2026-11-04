import { extname } from 'node:path'

import * as Effect from 'effect/Effect'

import { regularFileSize, resolveContainedPath } from '@/infrastructure/workspace/checkout-inspector-paths.js'
import {
  type CheckoutEditor,
  CheckoutNavigationError,
  checkoutNavigationMessages,
  CheckoutNavigationRpcGroup,
} from '@/shared/rpc/checkout-navigation.js'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'

export interface CheckoutNavigationNative {
  readonly openPath: (absolute: string) => Promise<string>
  readonly openExternal: (uri: string) => Promise<void>
  readonly reveal: (absolute: string) => void | Promise<void>
}

const native: CheckoutNavigationNative = {
  openPath: async absolute => (await import('electron')).shell.openPath(absolute),
  openExternal: async uri => (await import('electron')).shell.openExternal(uri),
  reveal: async absolute => {
    ;(await import('electron')).shell.showItemInFolder(absolute)
  },
}
const DOCUMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.xml',
  '.log',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.avif',
  '.ico',
])

function failure(code: CheckoutNavigationError['code']): CheckoutNavigationError {
  return new CheckoutNavigationError({ code, message: checkoutNavigationMessages[code] })
}

export function checkoutEditorUri(editor: Exclude<CheckoutEditor, 'system'>, absolute: string): string {
  const schemes = { vscode: 'vscode', cursor: 'cursor', vscodium: 'vscodium' } as const
  const normalized = absolute.replaceAll('\\', '/')
  const encoded = normalized
    .split('/')
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
  return `${schemes[editor]}://file${encoded.startsWith('/') ? encoded : `/${encoded}`}`
}

export function checkoutNavigationHandlers<R = never>(options: {
  readonly resolveCheckoutPath: (scope: CheckoutScope) => Effect.Effect<string, unknown, R>
  readonly native?: CheckoutNavigationNative | undefined
}) {
  const adapter = options.native ?? native
  const file = Effect.fn('CheckoutNavigation.file')(function* (request: CheckoutScope & { readonly path: string }) {
    const root = yield* options.resolveCheckoutPath(request).pipe(Effect.mapError(() => failure('unavailable')))
    const target = yield* resolveContainedPath(root, request.path).pipe(
      Effect.mapError(error => failure(error.code === 'outside-checkout' ? 'outside-checkout' : 'not-found')),
    )
    const info = yield* regularFileSize(target.absolute).pipe(Effect.mapError(() => failure('not-found')))
    if (!info.isFile()) return yield* failure('not-found')
    return target.absolute
  })
  return CheckoutNavigationRpcGroup.toLayer({
    'checkout:openFile': request =>
      Effect.gen(function* () {
        const absolute = yield* file(request)
        const editor = request.editor ?? 'vscode'
        if (editor === 'system') {
          if (!DOCUMENT_EXTENSIONS.has(extname(absolute).toLowerCase())) return yield* failure('choose-editor')
          const result = yield* Effect.tryPromise({
            try: () => adapter.openPath(absolute),
            catch: () => failure('failed'),
          })
          if (result) return yield* failure('failed')
        } else
          yield* Effect.tryPromise({
            try: () => adapter.openExternal(checkoutEditorUri(editor, absolute)),
            catch: () => failure('failed'),
          })
      }),
    'checkout:revealFile': request =>
      Effect.gen(function* () {
        const absolute = yield* file(request)
        yield* Effect.tryPromise({
          try: async () => {
            await adapter.reveal(absolute)
          },
          catch: () => failure('failed'),
        })
      }),
  })
}
