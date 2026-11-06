const { spawnSync } = require('node:child_process')
const { readFileSync, readdirSync } = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// Intentional Windows process smoke coverage even without platform skip guards.
// Platform-guarded suites are discovered automatically from tests/, not listed here.
const BASELINE_SUITES = [
  'tests/agents-process-tree.test.ts',
  'tests/command-runner.test.ts',
  'tests/command-runner-start.test.ts',
  'tests/command-runner-fast-exit.test.ts',
]

function testFiles(root) {
  const files = []
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && /\.(?:test|spec)\.[jt]sx?$/.test(entry.name)) files.push(file)
    }
  }
  walk(path.join(root, 'tests'))
  return files.sort()
}

function windowsOnlyInFile(file, root) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const relative = path.relative(root, file).replace(/\\/g, '/')
  if (source.parseDiagnostics.length) throw new Error(relative + ': TypeScript test source could not be parsed')

  // Support simple module-level aliases such as const isWindows = process.platform === 'win32'.
  const aliases = new Map()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        aliases.set(declaration.name.text, declaration.initializer)
  }

  function evaluate(node, platform, seen = new Set()) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return evaluate(node.expression, platform, seen)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (ts.isPropertyAccessExpression(node) && node.getText(source) === 'process.platform') return platform
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'osPlatform' && node.arguments.length === 0)
      return platform
    if (ts.isIdentifier(node) && aliases.has(node.text) && !seen.has(node.text)) {
      const next = new Set(seen)
      next.add(node.text)
      return evaluate(aliases.get(node.text), platform, next)
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      return !evaluate(node.operand, platform, seen)
    if (ts.isBinaryExpression(node)) {
      const left = evaluate(node.left, platform, seen)
      const operator = node.operatorToken.kind
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return left && evaluate(node.right, platform, seen)
      if (operator === ts.SyntaxKind.BarBarToken) return left || evaluate(node.right, platform, seen)
      const right = evaluate(node.right, platform, seen)
      if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken)
        return left === right
      if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken)
        return left !== right
    }
    throw new Error(relative + ': unsupported platform guard: ' + node.getText(source))
  }

  const found = []
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'skipIf' || node.expression.name.text === 'runIf')
    ) {
      const owner = node.expression.expression
      const outer = node.parent
      if (
        !ts.isIdentifier(owner) ||
        !['it', 'test'].includes(owner.text) ||
        node.arguments.length !== 1 ||
        !ts.isCallExpression(outer) ||
        outer.expression !== node ||
        !outer.arguments.length ||
        !(ts.isStringLiteral(outer.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(outer.arguments[0]))
      )
        throw new Error(
          relative +
            ': unsupported conditional test near line ' +
            (source.getLineAndCharacterOfPosition(node.pos).line + 1),
        )
      const runs = platform => {
        const active = Boolean(evaluate(node.arguments[0], platform))
        return node.expression.name.text === 'skipIf' ? !active : active
      }
      if (runs('win32') && !runs('linux') && !runs('darwin'))
        found.push({ file: relative, title: outer.arguments[0].text })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function discoverWindowsTests(root) {
  const discovered = testFiles(root).flatMap(file => windowsOnlyInFile(file, root))
  if (!discovered.length) throw new Error('No Windows-only guards discovered; refusing an unverified run')
  const seen = new Set()
  for (const test of discovered) {
    const key = test.file + '\n' + test.title
    if (seen.has(key)) throw new Error('Ambiguous duplicate Windows test name: ' + key)
    seen.add(key)
  }
  return discovered
}

function suitesToRun(discovered) {
  return [...new Set([...BASELINE_SUITES, ...discovered.map(test => test.file)])].sort()
}

function verify(report, discovered) {
  if (report.success !== true || !Array.isArray(report.testResults))
    throw new Error('Vitest did not produce a successful JSON report')
  for (const { file, title } of discovered) {
    const suites = report.testResults.filter(suite => {
      const name = typeof suite.name === 'string' ? suite.name.replace(/\\/g, '/') : ''
      return name === file || name.endsWith('/' + file)
    })
    if (suites.length !== 1) throw new Error(file + ': expected exactly one executed suite, got ' + suites.length)
    const matches = (suites[0].assertionResults ?? []).filter(assertion => assertion.title === title)
    if (matches.length !== 1 || matches[0].status !== 'passed')
      throw new Error(
        file + ': Windows-only test not passed: ' + title + ' (' + (matches[0]?.status ?? 'missing') + ')',
      )
    console.log('PASS ' + file + ': ' + title)
  }
  console.log('Verified ' + discovered.length + ' auto-discovered Windows-only assertions.')
}

function run(root = path.resolve(__dirname, '..')) {
  if (process.platform !== 'win32') throw new Error('Windows coverage must run on a native win32 runner')
  const discovered = discoverWindowsTests(root)
  const suites = suitesToRun(discovered)
  console.log('Discovered ' + discovered.length + ' Windows-only cases. Running ' + suites.length + ' suites:')
  for (const file of suites) console.log('  ' + file)
  const report = path.join(root, 'win32-vitest-results.json')
  const runner = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
  const result = spawnSync(
    process.execPath,
    [runner, 'run', ...suites, '--reporter=default', '--reporter=json', '--outputFile.json=' + report],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Vitest Windows regression run failed with exit code ' + result.status)
  verify(JSON.parse(readFileSync(report, 'utf8')), discovered)
}

module.exports = { discoverWindowsTests, suitesToRun, verify }

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/ci-verify-win32-tests.cjs')
    run()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
