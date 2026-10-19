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
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, seen)
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
      const declarations = constants.get(node.text)
      if (declarations.length !== 1) throw new Error(`ambiguous SQL binding in ${name}: ${node.text}`)
      const initializer = declarations[0]
      if (!(initializer.parent.parent.flags & ts.NodeFlags.Const)) {
        throw new Error(`mutable SQL binding in ${name}: ${node.text}`)
      }
      return literal(initializer, new Set([...seen, node.text]))
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.map(element => literal(element, seen))
      if (values.every(value => typeof value === 'string')) return values
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left, seen)
      const right = literal(node.right, seen)
      if (typeof left === 'string' && typeof right === 'string') return left + right
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text
      for (const span of node.templateSpans) {
        const part = literal(span.expression, seen)
        if (typeof part !== 'string') throw new Error(`expected static SQL text in ${name}`)
        value += part + span.literal.text
      }
      return value
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'join' &&
      node.arguments.length === 1
    ) {
      const values = literal(node.expression.expression, seen)
      const separator = literal(node.arguments[0], seen)
      if (Array.isArray(values) && typeof separator === 'string') return values.join(separator)
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
      if (!ts.isNoSubstitutionTemplateLiteral(node.template)) {
        throw new Error(`parameterized SQL template in ${name}`)
      }
      queries.push(literal(node.template))
    }
    ts.forEachChild(node, findQuery)
  }
  findQuery(spans[0])
  if (queries.length !== 1 || typeof queries[0] !== 'string' || !/^\s*SELECT\b/i.test(queries[0])) {
    throw new Error(`expected one SELECT in ${name}, found ${queries.length} SQL statements`)
  }
  return queries[0]
}

module.exports = { extractReadSql }
