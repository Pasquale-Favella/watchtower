import * as Effect from 'effect/Effect'

import { CommandRunner } from '../agents/command-runner.js'

const GIT_TIMEOUT_MS = 2_000

/**
 * Ritorna l'URL del remote `origin` (o `undefined` se non c'è / non è git).
 * Non lancia mai: tutti gli errori (cwd inesistente, non-repo, remote assente,
 * git non installato, timeout) diventano `undefined`.
 */
export const getRepoUrlEffect = Effect.fnUntraced(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, CommandRunner> {
  const runner = yield* CommandRunner
  return yield* runner.run('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: GIT_TIMEOUT_MS }).pipe(
    Effect.map(result => (result.exitCode === 0 ? result.stdout.trim() || undefined : undefined)),
    Effect.catch(() => Effect.succeed(undefined)),
  )
})

/**
 * Versione breve leggibile di un URL git, per la tabella.
 * Esempi:
 *   git@github.com:user/repo.git       → github.com/user/repo
 *   https://github.com/user/repo.git   → github.com/user/repo
 *   ssh://git@gitlab.com/g/r           → gitlab.com/g/r
 */
export function shortenRepoUrl(url: string): string {
  let s = url.trim()
  // Rimuovi prefissi scheme
  s = s.replace(/^https?:\/\//, '')
  s = s.replace(/^ssh:\/\//, '')
  s = s.replace(/^git:\/\//, '')
  // SSH-style: git@host:path
  s = s.replace(/^[a-zA-Z0-9._-]+@([^:]+):/, '$1/')
  // Rimuovi credenziali user:pass@
  s = s.replace(/^[^@/]+@/, '')
  // Rimuovi .git finale
  s = s.replace(/\.git$/, '')
  return s
}
