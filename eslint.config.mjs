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
//     shared/ may not import Electron or process-specific sources;
//     preload/ may import main sources as types only (the IPC wire contract).
// - `eslint-config-prettier` LAST so formatting stays Prettier's job.
//
// What this deliberately does NOT cover (see PR #137 + follow-up):
// - `@/*` needs no restriction: the alias is renderer-scoped in every config
//   that defines it (tsconfig.web.json paths, electron.vite.config.ts renderer
//   resolve.alias, vitest.config.ts resolve.alias). main/preload have no alias
//   configured, so `@/...` cannot resolve outside the renderer.

import { builtinModules } from 'node:module'
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import prettierConfig from 'eslint-config-prettier'

// Depths 1-5 cover every nesting level under src/renderer|main|shared today
// (renderer goes 4 deep: src/renderer/src/features/<area>/file).
function depthPatterns(dir, maxDepth) {
  return Array.from({ length: maxDepth }, (_, i) => `${'../'.repeat(i + 1)}${dir}/**`)
}
const rendererToMain = depthPatterns('main', 5)
const rendererToPreload = depthPatterns('preload', 5)
const mainToRenderer = depthPatterns('renderer', 4)
const mainToPreload = depthPatterns('preload', 4)

// Every Node builtin, bare and `node:`-prefixed, derived from the running
// runtime — no hand-kept denylist that silently omits `assert`/`buffer`/`url`
// et al. (PR #137 review). A superset across Node versions is fine: every
// entry is something the renderer must never import (ADR 0005).
const bareNodeCores = builtinModules
  .filter(name => !name.startsWith('node:') && !name.startsWith('_'))
  .flatMap(name => [name, `${name}/*`])

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
        { name: 'navigator', message: 'Main has no DOM — renderer-only global.' },
        { name: 'localStorage', message: 'Main has no DOM storage — persist via the ledger or settings file.' },
      ],
    },
  },
  {
    // Shared is imported by every process: no Electron, no process sources.
    // src/shared nests at most 2 deep (src/shared/<lib|schemas>/file), so
    // depths 1-2 are complete — verified against the tree, not assumed.
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
              group: ['../main/**'],
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
