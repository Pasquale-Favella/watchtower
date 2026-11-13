import { WorkerPoolContextProvider, type WorkerPoolOptions } from '@pierre/diffs/react'
import { useState } from 'react'

import { codeWorkerCount } from './code-worker-budget.js'

const POOL_OPTIONS: WorkerPoolOptions = {
  workerFactory: () =>
    new Worker(new URL('./code-highlight.worker.ts', import.meta.url), {
      type: 'module',
      name: 'watchtower-code-highlight',
    }),
  poolSize: codeWorkerCount(typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency),
  workerInitializationTimeout: 10_000,
  mainThreadMaxCharacters: 0,
  totalASTLRUCacheSize: 8,
  onWorkerError: event => event.preventDefault(),
}
const HIGHLIGHTER_OPTIONS = {
  theme: { light: 'github-light', dark: 'github-dark' },
  preferredHighlighter: 'shiki-js' as const,
  useTokenTransformer: true,
  lineDiffType: 'none' as const,
  tokenizeMaxLineLength: 2000,
}

/** The library shares this bounded pool across code views and releases it with the last view. */
export function CodeWorkerBoundary({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const [options] = useState(() => POOL_OPTIONS)
  return (
    <WorkerPoolContextProvider poolOptions={options} highlighterOptions={HIGHLIGHTER_OPTIONS}>
      {children}
    </WorkerPoolContextProvider>
  )
}
