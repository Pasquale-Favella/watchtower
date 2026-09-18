// ESLint v9 flat config — lint gate scaffold (spins out of #123, ticket #136).
//
// What this covers:
// - `@eslint/js` recommended + `typescript-eslint` strict WITHOUT type-checking
//   (no `projectService`). Full type-aware linting is a deferred follow-up (#136
//   "Out of scope"); `npm run typecheck` stays the type authority.
// - React Hooks (stable `recommended`, not `recommended-latest`) + react-refresh
//   (`only-export-components` as warn: stores/hooks files legitimately mix
//   component and non-component exports).
// - Deterministic import order via `eslint-plugin-simple-import-sort`.
// - Process boundaries (ADR 0005 sandboxed renderer, ADR 0023 db-worker data
//   plane) with zero-dependency core rules only:
//     renderer/ may not import Electron/Node or main/preload sources;
//     main/ may not import renderer/preload sources or touch DOM globals;
//     shared/ may not import Electron or process-specific sources.
//   Preload intentionally keeps its `import type` contract from `../main/**`
//   (the IPC wire types) — value imports from main are what would break the
//   sandbox, and there are none.
// - `eslint-config-prettier` LAST so formatting stays Prettier's job.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import prettierConfig from 'eslint-config-prettier'

// Depths 1-5 cover every nesting level under src/renderer|main|shared today
// (renderer goes 4 deep: src/renderer/src/features/<area>/file).
const rendererToMain = [1, 2, 3, 4, 5].map(n => `${'../'.repeat(n)}main/**`)
const rendererToPreload = [1, 2, 3, 4, 5].map(n => `${'../'.repeat(n)}preload/**`)
const mainToRenderer = [1, 2, 3, 4].map(n => `${'../'.repeat(n)}renderer/**`)
const mainToPreload = [1, 2, 3, 4].map(n => `${'../'.repeat(n)}preload/**`)

// Bare Node core modules (the repo also uses the `node:` prefix, covered below).
// Kept to modules the main process actually uses plus the obvious others —
// extend if a new core dependency appears in main/.
const bareNodeCores = [
  'fs',
  'fs/*',
  'path',
  'path/*',
  'os',
  'os/*',
  'child_process',
  'worker_threads',
  'crypto',
  'stream',
  'util',
  'events',
  'http',
  'https',
  'net',
  'tls',
  'zlib',
  'readline',
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
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strict,
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
    // Build scripts are CJS by design (`require` + `__dirname`) — the
    // `no-require-imports` rule from strict does not apply to them.
    files: ['scripts/**/*'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ── Process-aware language options ──────────────────────────────────────
  {
    files: ['src/main/**/*.{ts,mts,cts}', 'src/preload/**/*.ts', 'scripts/**/*.?(c|m)js', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.es2023 } },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.es2023 } },
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
            ...bareNodeCores.map(name => ({
              name,
              message:
                'Renderer is sandboxed (ADR 0005) — Node APIs live in main/preload, exposed via the preload bridge.',
            })),
          ],
          patterns: [
            {
              group: ['node:*'],
              message:
                'Renderer is sandboxed (ADR 0005) — Node APIs live in main/preload, exposed via the preload bridge.',
            },
            {
              group: rendererToMain,
              message:
                'Renderer must not import main-process sources — share code via src/shared or the preload IPC bridge.',
            },
            {
              group: rendererToPreload,
              message:
                'Renderer must not import preload sources — use the `window.api` bridge typed in src/preload/index.d.ts.',
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
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: mainToRenderer,
              message: 'Main must not import renderer sources (ADR 0023) — share code via src/shared.',
            },
            {
              group: mainToPreload,
              message: 'Main must not import the preload bridge — the bridge depends on main types, never the reverse.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: "Main has no DOM — did you mean Electron's BrowserWindow?" },
        { name: 'document', message: 'Main has no DOM — renderer-only global.' },
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
          patterns: [
            {
              group: ['../main/**', '../../main/**'],
              message: 'Shared must not import main-process sources — move the shared piece down into src/shared.',
            },
            { group: ['../renderer/**', '../../renderer/**'], message: 'Shared must not import renderer sources.' },
            { group: ['../preload/**', '../../preload/**'], message: 'Shared must not import the preload bridge.' },
          ],
        },
      ],
    },
  },

  // ── Prettier owns formatting: disable conflicting stylistic rules last ──
  prettierConfig,
)
