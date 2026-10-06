import type { LedgerSessionRow } from '../shared/schemas/ledger.js'
import {
  deriveCanonicalProjectKey,
  isAbsoluteProjectPath,
  projectNameFromPath,
} from './pipeline/parser-calculations.js'

type SessionProjectFields = Pick<
  LedgerSessionRow,
  'project' | 'projectPath' | 'workingDirectory' | 'canonicalProject' | 'canonicalCwd'
>

export type CanonicalSessionProject = {
  projectKey: string
  project: string
  projectPath?: string
}

/** Use stored canonical paths without reconstructing paths from legacy labels. */
export function canonicalSessionProject(session: SessionProjectFields, provider: string): CanonicalSessionProject {
  const storedPath = session.projectPath?.trim()
  const pathCandidate = storedPath && isAbsoluteProjectPath(storedPath) ? storedPath : undefined
  const projectKey = deriveCanonicalProjectKey(pathCandidate, session.workingDirectory, provider, session.canonicalCwd)
  const canonicalPath = (session.canonicalCwd ?? session.workingDirectory ?? pathCandidate ?? '').trim()
  return {
    projectKey,
    project:
      session.canonicalProject ??
      (canonicalPath ? projectNameFromPath(canonicalPath, session.project ?? '') : projectKey),
    ...(canonicalPath ? { projectPath: canonicalPath } : {}),
  }
}
