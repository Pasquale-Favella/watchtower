import { readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const roots = [
  'src/core/analytics/metrics/view-aggregate-calculation.ts',
  'src/core/analytics/projections/views-calculation.ts',
  'src/core/domain/sessions/canonical-session-project.ts',
  'src/core/analytics/projections/store-rows-calculation.ts',
  'src/core/analytics/projections/session-search-calculation.ts',
  'src/core/analytics/projections/session-detail-calculation.ts',
  'src/core/analytics/projections/ledger-mcp-calculation.ts',
  'src/core/analytics/projections/sessions-calculation.ts',
  'src/core/analytics/projections/models-calculation.ts',
  'src/core/analytics/projections/overview-calculation.ts',
  'src/core/analytics/projections/spend-calculation.ts',
  'src/core/analytics/projections/compare-calculation.ts',
  'src/core/analytics/projections/pull-requests-calculation.ts',
  'src/core/analytics/detectors/skills-calculation.ts',
  'src/core/analytics/attribution/yield-calculation.ts',
  'src/core/analytics/detectors/optimize-calculation.ts',
  'src/core/analytics/projections/export-calculation.ts',
  'src/core/analytics/projections/export-rows-calculation.ts',
  'src/core/analytics/projections/fx-calculation.ts',
  'src/core/analytics/attribution/pr-attribution.ts',
  'src/core/domain/sessions/overview-scope.ts',
  'src/core/analytics/projections/aggregate-calculation.ts',
  'src/core/ingestion/normalization/parser-calculations.ts',
]
const forbiddenModule = /\/src\/(?:infrastructure|platform|renderer)\//
const forbiddenPackage = /^(?:electron|node:|fs(?:\/|$)|path$)/

function runtimeImports(filePath: string, source = readFileSync(filePath, 'utf8')): string[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
  const imports: string[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      const clause = statement.importClause
      if (
        clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every(element => element.isTypeOnly)
      )
        continue
      if (ts.isStringLiteral(statement.moduleSpecifier)) imports.push(statement.moduleSpecifier.text)
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      if (
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length > 0 &&
        statement.exportClause.elements.every(element => element.isTypeOnly)
      )
        continue
      imports.push(statement.moduleSpecifier.text)
    }
  }
  return imports
}

function resolveLocalImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const resolved = resolve(dirname(fromFile), specifier)
  const basePath = extname(resolved) === '.js' ? resolved.slice(0, -3) : resolved
  const candidates = extname(basePath)
    ? [basePath]
    : [`${basePath}.ts`, `${basePath}.tsx`, resolve(basePath, 'index.ts')]
  return candidates.find(candidate => {
    try {
      readFileSync(candidate)
      return true
    } catch {
      return false
    }
  })
}

describe('pure view calculation boundary', () => {
  it('keeps the runtime import graph free of legacy, IO, and Electron modules', () => {
    expect(graphViolations(roots, true)).toEqual([])
  })

  it('keeps the canonical application query graph on ports instead of repository implementations', () => {
    expect(
      graphViolations([
        'src/core/application/queries/view-queries.ts',
        'src/core/application/queries/sessions-query.ts',
        'src/core/application/queries/models-query.ts',
        'src/core/application/queries/overview-query.ts',
        'src/core/application/queries/spend-query.ts',
        'src/core/application/queries/compare-query.ts',
        'src/core/application/queries/pull-requests-query.ts',
        'src/core/application/queries/skills-query.ts',
        'src/core/application/queries/yield-query.ts',
        'src/core/application/queries/optimize-query.ts',
        'src/core/application/queries/export-query.ts',
        'src/core/application/queries/store-row-queries.ts',
        'src/core/application/queries/session-search-query.ts',
        'src/core/application/queries/session-detail-query.ts',
        'src/core/application/queries/ledger-mcp-query.ts',
      ]),
    ).toEqual([])
  })

  it('ignores type-only named imports and re-exports while retaining runtime dependencies', () => {
    expect(
      runtimeImports(
        'fixture.ts',
        "import { type X } from 'node:fs'; export { type Y } from 'effect'; import { type Z, value } from 'effect/Effect'",
      ),
    ).toEqual(['effect/Effect'])
  })
})

function graphViolations(rootPaths: string[], pure = false): string[] {
  const pending = rootPaths.map(path => resolve(path))
  const visited = new Set<string>()
  const forbidden: string[] = []

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    if (visited.has(current)) continue
    visited.add(current)
    for (const specifier of runtimeImports(current)) {
      if (forbiddenPackage.test(specifier) || (pure && /^effect(?:\/|$)/.test(specifier)))
        forbidden.push(`${current}: ${specifier}`)
      const dependency = resolveLocalImport(current, specifier)
      if (specifier.startsWith('.') && !dependency) forbidden.push(`${current}: unresolved ${specifier}`)
      if (dependency) {
        if (forbiddenModule.test(dependency.replace(/\\/g, '/'))) forbidden.push(`${current}: ${specifier}`)
        pending.push(dependency)
      }
    }
  }

  return forbidden
}
