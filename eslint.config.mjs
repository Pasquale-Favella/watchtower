// ESLint v9 owns React and repository-specific rules. The TypeScript-aware
// import resolver enforces process boundaries through resolved paths, including
// TypeScript aliases and arbitrarily deep relative imports. Effect's language
// service runs through `lint:effect`; local AST rules cover composition roots
// and throws inside `Effect.sync`, where failures become defects. Prettier owns
// formatting, and Effect's plugin enforces subpath imports from the Effect
// package.
//
// Vendored `.agents/` content and hand-authored root configuration files stay
// excluded from lint and formatting as listed below.
import { builtinModules } from 'node:module'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import importX from 'eslint-plugin-import-x'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import effectPlugin from '@effect/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import prettierConfig from 'eslint-config-prettier'
import { effectLintPlugin } from './scripts/lint/effect-rules.mjs'

// Every Node builtin, bare and `node:`-prefixed, derived from the running
// runtime — no hand-kept denylist that silently omits `assert`/`buffer`/`url`
// et al. (PR #137 review). A superset across Node versions is fine: every
// entry is something the renderer must never import (ADR 0005).
const bareNodeCores = builtinModules
  .filter(name => !name.startsWith('node:') && !name.startsWith('_'))
  .flatMap(name => [name, `${name}/*`])

// ── Composition-root policy (ADR 0032) ──
// These files own a process runtime or adapt an external Promise/callback
// contract. Other main-process modules return Effects to their owner.
const EFFECT_COMPOSITION_ROOTS = [
  'src/main/main-runtime.ts',
  'src/main/worker-runtime.ts',
  'src/main/agents/runtime.ts',
  'src/main/agents/ledger-mcp/sidecar.ts',
  'src/main/agents/ledger-mcp/pool.ts',
  'src/main/agents/auth-probe.ts',
  'src/main/agents/process-tree.ts',
  'src/main/db-worker/context.ts',
  'src/main/db-worker/client.ts',
]
const processBoundaryZones = [
  {
    target: 'src/renderer/**',
    from: ['src/main/**', 'src/preload/**'],
    message: 'Renderer code must use shared contracts and the preload bridge (ADR 0005).',
  },
  {
    target: 'src/main/**',
    from: ['src/renderer/**', 'src/preload/**'],
    message: 'Main must not depend on renderer or preload code.',
  },
  {
    target: 'src/shared/**',
    from: ['src/main/**', 'src/renderer/**', 'src/preload/**'],
    message: 'Shared modules cannot depend on process-specific code.',
  },
]
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      // Kept in lockstep with .prettierignore: the vendored agent skills and
      // the hand-authored root config files are deliberately left unformatted
      // (see .prettierignore for why), so the gate does not re-litigate layout
      // on files that Prettier is not allowed to touch either.
      '.agents/**',
      'README.md',
      'electron-builder.yml',
      'electron.vite.config.ts',
      'tsconfig.json',
      'tsconfig.web.json',
      'vitest.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['src/**/*.{ts,tsx,mts,cts}'],
    plugins: { 'import-x': importX, effect: effectPlugin, 'watchtower-effect': effectLintPlugin },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          project: ['tsconfig.node.json', 'tsconfig.web.json', 'tsconfig.test.json'],
          noWarnOnMultipleProjects: true,
        }),
      ],
    },
    rules: {
      'import-x/no-restricted-paths': ['error', { basePath: import.meta.dirname, zones: processBoundaryZones }],
      'effect/no-import-from-barrel-package': ['error', { packageNames: ['effect'] }],
      'watchtower-effect/no-run-outside-composition-root': ['warn', EFFECT_COMPOSITION_ROOTS],
      'watchtower-effect/no-bare-throw-in-sync': 'warn',
    },
  },
  {
    // Scaffold warn-first set (#136): the existing tree violates these
    // pervasively (baseline @ b7be8d9: 597 non-null assertions, 241
    // unsorted import/export blocks, 62 unused vars, 8 control-char
    // sanitizer regexes, 7 dynamic cache deletes). The gate stays green
    // while behavior is unchanged; the follow-up promotes each to error
    // with its own cleanup diff instead of one giant reformatting PR.
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-dynamic-delete': 'warn',
      'no-control-regex': 'warn',
    },
  },
  {
    // Build scripts and worker fixtures use CJS (`require` + `__dirname`) — the
    // `no-require-imports` rule from strict does not apply to them.
    files: ['scripts/**/*', 'tests/fixtures/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ── Process-aware language options ──────────────────────────────────────
  {
    files: [
      'src/main/**/*.{ts,mts,cts}',
      'src/preload/**/*.ts',
      'scripts/**/*.?(c|m)js',
      'tests/**/*.ts',
      'tests/fixtures/**/*.cjs',
    ],
    languageOptions: { globals: { ...globals.node, ...globals.es2023 } },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.es2023 } },
  },
  {
    // Shared is imported by both processes (spec: "importable from both"), so
    // it gets both environments. (`no-undef` is off for TS anyway — this is
    // documentation the config checker enforces structurally elsewhere.)
    files: ['src/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.es2023 } },
  },
  {
    files: ['e2e/**/*.{ts,mts}', 'playwright.config.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.es2023 } },
  },

  // ── Renderer (TypeScript + React) ───────────────────────────────────────
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-refresh/only-export-components': 'warn',
      // `void load()` fetch-on-mount is the codebase idiom — flag new cases
      // without failing the gate (promote with the scaffold set).
      'react-hooks/set-state-in-effect': 'warn',
      // Warn-first with the rest of the scaffold set (241 unsorted blocks
      // in the baseline) — promote to error in the follow-up.
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'Renderer is sandboxed (ADR 0005) — reach Electron only through the preload bridge (`window.api`).',
            },
          ],
          patterns: [
            {
              group: [...bareNodeCores, 'node:*'],
              message:
                'Renderer is sandboxed (ADR 0005) — Node APIs live in main/preload, exposed via the preload bridge.',
            },
          ],
        },
      ],
    },
  },

  // ── Main + preload + shared + scripts/tests (no React) ──────────────────
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/shared/**/*.ts',
      'scripts/**/*',
      'tests/**/*.ts',
      'e2e/**/*',
    ],
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      // Warn-first with the rest of the scaffold set — promote in follow-up.
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      // Every site is an intentional `catch {}` swallow (cache reads, mtime
      // probes, best-effort parses) — not an accidentally empty block.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Main must not reach back into the renderer (ADR 0023: the data plane has
    // no view dependency) nor into the bridge implementation.
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: "Main has no DOM — did you mean Electron's BrowserWindow?" },
        { name: 'document', message: 'Main has no DOM — renderer-only global.' },
        { name: 'navigator', message: 'Main has no DOM — renderer-only global.' },
        { name: 'localStorage', message: 'Main has no DOM storage — persist via the ledger or settings file.' },
      ],
    },
  },
  {
    // Shared is imported by every process: no Electron, no process sources.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'Shared code runs in every process — keep Electron in main/preload.' }],
        },
      ],
    },
  },

  {
    // Preload is the sandbox seam: Electron + main *types* in, nothing else.
    // `allowTypeImports` keeps the IPC wire-type contract (`import type` from
    // ../main/**) while a value import from main — the thing that would break
    // the sandbox — fails the gate. The tree has zero value imports today.
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/main/**'],
              allowTypeImports: true,
              message:
                'Preload may only take types from main (IPC wire contract) — a value import drags main code across the sandbox seam.',
            },
          ],
        },
      ],
    },
  },

  // ── Prettier owns formatting: disable conflicting stylistic rules last ──
  prettierConfig,
)
