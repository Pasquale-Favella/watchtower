import * as Effect from 'effect/Effect'

import { readSessionFileEffect } from '../../src/main/pipeline/fs-utils.js'

/** Run a native file read from tests that assert its Promise boundary behavior. */
export function readSessionFileForTest(
  filePath: string,
  encoding?: BufferEncoding,
  options?: { readonly signal?: AbortSignal },
): Promise<string | null> {
  return Effect.runPromise(readSessionFileEffect(filePath, encoding, options))
}
