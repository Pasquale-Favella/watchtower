import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ProjectSummary } from './types.js'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 2_000

/**
 * Ritorna l'URL del remote `origin` (o `undefined` se non c'è / non è git).
 * Non lancia mai: tutti gli errori (cwd inesistente, non-repo, remote assente,
 * git non installato, timeout) diventano `undefined`.
 */
export async function getRepoUrl(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    const url = stdout.trim()
    return url || undefined
  } catch {
    return undefined
  }
}

/**
 * Popola `repoUrl` su ogni progetto in parallelo (worker pool).
 * Ignora silenziosamente ogni fallimento — il repoUrl è puramente informativo.
 */
export async function attachRepoUrls(projects: ProjectSummary[], concurrency = 8): Promise<void> {
  const queue = [...projects]
  const workers: Promise<void>[] = []
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const project = queue.shift()
          if (!project || !project.projectPath) continue
          project.repoUrl = await getRepoUrl(project.projectPath)
        }
      })(),
    )
  }
  await Promise.all(workers)
}

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
