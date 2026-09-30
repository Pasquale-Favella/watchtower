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
// - Effect discipline (ADR 0032, `docs/architecture.md`, plan P1 + P5) with the
//   core `no-restricted-syntax` rule only — no plugin, no new dependency:
//     `Effect.run*` is banned outside a derived composition-root allowlist, and
//     bare `throw` is banned inside files that import `effect` (that file set is
//     derived from the tree, not hand-kept). Both `warn`, warn-first, for the
//     reason spelled out at the section.
// - `eslint-config-prettier` LAST so formatting stays Prettier's job.
//
// Excluded from BOTH this gate and Prettier (see the global `ignores` below
// and `.prettierignore`): the vendored `.agents/` skills and the hand-authored
// root config files (README, electron-builder.yml, the tsconfig/vite/vitest
// configs). Prettier reflowed them in the one-time #136 pass for no readability
// gain, so they are pinned to their original layout rather than re-litigated.
//
// What this deliberately does NOT cover (see PR #137 + follow-up):
// - `@/*` needs no restriction: the alias is renderer-scoped in every config
//   that defines it (tsconfig.web.json paths, electron.vite.config.ts renderer
//   resolve.alias, vitest.config.ts resolve.alias). main/preload have no alias
//   configured, so `@/...` cannot resolve outside the renderer.

import { readdirSync, readFileSync } from 'node:fs'
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

// ── Effect composition roots (ADR 0032, docs/plans/effect-adoption.md P1) ──
//
// `docs/architecture.md:104` already states the rule this mechanises:
// "External callbacks and Promise APIs enter or leave Effect at these
// composition roots rather than spreading through domain code." ADR 0032 says
// the same ("runtime creation and `run*` calls do not spread through domain
// code"). It is violated in ~25 places in `src/main` (finding F10) and a rule
// in prose does not survive a regression, so it becomes a selector.
//
// DERIVED, NOT GUESSED: every entry was read in the tree and each one quotes
// the module doc (or the type contract) that makes it a root. The list is a
// named constant, so tightening it later is deleting a line here — no rule
// rewrite.
const EFFECT_COMPOSITION_ROOTS = [
  // The ONE runtime the Electron main isolate owns: `ManagedRuntime.make(MainLive)`.
  // Its own doc: "no second runtime, no `run*` spreading through domain code".
  'src/main/main-runtime.ts',
  // The ONE runtime the db-worker isolate owns: `ManagedRuntime.make(WorkerLive)`
  // (plan A2, landed). Same shape and same reason as the entry above.
  'src/main/worker-runtime.ts',
  // Owns a `ManagedRuntime` per database instance; `this.runtime.runSync` in
  // `migrate`/`close`/`execute` is the synchronous store contract ADR 0032
  // explicitly keeps ("retain the synchronous runtime edge"), and the two
  // `throw`s here are inside that imperative edge, not inside a workflow.
  // EXPECTED TO SHRINK: the Effect SQL client wants one runtime per isolate
  // (A2/F11) rather than one per `LedgerStore`, and `LedgerStore`'s 21
  // `runRepositorySync` hops (F12/A3) collapse with it.
  'src/main/store/node-sqlite-client.ts',
  // Process-internal Effect roots: these modules own an EXTERNAL PROCESS and
  // the Promise seam its callers already hold, so the `run*` sits at the point
  // where that process enters/leaves Effect.
  'src/main/agents/runtime.ts', // owns the ACP child: spawn -> stream -> teardown
  'src/main/agents/command-runner.ts', // owns ChildProcessSpawner; provides the live layer
  'src/main/agents/ledger-mcp/sidecar.ts', // "Promise seam kept — `run*` stays at this spawn-function boundary"
  'src/main/agents/ledger-mcp/pool.ts', // "the pool interface stays `Promise`-based (the runner seam never sees Effects)"
  'src/main/agents/auth-probe.ts', // doc: "this module is now pure: run the command, parse the JSON, map the boolean"
  'src/main/agents/process-tree.ts', // "run* stays at this spawn-function boundary; callers keep the `Promise<void>` seam"
  // The `Provider` contract is `discoverSessions(): Promise<SessionSource[]>`, so
  // the gateway provider is a Promise seam by TYPE, not by accident. Its doc
  // calls the `Env.layer` provide "this composition root".
  'src/main/pipeline/providers/vercel-gateway.ts',
  // The db-worker is a `worker_threads` isolate, and a message handler is a
  // legitimate root (ADR 0023 owns the data plane on that thread; plan A2 says
  // "context.ts keeps its sync surface … which is itself a legitimate
  // composition root"). Both entries below are therefore legitimate TODAY and
  // are allowlisted for that reason alone.
  //
  // NOT yet tightened, on purpose. A2 landed and did route the dispatch arms
  // through one `WorkerLive` runtime, so `context.ts` now has 4 `run*` calls
  // rather than ~10 — but the survivors are `Fiber.join` / `Effect.runFork` on
  // fibers that own no runtime, plus the two `runSync` fork sites that must stay
  // synchronous for `startImmediately`. So the entry is still EARNED, and
  // deleting it now would fail the build rather than tighten a gate. The entry
  // is due when the worker's remaining `run*` calls can become
  // `runtime.run*`, which is slice 3/6 territory (one runtime per isolate, and
  // the `LedgerStore` facade retired) — not this wave's.
  'src/main/db-worker/context.ts',
  'src/main/db-worker/client.ts',
]

// ── Files that import Effect (docs/plans/effect-adoption.md P5) ────────────
//
// Rule 2 has to fire "inside files that import from `effect`". Flat config
// cannot express that as a predicate — `files` takes glob patterns, not import
// graphs — so this is the closest honest approximation available WITHOUT a
// plugin or a dependency, and it is derived from the tree at config-load time
// rather than hand-kept: the same move as `bareNodeCores` above, one level up.
// The coarse alternative (`files: ['src/main/**/*.ts']`, 140 files) buries the
// real sites under 116 files that never touch Effect, which is the opposite of
// machine-visible. A new Effect file is covered the moment it lands, with no
// edit here.
//
// Value imports only, and the approximation is stated rather than claimed:
// `import type * as Cause from 'effect/Cause'` is a type edge and creates no
// runtime discipline to keep, so it does not enrol a file. The check below
// reads a leading `type` on the clause, which is exact for
// `import type {…} from 'effect/…'` but OVER-enrols two shapes —
// `import { type Cause } from 'effect/…'`, and a type-only import that is not
// the file's first import. Over-enrolling is the safe direction (the throw rule
// fires on a file that only type-imports Effect); under-enrolling would not be.
// No file in the tree is mis-flagged as a result.
const EFFECT_MODULE_CLAUSE =
  /(?:^|\n)[ \t]*(?:import|export)\b([^;]*?)from[ \t]*['"](?:@effect\/[^'"]*|effect(?:\/[^'"]*)?)['"]/g

function importsEffectRuntime(source) {
  for (const [, clause] of source.matchAll(EFFECT_MODULE_CLAUSE)) {
    if (!/^\s*type\b/.test(clause)) return true
  }
  return false
}

// A renamed or moved `src/main` must not silently turn the rule OFF: a gate
// that quietly stops gating is worse than one that refuses to load.
//
// `CONFIG_DIR` is this config file's own directory, NOT `process.cwd()`. A
// relative `src/main` resolved against the cwd, so running `npx eslint` from any
// subdirectory (an editor, a monorepo task, `eslint --cwd`) turned the gate into
// a hard crash naming a path that does not exist. The throw below is meant to
// report a MOVED tree; it must never fire because of where the shell was.
const CONFIG_DIR = import.meta.dirname

function effectImportingFiles(dir) {
  const abs = `${CONFIG_DIR}/${dir}`
  const files = readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map(name => `${dir}/${name.split(/[\\/]/).join('/')}`)
    .filter(name => importsEffectRuntime(readFileSync(`${CONFIG_DIR}/${name}`, 'utf8')))
    .sort()
  if (files.length === 0) throw new Error(`effect/throw gate: no Effect-importing file found under ${abs}`)
  return files
}

const effectRoots = new Set(EFFECT_COMPOSITION_ROOTS)
const EFFECT_FILES = effectImportingFiles('src/main')
const EFFECT_ROOT_FILES = EFFECT_FILES.filter(file => effectRoots.has(file))
const EFFECT_NON_ROOT_FILES = EFFECT_FILES.filter(file => !effectRoots.has(file))

// `run*` (not `runtime`): the banned set is the execution entry points that
// create an ad-hoc running program. `Effect.runtime` builds a Runtime value
// and is legitimate domain-adjacent code.
//
// Selector completeness, stated so the gate is not oversold: this matches the
// member-expression spelling only. A file that imports `{ runPromise }`
// directly, or aliases the namespace, would evade it. Neither form exists in
// `src/` today (grepped), so the rule is complete against THIS tree — not
// structurally complete against a future one. `runtime.run*` on a
// `ManagedRuntime` instance is likewise not matched, and that is deliberate:
// F12/A3's `runRepositorySync` is a different rule with a different allowlist.
const RUN_AT_ROOT = {
  selector: "CallExpression > MemberExpression[object.name='Effect'][property.name=/^run(Sync|Promise|Fork|Callback)/]",
  message:
    '`Effect.run*` belongs at a composition root only (ADR 0032, docs/architecture.md:104) — return the Effect and let the isolate root run it. A `run*` here usually means there is no runtime to widen, which is the finding (plan F10), not a local fix.',
}

// False-positive surface, stated rather than hidden: this fires on a deliberate
// re-throw of a caught value (`catch (e) { throw e }`) exactly like on a
// constructed defect. Three such sites exist today (node-sqlite-client.ts:66,
// snapshot.ts:243, sidecar.ts:317). They are flagged rather than carved out
// because a `throw <identifier>` can equally well be an unmodelled cached
// error, and a silent hole defeats the point of the rule; the follow-up that
// promotes to `error` narrows the selector if the re-throws are the only noise.
const NO_BARE_THROW = {
  selector: 'ThrowStatement',
  message:
    'A bare `throw` in a file that imports Effect reaches `Cause` as a DEFECT, not a typed failure (plan F24/P5) — model it as a `Schema.TaggedError` in the error channel and let the composition root decide. A re-throw of a caught value is the one shape expected here.',
}

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

  // ── Effect discipline: composition roots + typed failures (ADR 0032) ─────
  //
  // WARN-FIRST, deliberately, on the same convention as the #136 scaffold set
  // and the lint-gate comment in `.github/workflows/test.yml`: `npm run lint` is
  // a BLOCKING gate on errors, so promoting these without a cleanup diff would
  // turn a 100-file debt into a red build and get the rule switched off. The
  // job here is to make the debt MACHINE-VISIBLE. Promotion path for the
  // follow-up: flip `'warn'` -> `'error'` on the two rules below in a commit
  // that also empties the two lists — nothing else in this section changes, and
  // `EFFECT_COMPOSITION_ROOTS` shrinks by deleting the "expected to shrink"
  // lines as A2 lands.
  //
  // THREE blocks (A, B, C), not two, and the duplication is load-bearing: flat
  // config REPLACES a `rules` entry wholesale, so a later block that sets
  // `no-restricted-syntax` silently drops the selectors an earlier block set.
  // Block C therefore restates `RUN_AT_ROOT` for the non-root Effect files that
  // block A also matches. Merge B into C only by deleting A, never by dropping
  // the restated selector.
  {
    // A — Rule 1 (plan P1): every main-process source except the roots above.
    // `snapshot.ts` is the live counter-example — 9 `run*` calls in a module
    // that owns no runtime, which is plan F14/A5 in miniature.
    files: ['src/main/**/*.ts'],
    ignores: EFFECT_COMPOSITION_ROOTS,
    rules: { 'no-restricted-syntax': ['warn', RUN_AT_ROOT] },
  },
  {
    // B — Rule 2 (plan P5), root half: being a root buys no `throw` amnesty.
    // 18 of the 24 `throw` sites in the tree are in allowlisted roots.
    files: EFFECT_ROOT_FILES,
    rules: { 'no-restricted-syntax': ['warn', NO_BARE_THROW] },
  },
  {
    // C — Rule 2, non-root half, PLUS rule 1 restated (see the note above).
    files: EFFECT_NON_ROOT_FILES,
    rules: { 'no-restricted-syntax': ['warn', RUN_AT_ROOT, NO_BARE_THROW] },
  },

  // ── Prettier owns formatting: disable conflicting stylistic rules last ──
  prettierConfig,
)
