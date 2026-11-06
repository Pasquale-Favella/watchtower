import { realpath } from 'node:fs'
import { lstat, open, readdir, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import * as Effect from 'effect/Effect'

import { CheckoutInspectionError } from '@/core/ports/checkout-inspection.js'
import { isContainedCheckoutPath } from '@/shared/schemas/checkout-inspection.js'

type Code = CheckoutInspectionError['code']

const fail = (code: Code, message: string) => new CheckoutInspectionError({ code, message })

/** Node's native realpath keeps the on-disk case on Windows, as checkout-resolver does. */
export const canonicalPath = (target: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolvePath, reject) =>
        realpath.native(target, (error, value) => (error ? reject(error) : resolvePath(value))),
      ),
    catch: () => fail('path-not-found', 'Cannot canonicalize the checkout path'),
  })

/** True when `candidate` is `root` itself or a descendant. Both arguments must already be canonical. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const local = relative(root, candidate)
  return local === '' || !(local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
}

const hasGitSegment = (path: string) => path.split(/[\\/]/).some(segment => segment.toLowerCase() === '.git')

/**
 * Resolves a checkout-relative path to its real location. The lexical check rejects absolute and parent
 * forms before the filesystem is touched; the realpath check rejects links that leave the checkout.
 * An empty path names the checkout root.
 */
export const resolveContainedPath = Effect.fn('CheckoutInspection.resolveContainedPath')(function* (
  root: string,
  path: string,
) {
  return yield* resolveInCanonicalRoot(yield* canonicalPath(root), path)
})

/** Same containment rules for callers that canonicalized the checkout root once for many paths. */
export const resolveInCanonicalRoot = Effect.fn('CheckoutInspection.resolveInCanonicalRoot')(function* (
  canonicalRoot: string,
  path: string,
) {
  if (path !== '' && !isContainedCheckoutPath(path))
    return yield* fail('outside-checkout', 'Path must stay inside the checkout')
  if (path === '') return { root: canonicalRoot, absolute: canonicalRoot, path }
  // The native realpath also expands Windows short names, so `GIT~1` resolves to `.git` before the check.
  const target = yield* canonicalPath(resolve(canonicalRoot, path)).pipe(
    Effect.mapError(() => fail('path-not-found', 'The path was not found in the checkout')),
  )
  const local = relative(canonicalRoot, target)
  if (!isInsideRoot(canonicalRoot, target) || hasGitSegment(local))
    return yield* fail('outside-checkout', 'Link targets must stay inside the checkout')
  return { root: canonicalRoot, absolute: target, path }
})

/** Lists what the filesystem reports at one level without following links. */
export const readDirectoryEntries = (directory: string) =>
  Effect.tryPromise({
    try: () => readdir(directory, { withFileTypes: true }),
    catch: () => fail('path-not-found', 'The directory could not be read'),
  })

/** Symbolic-link-aware metadata for one entry. The entry is not followed. */
export const entryMetadata = (absolute: string) =>
  Effect.tryPromise({
    try: () => lstat(absolute),
    catch: () => fail('path-not-found', 'The entry could not be inspected'),
  })

/** Regular-file metadata after containment has already resolved the target. */
export const regularFileSize = (absolute: string) =>
  Effect.tryPromise({
    try: () => stat(absolute),
    catch: () => fail('path-not-found', 'The file could not be inspected'),
  })

/** Reads at most `limit` bytes from a regular file and reports whether more content exists. */
export const readBoundedFile = (absolute: string, limit: number) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(absolute, 'r')
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Error('not a regular file')
        const bytes = Buffer.alloc(Math.min(info.size, limit))
        let length = 0
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, length)
          if (!result.bytesRead) break
          length += result.bytesRead
        }
        return { bytes: bytes.subarray(0, length), size: info.size, truncated: info.size > limit }
      } finally {
        await handle.close()
      }
    },
    catch: () => fail('path-not-found', 'The file could not be read'),
  })

/** Git's own binary heuristic: a NUL byte in the first 8000 bytes. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0)
}

/** Strict UTF-8 decoding; any invalid sequence makes the file unrenderable as text. */
export function decodeUtf8(bytes: Uint8Array, lossy: boolean): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: !lossy }).decode(bytes)
  } catch {
    return null
  }
}
