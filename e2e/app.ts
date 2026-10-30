import { type ChildProcess, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test'

import { prepareProviderFixture } from '../scripts/fixtures/provider.cjs'

/**
 * Shared Electron launch + first-run helpers for `e2e/*.spec.ts` (tracks
 * #133). Every spec boots the BUILT app (`npm run build` first — wired into
 * `npm run test:e2e`) against a fresh `--user-data-dir` under the OS temp
 * root, so the suite never touches the developer's real Watchtower data and
 * always exercises the first-launch path (Splash → onboarding). A controlled
 * Codex history lives in that profile; provider discovery does not read the
 * developer's real assistant history. On Windows, PATH also excludes the
 * developer's agent launchers while retaining Node, Git and system tools.
 *
 * Rules for new specs:
 * - use fixture data for content checks; routing uses memory history;
 * - key readiness off `dismissOnboarding`, not the splash (pre-mount DOM also
 *   matches "hidden" checks);
 * - assert each view via `waitForAnyVisible` with content-OR-empty markers;
 * - wrap every spec in `withApp` — it asserts zero renderer `pageerror`s.
 */
export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  pageErrors: Error[]
  close: () => Promise<void>
}

const CLOSE_TIMEOUT_MS = 15_000
const FORCED_EXIT_TIMEOUT_MS = 5_000

interface ElectronProcessState {
  readonly child: ChildProcess | null
  closeCompleted: boolean
}

const childHasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null

const childState = (child: ChildProcess | null): string => {
  if (!child) return 'pid unavailable'
  return `pid=${child.pid ?? 'unknown'}, exitCode=${child.exitCode ?? 'null'}, signalCode=${child.signalCode ?? 'null'}`
}

function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ readonly _tag: 'Finished'; readonly value: T } | { readonly _tag: 'TimedOut' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(value => ({ _tag: 'Finished' as const, value })),
    new Promise<{ readonly _tag: 'TimedOut' }>(resolve => {
      timer = setTimeout(() => resolve({ _tag: 'TimedOut' }), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    if (childHasExited(child)) finish(true)
  })
}

function closeExitedProcessStreams(child: ChildProcess): void {
  // Playwright also opens pipes 3 and 4; inherited handles can delay `close`
  // after `exit` even when Electron has already shut down successfully.
  for (const stream of child.stdio) stream?.destroy()
}

async function closeElectronApp(app: ElectronApplication, state: ElectronProcessState): Promise<void> {
  const { child } = state
  if (!child) throw new Error('Cannot confirm Electron shutdown: owned child process handle is unavailable')

  const onProcessExit = (): void => closeExitedProcessStreams(child)
  child.once('exit', onProcessExit)
  if (childHasExited(child)) closeExitedProcessStreams(child)

  let closeFailed = false
  let closeFailure: unknown
  const closeRequest = app.close().then(
    () => {
      state.closeCompleted = true
    },
    error => {
      closeFailed = true
      closeFailure = error
    },
  )
  const gracefulClose = Promise.all([closeRequest, waitForProcessExit(child, CLOSE_TIMEOUT_MS)])
  const result = await raceTimeout(gracefulClose, CLOSE_TIMEOUT_MS)
  if (result._tag === 'Finished' && !closeFailed && child.exitCode === 0 && child.signalCode === null) return

  let reason = `Playwright graceful close did not complete within ${CLOSE_TIMEOUT_MS} ms`
  if (closeFailed) reason = `Playwright graceful close failed: ${String(closeFailure)}`
  else if (result._tag === 'Finished') reason = 'Electron exited unsuccessfully or Playwright close did not complete'

  const initialState = childState(child)
  let killRequested = false
  if (!childHasExited(child)) {
    try {
      killRequested = child.kill()
    } catch {
      killRequested = false
    }
  }
  if (childHasExited(child)) closeExitedProcessStreams(child)
  const exitedAfterFallback = await waitForProcessExit(child, FORCED_EXIT_TIMEOUT_MS)
  await raceTimeout(closeRequest, FORCED_EXIT_TIMEOUT_MS)
  const finalState = childState(child)
  throw new Error(
    `${reason}; owned Electron child before fallback: ${initialState}; killRequested=${killRequested}; ` +
      `playwrightCloseCompletedAfterFallback=${state.closeCompleted}; ` +
      `exitedAfterFallback=${exitedAfterFallback}; child after fallback: ${finalState}`,
  )
}

async function closeAndRemoveProfile(
  app: ElectronApplication,
  state: ElectronProcessState,
  userDataDir: string,
): Promise<void> {
  let closeError: unknown
  try {
    await closeElectronApp(app, state)
  } catch (error) {
    closeError = error
  }

  const { child } = state
  const safeToRemoveProfile = child ? childHasExited(child) && state.closeCompleted : closeError === undefined
  if (safeToRemoveProfile) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch (profileError) {
      if (closeError !== undefined) throw new AggregateError([closeError, profileError], 'Electron cleanup failed')
      throw profileError
    }
  }
  if (closeError !== undefined) throw closeError
  if (child && !childHasExited(child)) {
    throw new Error(`Electron child is still alive; profile retained: ${childState(child)}`)
  }
}

export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'watchtower-e2e-'))
  const args = [
    // Root-owned Linux CI (and Docker) needs the Chromium sandbox off;
    // Windows and macOS run with the default sandbox.
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    '.',
    `--user-data-dir=${userDataDir}`,
  ]

  let app: ElectronApplication | undefined
  let state: ElectronProcessState | undefined
  try {
    const fixture = prepareProviderFixture(userDataDir)
    const env =
      process.platform === 'win32'
        ? Object.fromEntries(Object.entries(fixture.env).filter(([key]) => key.toLowerCase() !== 'path'))
        : fixture.env
    if (process.platform === 'win32') {
      // Host ACP launchers can outlive their probe and inherit Electron's CDP
      // socket. Smoke fixtures need system tools and Git, not installed agents.
      const systemDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      const git = execFileSync(join(systemDirectory, 'where.exe'), ['git.exe'], {
        encoding: 'utf8',
        windowsHide: true,
      })
        .trim()
        .split(/\r?\n/)[0]
      env.PATH = [systemDirectory, dirname(process.execPath), dirname(git)].join(delimiter)
    }
    const launchedApp = await electron.launch({ args, env, timeout: 60_000 })
    app = launchedApp
    state = { child: launchedApp.process(), closeCompleted: false }
    const window = await launchedApp.firstWindow({ timeout: 60_000 })
    const pageErrors: Error[] = []
    window.on('pageerror', error => {
      pageErrors.push(error)
    })
    return {
      app,
      window,
      pageErrors,
      close: () => closeAndRemoveProfile(launchedApp, state as ElectronProcessState, userDataDir),
    }
  } catch (error) {
    if (!app) {
      // Playwright owns launch rollback when electron.launch itself rejects.
      rmSync(userDataDir, { recursive: true, force: true })
      throw error
    }
    try {
      await closeAndRemoveProfile(app, state ?? { child: null, closeCompleted: false }, userDataDir)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Electron launch failed and cleanup was incomplete')
    }
    throw error
  }
}

/**
 * First launch hydrates through a full scan, then mounts the shell and the
 * onboarding dialog together — and the open modal inerts the background
 * (`aria-hidden`), so sidebar roles don't exist in the tree until the dialog
 * closes. Wait for the dialog's own "Skip" as the POSITIVE ready signal and
 * dismiss it. Fails fast when the boot scan errors (splash "Retry").
 */
export async function dismissOnboarding(window: Page): Promise<void> {
  const scanRetry = window.getByRole('button', { name: 'Retry' })
  const skip = window.getByRole('button', { name: 'Skip' })
  // Settle on either terminal boot state, then distinguish: a bare
  // `.toBe('onboard')` would report a broken scan as a timeout, hiding the
  // signal the splash already shows.
  await expect
    .poll(
      async () => {
        if (await scanRetry.isVisible().catch(() => false)) return 'scan-error'
        if (await skip.isVisible().catch(() => false)) return 'onboard'
        return 'waiting'
      },
      { timeout: 240_000 },
    )
    .not.toBe('waiting')
  expect(await scanRetry.isVisible(), 'boot scan failed (splash shows Retry)').toBe(false)

  await skip.click()
  await expect(skip).toBeHidden()
}

/**
 * Resolve when ANY of the locators is visible — pass one locator per
 * possible view state (content / empty / degraded) so specs stay green on
 * hosts with and without data.
 */
export async function waitForAnyVisible(locators: Locator[], timeout = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        for (const locator of locators) {
          if (await locator.isVisible().catch(() => false)) return 'visible'
        }
        return 'waiting'
      },
      { timeout },
    )
    .not.toBe('waiting')
}

/** The app owns one main window; cached orb surfaces are also legitimate.
 * They must stay hidden whenever the main window is on screen. */
export async function expectSingleMainWindow(app: ElectronApplication): Promise<void> {
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows()
        const isMain = (win: Electron.BrowserWindow): boolean => win.webContents.getURL().endsWith('/index.html')
        const isOrb = (win: Electron.BrowserWindow): boolean => /\/orb(?:-panel)?\.html$/.test(win.webContents.getURL())
        const main = windows.find(isMain)
        const mainOnScreen = main?.isVisible() && !main.isMinimized()
        return {
          mainCount: windows.filter(isMain).length,
          unexpectedCount: windows.filter(win => !isMain(win) && !isOrb(win)).length,
          backgroundOverMain: Boolean(mainOnScreen && windows.some(win => isOrb(win) && win.isVisible())),
        }
      }),
    )
    .toEqual({ mainCount: 1, unexpectedCount: 0, backgroundOverMain: false })
}

/**
 * One launch per spec: boots the app, runs the body, asserts zero renderer
 * `pageerror`s, then always closes the app and removes the temp profile —
 * specs stay focused on behavior instead of repeating the lifecycle triple.
 */
export async function withApp(body: (ctx: { app: ElectronApplication; window: Page }) => Promise<void>): Promise<void> {
  let launched: LaunchedApp | undefined
  let bodyFailed = false
  let bodyError: unknown
  try {
    const appContext = await test.step('launch Electron app', launchApp)
    launched = appContext
    await test.step('run scenario', async () => {
      await body({ app: appContext.app, window: appContext.window })
      expect(appContext.pageErrors).toEqual([])
    })
  } catch (error) {
    bodyFailed = true
    bodyError = error
  }

  if (!launched) {
    if (bodyFailed) throw bodyError
    return
  }
  const completedLaunch = launched

  try {
    await test.step('close Electron app', completedLaunch.close)
  } catch (closeError) {
    if (bodyFailed) throw new AggregateError([bodyError, closeError], 'Scenario and Electron cleanup both failed')
    throw closeError
  }
  if (bodyFailed) throw bodyError
}
