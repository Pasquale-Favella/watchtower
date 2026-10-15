import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'
import { expect, it } from 'vitest'

it('keeps Watchtower contracts free of Zod imports and direct dependencies', () => {
  const imports: string[] = []
  for (const root of ['src', 'tests', 'scripts', 'e2e']) {
    for (const relative of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(relative)) continue
      const file = join(root, relative)
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          /^zod(?:\/|$)/.test(node.moduleSpecifier.text)
        ) {
          imports.push(`${file}: ${node.moduleSpecifier.text}`)
        }
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          /^zod(?:\/|$)/.test(node.arguments[0].text)
        ) {
          imports.push(`${file}: ${node.arguments[0].text}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  expect(imports).toEqual([])

  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  for (const declarations of [manifest, lock.packages['']]) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(Object.keys(declarations[field] ?? {})).not.toContain('zod')
    }
  }
})
