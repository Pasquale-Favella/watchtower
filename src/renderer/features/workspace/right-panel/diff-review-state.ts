import * as Schema from 'effect/Schema'

import {
  type CheckoutScope,
  checkoutScopeSchema,
  type DiffFile,
  type DiffSource,
  type DiffSourceSelector,
  diffSourceSelectorSchema,
} from '@/shared/schemas/checkout-inspection.js'

import { diffFileKey } from './diff-tree.js'

export const diffPreferencesSchema = Schema.Struct({
  layout: Schema.Literals(['unified', 'split']),
  wrap: Schema.Boolean,
  showTree: Schema.Boolean,
  hideTests: Schema.Boolean,
  ignoreWhitespace: Schema.Boolean,
})
export type DiffReviewPreferences = Schema.Schema.Type<typeof diffPreferencesSchema>

export const DEFAULT_DIFF_PREFERENCES: DiffReviewPreferences = {
  layout: 'split',
  wrap: false,
  showTree: false,
  hideTests: false,
  ignoreWhitespace: false,
}
export const DIFF_PREFERENCES_KEY = 'watchtower.workspace.diff-preferences.v1'
export const DIFF_EXPANDED_KEY = 'watchtower.workspace.diff-expanded.v1'
const expandedSchema = Schema.Record(Schema.String, Schema.Array(Schema.String))

export function readDiffPreferences(storage: Pick<Storage, 'getItem'> | null): DiffReviewPreferences {
  try {
    const value = Schema.decodeUnknownOption(diffPreferencesSchema)(
      JSON.parse(storage?.getItem(DIFF_PREFERENCES_KEY) ?? 'null'),
    )
    if (value._tag === 'Some') return value.value
  } catch {
    /* An unavailable store uses the default view. */
  }
  return DEFAULT_DIFF_PREFERENCES
}

export function readExpandedDiffs(storage: Pick<Storage, 'getItem'> | null, key: string): ReadonlySet<string> {
  try {
    const value = Schema.decodeUnknownOption(expandedSchema)(JSON.parse(storage?.getItem(DIFF_EXPANDED_KEY) ?? '{}'))
    if (value._tag === 'Some') return new Set(value.value[key] ?? [])
  } catch {
    /* Folding remains local when storage is unavailable. */
  }
  return new Set()
}

export function writeExpandedDiffs(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  key: string,
  paths: ReadonlySet<string>,
): void {
  try {
    const result = Schema.decodeUnknownOption(expandedSchema)(JSON.parse(storage?.getItem(DIFF_EXPANDED_KEY) ?? '{}'))
    const previous = result._tag === 'Some' ? result.value : {}
    const entries = Object.entries(previous)
      .filter(([id]) => id !== key)
      .slice(-99)
    storage?.setItem(DIFF_EXPANDED_KEY, JSON.stringify(Object.fromEntries([...entries, [key, [...paths]]])))
  } catch {
    /* Folding remains local when storage is unavailable. */
  }
}

export function collapsedDiffFileKeys(files: readonly DiffFile[], expanded: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(files.map(diffFileKey).filter(key => !expanded.has(key)))
}

export function isTestDiffPath(path: string): boolean {
  const segments = path.replaceAll('\\', '/').split('/')
  const name = segments.pop() ?? ''
  const directories = segments.map(segment => segment.toLowerCase())
  if (
    GENERATED_FILES.has(name.toLowerCase()) ||
    GENERATED_NAME.test(name) ||
    directories.some(directory => GENERATED_DIRS.has(directory))
  )
    return false
  if (MOCK_NAME.test(name) || directories.some(directory => MOCK_DIRS.has(directory))) return true
  return TEST_NAME.test(name) || CLASS_TEST_NAME.test(name) || directories.some(directory => TEST_DIRS.has(directory))
}

const GENERATED_FILES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'deno.lock',
  'flake.lock',
  'gemfile.lock',
  'go.sum',
  'gradle.lockfile',
  'mix.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'packages.lock.json',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'podfile.lock',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
])
const GENERATED_NAME =
  /(\.generated\.|\.gen\.|\.g\.dart$|\.pb\.go$|_pb2(_grpc)?\.py$|\.pb\.(cc|h)$|\.min\.(js|css)$|\.(js|css)\.map$)/
const GENERATED_DIRS = new Set(['__generated__', '_generated', 'generated'])
const MOCK_NAME = /(\.snap$|\.(mocks?|fixtures?|stubs?|fakes?)\.[^.]+$|^(mocks?|fixtures?|stubs?|fakes?)([-_.A-Z]|$))/
const MOCK_DIRS = new Set([
  '__fixtures__',
  '__mocks__',
  '__snapshots__',
  'fakes',
  'fixture',
  'fixtures',
  'mock',
  'mocks',
  'stubs',
  'testdata',
])
const TEST_NAME =
  /(\.(test|spec|e2e|eval)\.[^.]+$|_(test|spec)\.[^.]+$|^test_.+\.py$|^conftest\.py$|^(vitest|jest)\.setup\.[^.]+$)/i
const CLASS_TEST_NAME = /(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$/
const TEST_DIRS = new Set(['__tests__', '__test__', 'cypress', 'e2e', 'evals', 'spec', 'specs', 'test', 'tests'])

export function shownDiffFiles(
  files: readonly DiffFile[],
  hideTests: boolean,
  selectedPath: string | null,
): readonly DiffFile[] {
  return files.filter(file => !hideTests || file.path === selectedPath || !isTestDiffPath(file.path))
}

/** Repeat the resolved comparison so a subsequent patch uses the list's base and commit. */
export function resolvedDiffSelector(source: DiffSource, ignoreWhitespace: boolean): DiffSourceSelector {
  if (source.kind === 'commit') return { kind: 'commit', commit: source.headRef ?? source.id, ignoreWhitespace }
  if (source.kind === 'staged') return { kind: 'staged', ignoreWhitespace }
  if (source.kind === 'branch-range')
    return { kind: 'branch-range', ...(source.baseRef ? { baseRef: source.baseRef } : {}), ignoreWhitespace }
  return { kind: 'working-tree', ignoreWhitespace }
}

export function diffFileTitle(file: Pick<DiffFile, 'path' | 'previousPath'>): string {
  return file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
}

const reviewSectionSchema = Schema.Struct({
  kind: Schema.Literal('checkout-diff'),
  scope: checkoutScopeSchema,
  source: diffSourceSelectorSchema,
})

export function diffReviewSectionId(scope: CheckoutScope, source: DiffSource, ignoreWhitespace: boolean): string {
  return JSON.stringify({ kind: 'checkout-diff', scope, source: resolvedDiffSelector(source, ignoreWhitespace) })
}

export function readDiffReviewSection(value: string): Schema.Schema.Type<typeof reviewSectionSchema> | null {
  try {
    const decoded = Schema.decodeUnknownOption(reviewSectionSchema)(JSON.parse(value))
    return decoded._tag === 'Some' ? decoded.value : null
  } catch {
    return null
  }
}
