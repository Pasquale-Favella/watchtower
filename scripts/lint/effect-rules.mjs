const runMethods = /^(runSync|runPromise|runFork|runCallback)/

function memberName(node) {
  return node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    ? node.property.name
    : undefined
}

function importedEffectBindings(program) {
  const namespaces = new Set()
  const effectBarrels = new Set()
  const methods = new Map()

  for (const declaration of program.body) {
    if (declaration.type !== 'ImportDeclaration' || typeof declaration.source.value !== 'string') continue
    const source = declaration.source.value
    if (source !== 'effect' && source !== 'effect/Effect') continue

    for (const specifier of declaration.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        if (source === 'effect/Effect') namespaces.add(specifier.local.name)
        else effectBarrels.add(specifier.local.name)
      } else if (specifier.type === 'ImportSpecifier') {
        const imported = specifier.imported.name ?? specifier.imported.value
        if (source === 'effect' && imported === 'Effect') namespaces.add(specifier.local.name)
        else if (source === 'effect/Effect') methods.set(specifier.local.name, imported)
      } else if (specifier.type === 'ImportDefaultSpecifier' && source === 'effect/Effect') {
        namespaces.add(specifier.local.name)
      }
    }
  }

  return { namespaces, effectBarrels, methods }
}

function isEffectNamespace(node, bindings) {
  if (node.type === 'Identifier') return bindings.namespaces.has(node.name)
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === 'Effect' &&
    node.object.type === 'Identifier' &&
    bindings.effectBarrels.has(node.object.name)
  )
}

function isEffectCall(node, method, bindings) {
  if (node.type !== 'CallExpression') return false
  const directMethod = node.callee.type === 'Identifier' ? bindings.methods.get(node.callee.name) : undefined
  return (
    directMethod === method || (memberName(node.callee) === method && isEffectNamespace(node.callee.object, bindings))
  )
}

function isRunCall(node, bindings) {
  if (node.type !== 'CallExpression') return false
  const method = node.callee.type === 'Identifier' ? bindings.methods.get(node.callee.name) : memberName(node.callee)
  if (!method || !runMethods.test(method)) return false
  if (node.callee.type === 'Identifier') return bindings.methods.has(node.callee.name)
  return isEffectNamespace(node.callee.object, bindings)
}

const noBareThrowInEffectSync = {
  meta: {
    type: 'problem',
    docs: { description: 'Flag throws executed as Effect defects inside Effect.sync callbacks' },
    schema: [],
    messages: {
      defect:
        'This throw runs inside Effect.sync and becomes a defect. Use Effect.try for a synchronous throw that should become a typed failure; throws adapted by Effect.try/tryPromise are allowed.',
    },
  },
  create(context) {
    const bindings = importedEffectBindings(context.sourceCode.ast)
    return {
      ThrowStatement(node) {
        let current = node.parent
        while (current) {
          if (
            current.type === 'TryStatement' &&
            current.handler &&
            node.range[0] >= current.block.range[0] &&
            node.range[1] <= current.block.range[1]
          )
            break
          if (current.type === 'CallExpression' && isEffectCall(current, 'try', bindings)) break
          if (current.type === 'CallExpression' && isEffectCall(current, 'tryPromise', bindings)) break
          if (current.type === 'CallExpression' && isEffectCall(current, 'sync', bindings)) {
            const callback = current.arguments[0]
            let nearestFunction = node.parent
            while (
              nearestFunction &&
              !['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(nearestFunction.type)
            ) {
              nearestFunction = nearestFunction.parent
            }
            if (
              callback &&
              node.range[0] >= callback.range[0] &&
              node.range[1] <= callback.range[1] &&
              (!nearestFunction || nearestFunction === callback)
            ) {
              context.report({ node, messageId: 'defect' })
            }
            break
          }
          current = current.parent
        }
      },
    }
  },
}

const noRunOutsideCompositionRoot = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep Effect execution at declared composition roots' },
    schema: [{ type: 'array', items: { type: 'string' } }],
    messages: {
      boundary:
        'Static `Effect.run*` calls belong at a process composition root (ADR 0032). Return the Effect and let its owner execute it.',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/')
    const allowed = new Set(context.options[0] ?? [])
    const root = filename.split('/').slice(-4).join('/')
    const normalized = filename.includes('/src/') ? filename.slice(filename.indexOf('/src/') + 1) : filename
    const relative = normalized.replace(/^\/+/, '')
    const isAllowed = allowed.has(relative) || [...allowed].some(entry => relative.endsWith(entry)) || allowed.has(root)
    if (isAllowed) return {}

    const bindings = importedEffectBindings(context.sourceCode.ast)
    return {
      CallExpression(node) {
        if (isRunCall(node, bindings)) context.report({ node, messageId: 'boundary' })
      },
    }
  },
}

export const effectLintPlugin = {
  meta: { name: 'watchtower-effect-lint' },
  rules: {
    'no-bare-throw-in-sync': noBareThrowInEffectSync,
    'no-run-outside-composition-root': noRunOutsideCompositionRoot,
  },
}
