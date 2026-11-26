import type { ESTree, SourceCode } from '@oxlint/plugins'
import { defineRule } from '@oxlint/plugins'
import { resolveVariable } from '../shared/scope.ts'

const moduleMockMethods = new Set([
  'createMockFromModule',
  'doMock',
  'importMock',
  'mock',
  'requireMock',
  'setMock',
  'unstable_mockModule',
])
const frameworkModules = new Map([
  ['vitest', 'vi'],
  ['@jest/globals', 'jest'],
])
const globalObjects = new Set(['global', 'globalThis', 'self', 'window'])

function importedName(node: ESTree.Node): string | null {
  if (node.type !== 'ImportSpecifier') return null
  return node.imported.type === 'Identifier' ? node.imported.name : node.imported.value
}

function memberName(expression: ESTree.Expression): string | null {
  if (expression.type !== 'MemberExpression') return null
  const property = expression.property
  if (!expression.computed) return property.type === 'Identifier' ? property.name : null
  return property.type === 'Literal' && typeof property.value === 'string' ? property.value : null
}

function isFrameworkNamespace(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  name: string,
): boolean {
  if (expression.type !== 'Identifier') return false
  if (globalObjects.has(expression.name) && sourceCode.isGlobalReference(expression)) {
    return name === 'vi' || name === 'jest'
  }
  const variable = resolveVariable(sourceCode, expression)
  return (
    variable?.defs.some(
      (definition) =>
        definition.type === 'ImportBinding' &&
        definition.node.type === 'ImportNamespaceSpecifier' &&
        definition.parent?.type === 'ImportDeclaration' &&
        frameworkModules.get(definition.parent.source.value) === name,
    ) ?? false
  )
}

function isTestFrameworkObject(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  if (expression.type === 'MemberExpression') {
    const name = memberName(expression)
    return name !== null && isFrameworkNamespace(sourceCode, expression.object, name)
  }
  if (expression.type !== 'Identifier') return false
  if (
    (expression.name === 'vi' || expression.name === 'jest') &&
    sourceCode.isGlobalReference(expression)
  ) {
    return true
  }

  const variable = resolveVariable(sourceCode, expression)
  if (variable === null || variable.defs.length === 0) {
    return expression.name === 'vi' || expression.name === 'jest'
  }
  return variable.defs.some((definition) => {
    if (definition.type !== 'ImportBinding' || definition.parent?.type !== 'ImportDeclaration') {
      return false
    }
    const name = importedName(definition.node)
    return name !== null && frameworkModules.get(definition.parent.source.value) === name
  })
}

function moduleMockMember(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  if (expression.type !== 'MemberExpression') return false
  const method = memberName(expression)
  return (
    method !== null &&
    moduleMockMethods.has(method) &&
    isTestFrameworkObject(sourceCode, expression.object)
  )
}

function propertyKeyName(property: ESTree.Node): string | null {
  if (property.type !== 'Property') return null
  if (!property.computed && property.key.type === 'Identifier') return property.key.name
  return property.key.type === 'Literal' && typeof property.key.value === 'string'
    ? property.key.value
    : null
}

function bindsName(pattern: ESTree.Node, name: ESTree.Node): boolean {
  if (pattern.type === 'AssignmentPattern') return bindsName(pattern.left, name)
  return pattern.type === 'Identifier' && pattern.start === name.start
}

function aliasesModuleMock(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
  if (callee.type !== 'Identifier') return false
  const variable = resolveVariable(sourceCode, callee)
  if (variable === null) return false
  return variable.defs.some((definition) => {
    if (definition.type !== 'Variable' || definition.node.type !== 'VariableDeclarator') {
      return false
    }
    const { id, init } = definition.node
    if (init === null) return false
    if (id.type === 'Identifier') return moduleMockMember(sourceCode, init)
    if (id.type !== 'ObjectPattern' || !isTestFrameworkObject(sourceCode, init)) return false
    return id.properties.some((property) => {
      const key = propertyKeyName(property)
      return (
        key !== null &&
        moduleMockMethods.has(key) &&
        property.type === 'Property' &&
        bindsName(property.value, definition.name)
      )
    })
  })
}

function moduleMockCall(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
  return moduleMockMember(sourceCode, callee) || aliasesModuleMock(sourceCode, callee)
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces.',
    },
    messages: {
      moduleMock:
        'Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.',
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === 'Super' || node.callee.type === 'V8IntrinsicExpression') return
        if (moduleMockCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: 'moduleMock' })
        }
      },
    }
  },
})
