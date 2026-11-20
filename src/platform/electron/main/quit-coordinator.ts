export interface QuitCoordinatorOptions {
  readonly markQuitting: () => void
  readonly cleanup: () => Promise<void>
  readonly quit: () => void
  readonly installFailed: () => void
}

export interface MainResourceClosures {
  readonly stopCoach: () => Promise<unknown>
  readonly stopWorker: () => Promise<unknown>
  readonly disposeRuntime: () => Promise<void>
}

export interface MainResourceBudgets {
  /** Producers (coach, data worker) run in parallel; each may take up to this long to stop. */
  readonly producersMs: number
  /** The runtime disposes its layers in sequence, so it gets one budget for the whole chain. */
  readonly runtimeMs: number
}

/** Resolves once the work settles or the deadline passes, whichever comes first. Never rejects. */
export function settleWithin(work: Promise<unknown>, deadlineMs: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, deadlineMs)
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    work.then(done, done)
  })
}

function closeWithin(close: () => Promise<unknown>, deadlineMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Shutdown phase exceeded its deadline')), deadlineMs)
    Promise.resolve()
      .then(close)
      .then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        error => {
          clearTimeout(timer)
          reject(error)
        },
      )
  })
}

/** Both budgets sit inside the 15-second quit ceiling that the e2e harness enforces. */
export const MAIN_RESOURCE_BUDGETS: MainResourceBudgets = { producersMs: 4_000, runtimeMs: 6_000 }

/** Producers may publish their final events until they have drained. A phase that overruns its budget is unconfirmed. */
export async function closeMainResources(
  closures: MainResourceClosures,
  budgets: MainResourceBudgets = MAIN_RESOURCE_BUDGETS,
): Promise<void> {
  const producers = await Promise.allSettled([
    closeWithin(closures.stopCoach, budgets.producersMs),
    closeWithin(closures.stopWorker, budgets.producersMs),
  ])
  const runtime = await Promise.allSettled([closeWithin(closures.disposeRuntime, budgets.runtimeMs)])
  if ([...producers, ...runtime].some(result => result.status === 'rejected')) throw new Error('Shutdown failed')
}

/** The updater may start an artifact only after every app-owned resource closes. */
export function createQuitCoordinator(options: QuitCoordinatorOptions): {
  requestInstall: (install: () => void) => void
  beforeQuit: (event: { preventDefault: () => void }) => void
} {
  let state: 'running' | 'closing' | 'closed' = 'running'
  let install: (() => void) | null = null
  return {
    requestInstall: next => {
      if (state !== 'running') return
      install = next
      options.quit()
    },
    beforeQuit: event => {
      if (state === 'closed') return
      event.preventDefault()
      if (state === 'closing') return
      state = 'closing'
      options.markQuitting()
      void options.cleanup().then(
        () => {
          state = 'closed'
          if (install) {
            try {
              install()
            } catch {
              options.installFailed()
            }
          } else options.quit()
        },
        () => {
          state = 'closed'
          if (install) options.installFailed()
          else options.quit()
        },
      )
    },
  }
}
