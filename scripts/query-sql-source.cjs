'use strict'

const ts = require('typescript')

/** Resolve a measured read's actual SQL argument, including shared constants.
 * Unsupported dynamic SQL or ambiguous reads stop measurement. */
function extractReadSql(source, name) {
  const file = ts.createSourceFile('ledger-repository.ts', source, ts.ScriptTarget.Latest, true)
  const constants = new Map()
  const spans = []
  const spanName = new RegExp(`^Ledger\\w+\\.${name}$`)
  function inventory(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const declarations = constants.get(node.name.text) ?? []
      declarations.push(node.initializer)
      constants.set(node.name.text, declarations)
    }
    if (ts.isStringLiteral(node) && spanName.test(node.text)) {
      const trace = node.parent
      const declaration = trace.parent
      if (
        ts.isCallExpression(trace) &&
        trace.expression.getText(file) === 'Effect.fn' &&
        trace.arguments[0] === node &&
        ts.isCallExpression(declaration) &&
        declaration.expression === trace
      ) {
        spans.push(declaration)
      }
    }
    ts.forEachChild(node, inventory)
  }
  inventory(file)
  if (spans.length !== 1) throw new Error(`expected one Effect read named ${name}, found ${spans.length}`)

  function literal(node, seen = new Set()) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
      const declarations = constants.get(node.text)
      if (declarations.length !== 1) throw new Error(`ambiguous SQL binding in ${name}: ${node.text}`)
      return literal(declarations[0], new Set([...seen, node.text]))
    }
    throw new Error(`unsupported SQL expression in ${name}: ${node.getText(file)}`)
  }

  const queries = []
  function findQuery(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === 'sql' &&
      node.expression.name.text === 'unsafe'
    ) {
      if (!node.arguments[0]) throw new Error(`missing SQL argument in ${name}`)
      queries.push(literal(node.arguments[0]))
    }
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(file) === 'sql') {
      queries.push(literal(node.template))
    }
    ts.forEachChild(node, findQuery)
  }
  findQuery(spans[0])
  if (queries.length !== 1 || !/^\s*SELECT\b/i.test(queries[0])) {
    throw new Error(`expected one SELECT in ${name}, found ${queries.length} SQL statements`)
  }
  return queries[0]
}

module.exports = { extractReadSql }
