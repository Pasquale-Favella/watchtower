import { readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const roots = [
  'src/main/view-aggregate-calculation.ts',
  'src/main/views-calculation.ts',
  'src/main/canonical-session-project.ts',
  'src/main/store-rows-calculation.ts',
  'src/main/session-search-calculation.ts',
  'src/main/session-detail-calculation.ts',
  'src/main/ledger-mcp-calculation.ts',
  'src/main/sessions-calculation.ts',
  'src/main/models-calculation.ts',
  'src/main/overview-calculation.ts',
  'src/main/spend-calculation.ts',
  'src/main/compare-calculation.ts',
  'src/main/pull-requests-calculation.ts',
  'src/main/skills-calculation.ts',
  'src/main/yield-calculation.ts',
  'src/main/optimize-calculation.ts',
  'src/main/export-calculation.ts',
  'src/main/export-rows-calculation.ts',
  'src/main/fx-calculation.ts',
  'src/main/pipeline/pr-attribution.ts',
  'src/main/overview-scope.ts',
  'src/main/store/aggregate-calculation.ts',
  'src/main/pipeline/parser-calculations.ts',
]
const forbiddenModule =
  /\/main\/(?:pipeline\/(?:models|parser|sessions-report)|store\/(?:query-snapshot|ledger|ledger-repository|port)|(?:skills|yield|optimize)-view)\.ts$/
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
        'src/main/application/view-queries.ts',
        'src/main/application/sessions-query.ts',
        'src/main/application/models-query.ts',
        'src/main/application/overview-query.ts',
        'src/main/application/spend-query.ts',
        'src/main/application/compare-query.ts',
        'src/main/application/pull-requests-query.ts',
        'src/main/application/skills-query.ts',
        'src/main/application/yield-query.ts',
        'src/main/application/optimize-query.ts',
        'src/main/application/export-query.ts',
        'src/main/application/store-row-queries.ts',
        'src/main/application/session-search-query.ts',
        'src/main/application/session-detail-query.ts',
        'src/main/application/ledger-mcp-query.ts',
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
