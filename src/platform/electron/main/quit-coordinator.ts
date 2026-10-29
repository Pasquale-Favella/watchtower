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

/** Producers may publish their final events until they have drained. */
export async function closeMainResources(closures: MainResourceClosures): Promise<void> {
  const producers = await Promise.allSettled([
    Promise.resolve().then(closures.stopCoach),
    Promise.resolve().then(closures.stopWorker),
  ])
  const runtime = await Promise.allSettled([Promise.resolve().then(closures.disposeRuntime)])
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
