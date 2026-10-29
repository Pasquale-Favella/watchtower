import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { build } from 'vite'

import type { CoachRunFrame } from '../src/shared/rpc/coach.js'
import type { CoachEvent } from '../src/shared/schemas/agents.js'

type Probe = {
  read(): Promise<{ readonly writes: number }>
  write(value: string): Promise<unknown>
  fail(): Promise<unknown>
  finiteStream(): Promise<number[]>
  slowStream(): Promise<number[]>
  beginLostAck(): Promise<number>
  finishLostAck(): Promise<string>
  disconnect(generation: number): void
  raw(frame: string): Promise<{ readonly generation: number; readonly closed: boolean }>
  overflow(): Promise<{ readonly generation: number; readonly closed: boolean }>
  connect(): Promise<{ readonly _tag: string; readonly generation?: number; readonly code?: string }>
  beginConnect(): void
  beginCoachRun(): Promise<CoachRunFrame>
  waitCoachFrames(count: number): Promise<CoachRunFrame[]>
  finishCoachRun(): Promise<string>
  cancelCoachRun(runId: string): Promise<void>
  coachGeneration(): number
}

type CoachHarnessControl = {
  diagnostics(): {
    readonly starts: number
    readonly cancelCalls: Readonly<Record<string, number>>
    readonly activeRuns: Readonly<Record<string, boolean>>
  }
  emit(runId: string, event: CoachEvent): boolean
  burstNext(): void
}

type TransportDiagnostics = {
  readonly acceptedConnections: number
  readonly activeConnections: number
  readonly activeServerFibers: number
  readonly teardowns: number
  readonly peerPortCloses: number
  readonly roleResolutionAttempts: number
  readonly roleResolutionRejects: number
  readonly lastLifecycle?: {
    readonly baseline: Readonly<Record<string, number>>
    readonly attached: Readonly<Record<string, number>>
    readonly afterTeardown?: Readonly<Record<string, number>>
  }
  readonly lateReady: {
    readonly dispatched: number
    readonly delivered: number
    readonly afterDestroy: number
  }
}

test('real sandboxed MessagePort transport passes the production RPC port boundary', async () => {
  test.setTimeout(90_000)
  const directory = mkdtempSync(join(resolve('.'), '.watchtower-rpc-transport-'))
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  const mainOutput: string[] = []
  const rendererOutput: string[] = []
  const observedPages = new WeakSet<object>()
  const observePage = (page: Page) => {
    if (observedPages.has(page)) return
    observedPages.add(page)
    page.on('pageerror', error => rendererOutput.push(`pageerror: ${error.stack ?? error.message}`))
    page.on('console', message => {
      if (message.type() === 'error') rendererOutput.push(`console error: ${message.text()}`)
    })
    page.on('crash', () => rendererOutput.push('renderer process crashed'))
  }
  const diagnosticDetails = () =>
    `\nElectron stdout/stderr:\n${mainOutput.join('') || '(empty)'}\nRenderer diagnostics:\n${rendererOutput.join('\n') || '(empty)'}`
  try {
    const fixtureRoot = resolve('e2e/fixtures')
    await build({
      configFile: false,
      root: fixtureRoot,
      logLevel: 'error',
      ssr: { noExternal: ['effect'] },
      build: {
        ssr: resolve(fixtureRoot, 'rpc-transport-server.ts'),
        outDir: join(directory, 'server'),
        emptyOutDir: true,
        rollupOptions: { output: { format: 'es', entryFileNames: 'rpc-server.mjs' } },
      },
    })
    await build({
      configFile: false,
      root: fixtureRoot,
      base: './',
      logLevel: 'error',
      build: {
        outDir: join(directory, 'renderer'),
        emptyOutDir: true,
        rollupOptions: { input: resolve(fixtureRoot, 'rpc-transport.html') },
      },
    })
    const electronApp = await electron.launch({
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        resolve(fixtureRoot, 'rpc-transport-main.mjs'),
        join(directory, 'renderer/rpc-transport.html'),
        join(directory, 'server/rpc-server.mjs'),
        `--user-data-dir=${join(directory, 'profile')}`,
      ],
    })
    app = electronApp
    const child = electronApp.process()
    child.stdout?.on('data', chunk => mainOutput.push(String(chunk)))
    child.stderr?.on('data', chunk => mainOutput.push(String(chunk)))
    child.on('exit', (code, signal) => mainOutput.push(`Electron process exited: code=${code}, signal=${signal}\n`))
    electronApp.on('window', observePage)
    await expect.poll(() => electronApp.windows().length).toBe(4)
    const pages = electronApp.windows()
    pages.forEach(observePage)
    await Promise.all(pages.map(page => page.waitForFunction(() => document.documentElement.dataset.ready === 'true')))
    const fixturePages = new Map<string, Page>()
    for (const page of pages) {
      const name = await page.locator('html').getAttribute('data-window')
      if (name) fixturePages.set(name, page)
    }
    const fixturePage = (name: string): Page => {
      const page = fixturePages.get(name)
      if (!page) throw new Error(`Missing ${name} fixture window`)
      return page
    }
    const mainPage = fixturePage('app')
    const panelPage = fixturePage('panel')
    const beaconPage = fixturePage('beacon')
    const foreignPage = fixturePage('foreign-document')
    const diagnostics = (): Promise<TransportDiagnostics> =>
      electronApp.evaluate(() =>
        (
          globalThis as typeof globalThis & { rpcTransportFixture: { diagnostics(): TransportDiagnostics } }
        ).rpcTransportFixture.diagnostics(),
      )
    const sandbox = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(window => {
        const contents = window.webContents as Electron.WebContents & {
          getLastWebPreferences(): Electron.WebPreferences
        }
        const preferences = contents.getLastWebPreferences()
        return {
          sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
        }
      }),
    )
    expect(sandbox).toEqual(
      Array.from({ length: 4 }, () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false })),
    )

    expect(
      await mainPage.evaluate(async () => {
        const frame = document.createElement('iframe')
        frame.src = location.href
        const loaded = new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }))
        document.body.append(frame)
        await loaded
        return typeof (frame.contentWindow as (Window & { api?: unknown }) | null)?.api
      }),
    ).toBe('undefined')

    const initial = await mainPage.evaluate(async () => {
      const rpc = (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe
      return { read: await rpc.read(), values: await rpc.finiteStream() }
    })
    expect(initial).toEqual({ read: { writes: 0 }, values: [1, 2, 3, 4] })

    const panelCoachDenied = await panelPage.evaluate(async () => {
      const rpc = (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe
      try {
        await rpc.cancelCoachRun('not-owned')
        return false
      } catch {
        return true
      }
    })
    expect(panelCoachDenied).toBe(true)

    const firstCoachFrame = await mainPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.beginCoachRun(),
    )
    expect(firstCoachFrame).toMatchObject({ _tag: 'Started', runId: expect.any(String) })
    const coachRunId = firstCoachFrame.runId
    const emitCoachEvent = (event: CoachEvent) =>
      electronApp.evaluate(
        (_electron, { runId, event }) =>
          (
            globalThis as typeof globalThis & { rpcTransportCoachHarness: CoachHarnessControl }
          ).rpcTransportCoachHarness.emit(runId, event),
        { runId: coachRunId, event },
      )
    expect(await emitCoachEvent({ kind: 'text', delta: 'first ' })).toBe(true)
    expect(await emitCoachEvent({ kind: 'text', delta: 'second' })).toBe(true)
    expect(await emitCoachEvent({ kind: 'status', state: 'done' })).toBe(true)
    const completedCoachFrames = await mainPage.evaluate(
      count =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.waitCoachFrames(count),
      4,
    )
    expect(completedCoachFrames).toEqual([
      { _tag: 'Started', runId: coachRunId },
      { _tag: 'Event', runId: coachRunId, event: { kind: 'text', delta: 'first ' } },
      { _tag: 'Event', runId: coachRunId, event: { kind: 'text', delta: 'second' } },
      { _tag: 'Event', runId: coachRunId, event: { kind: 'status', state: 'done' } },
    ])
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.finishCoachRun(),
      ),
    ).toBe('Success')

    const cancelCoachFrame = await mainPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.beginCoachRun(),
    )
    expect(cancelCoachFrame._tag).toBe('Started')
    if (cancelCoachFrame._tag !== 'Started') throw new Error('Coach cancellation run did not start')
    const cancelResult = await mainPage.evaluate(async runId => {
      try {
        await (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.cancelCoachRun(runId)
        return 'Success'
      } catch {
        return 'Failure'
      }
    }, cancelCoachFrame.runId)
    expect(cancelResult).toBe('Success')
    const cancelledCoachFrames = await mainPage.evaluate(
      count =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.waitCoachFrames(count),
      2,
    )
    expect(cancelledCoachFrames).toEqual([
      { _tag: 'Started', runId: cancelCoachFrame.runId },
      {
        _tag: 'Event',
        runId: cancelCoachFrame.runId,
        event: { kind: 'error', message: 'cancelled' },
      },
    ])
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.finishCoachRun(),
      ),
    ).toBe('Success')
    const replayedCancel = await mainPage.evaluate(async runId => {
      try {
        await (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.cancelCoachRun(runId)
        return 'Success'
      } catch {
        return 'Failure'
      }
    }, cancelCoachFrame.runId)
    expect(replayedCancel).toBe('Failure')
    const coachDiagnostics = () =>
      electronApp.evaluate(() =>
        (
          globalThis as typeof globalThis & { rpcTransportCoachHarness: CoachHarnessControl }
        ).rpcTransportCoachHarness.diagnostics(),
      )
    await expect.poll(async () => (await coachDiagnostics()).cancelCalls[cancelCoachFrame.runId]).toBe(1)
    expect(await coachDiagnostics()).toMatchObject({
      starts: 2,
      activeRuns: { [cancelCoachFrame.runId]: false },
    })

    await electronApp.evaluate(() =>
      (
        globalThis as typeof globalThis & { rpcTransportCoachHarness: CoachHarnessControl }
      ).rpcTransportCoachHarness.burstNext(),
    )
    const overflowCoachFrame = await mainPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.beginCoachRun(),
    )
    expect(overflowCoachFrame._tag).toBe('Started')
    if (overflowCoachFrame._tag !== 'Started') throw new Error('Coach overflow run did not start')
    const overflowCoachFrames = await mainPage.evaluate(
      count =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.waitCoachFrames(count),
      130,
    )
    expect(overflowCoachFrames).toHaveLength(130)
    expect(overflowCoachFrames.at(-1)).toEqual({
      _tag: 'Event',
      runId: overflowCoachFrame.runId,
      event: { kind: 'error', message: 'Coach output exceeded the stream limit. Retry your message.' },
    })
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.finishCoachRun(),
      ),
    ).toBe('Success')
    await expect.poll(async () => (await coachDiagnostics()).cancelCalls[overflowCoachFrame.runId]).toBe(1)

    const disconnectedCoachFrame = await mainPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.beginCoachRun(),
    )
    expect(disconnectedCoachFrame._tag).toBe('Started')
    if (disconnectedCoachFrame._tag !== 'Started') throw new Error('Coach disconnect run did not start')
    const coachGeneration = await mainPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.coachGeneration(),
    )
    await mainPage.evaluate(
      generation =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.disconnect(generation),
      coachGeneration,
    )
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.finishCoachRun(),
      ),
    ).toBe('Failure')
    await expect.poll(async () => (await coachDiagnostics()).cancelCalls[disconnectedCoachFrame.runId]).toBe(1)
    expect((await coachDiagnostics()).activeRuns[disconnectedCoachFrame.runId]).toBe(false)
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.read(),
      ),
    ).toEqual({ writes: 0 })
    expect((await coachDiagnostics()).starts).toBe(4)

    const typedFailure = await mainPage.evaluate(async () => {
      const rpc = (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe
      try {
        await rpc.fail()
        return { fulfilled: true }
      } catch (error) {
        const value = error as { readonly _tag?: string; readonly code?: string; readonly message?: string }
        return { fulfilled: false, tag: value._tag, code: value.code, message: value.message }
      }
    })
    expect(typedFailure).toMatchObject({ fulfilled: false, tag: 'ProbeFailure', code: 'expected' })

    const lostAckGeneration = await mainPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.beginLostAck(),
    )
    expect(
      await panelPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.read(),
      ),
    ).toEqual({ writes: 1 })
    await mainPage.evaluate(
      generation =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.disconnect(generation),
      lostAckGeneration,
    )
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.finishLostAck(),
      ),
    ).toBe('Failure')
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.read(),
      ),
    ).toEqual({ writes: 1 })

    const rejectedBeacon = await beaconPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.connect(),
    )
    expect(rejectedBeacon).toMatchObject({ _tag: 'Failed', code: 'unavailable' })
    expect(
      await panelPage.evaluate(async () => {
        const rpc = (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe
        const before = await rpc.read()
        let denied = false
        try {
          await rpc.write('must-not-run')
        } catch {
          denied = true
        }
        return { before, denied }
      }),
    ).toEqual({ before: { writes: 1 }, denied: true })
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.read(),
      ),
    ).toEqual({ writes: 1 })

    const slowConsumer = await mainPage.evaluate(async () => {
      const rpc = (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe
      try {
        return { values: await rpc.slowStream() }
      } catch {
        return { values: [] }
      }
    })
    expect(slowConsumer).toEqual({ values: [0] })
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.read(),
      ),
    ).toEqual({ writes: 1 })

    const malformed = await mainPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.raw('{'),
    )
    expect(malformed.closed).toBe(true)
    const overflow = await mainPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.overflow(),
    )
    expect(overflow.closed).toBe(true)
    expect(
      await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.read(),
      ),
    ).toEqual({ writes: 1 })

    let previousGeneration = 0
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const before = await diagnostics()
      const connection = await mainPage.evaluate(() =>
        (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.connect(),
      )
      if (connection._tag !== 'Connected' || connection.generation === undefined) {
        throw new Error(`Connection ${cycle + 1} failed`)
      }
      expect(connection.generation).toBeGreaterThan(previousGeneration)
      previousGeneration = connection.generation
      const connected = await diagnostics()
      expect(connected.acceptedConnections).toBe(before.acceptedConnections + 1)
      expect(connected.activeConnections).toBe(1)
      expect(connected.activeServerFibers).toBe(1)
      expect(connected.lastLifecycle?.attached).toEqual(
        Object.fromEntries(
          Object.entries(connected.lastLifecycle?.baseline ?? {}).map(([event, count]) => [event, count + 1]),
        ),
      )

      await mainPage.reload()
      await mainPage.waitForFunction(() => document.documentElement.dataset.ready === 'true')
      await expect
        .poll(async () => {
          const current = await diagnostics()
          return (
            current.activeConnections === 0 &&
            current.activeServerFibers === 0 &&
            current.teardowns === before.teardowns + 1
          )
        })
        .toBe(true)
      const closed = await diagnostics()
      expect(closed.lastLifecycle?.afterTeardown).toEqual(closed.lastLifecycle?.baseline)
    }

    const beforePendingClose = await diagnostics()
    await electronApp.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          rpcTransportFixture: { delayNextReady(role: string, delayMs: number): void }
        }
      ).rpcTransportFixture.delayNextReady('panel', 150),
    )
    await panelPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.beginConnect(),
    )
    await expect
      .poll(async () => (await diagnostics()).acceptedConnections)
      .toBe(beforePendingClose.acceptedConnections + 1)
    expect(await diagnostics()).toMatchObject({ activeConnections: 1, activeServerFibers: 1 })
    await panelPage.evaluate(() => window.dispatchEvent(new Event('unload')))
    await expect
      .poll(async () => {
        const current = await diagnostics()
        return (
          current.activeConnections === 0 &&
          current.activeServerFibers === 0 &&
          current.teardowns === beforePendingClose.teardowns + 1
        )
      })
      .toBe(true)
    await expect.poll(async () => (await diagnostics()).lateReady.delivered).toBe(1)
    await expect.poll(async () => (await diagnostics()).peerPortCloses).toBe(beforePendingClose.peerPortCloses + 1)
    const afterLateDelivery = await diagnostics()
    expect(afterLateDelivery.lastLifecycle?.afterTeardown).toEqual(afterLateDelivery.lastLifecycle?.baseline)

    const panelClosed = panelPage.waitForEvent('close')
    await electronApp.evaluate(() =>
      (
        globalThis as typeof globalThis & { rpcTransportFixture: { closeWindow(role: string): void } }
      ).rpcTransportFixture.closeWindow('panel'),
    )
    await panelClosed

    const beforeWindowClose = await diagnostics()
    await electronApp.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          rpcTransportFixture: { delayNextReady(role: string, delayMs: number): void }
        }
      ).rpcTransportFixture.delayNextReady('app', 150),
    )
    const appClosed = mainPage.waitForEvent('close')
    await mainPage.evaluate(() =>
      (globalThis as typeof globalThis & { rpcTransportProbe: Probe }).rpcTransportProbe.beginConnect(),
    )
    await expect
      .poll(async () => (await diagnostics()).acceptedConnections)
      .toBe(beforeWindowClose.acceptedConnections + 1)
    expect(await diagnostics()).toMatchObject({ activeConnections: 1, activeServerFibers: 1 })
    await electronApp.evaluate(() =>
      (
        globalThis as typeof globalThis & { rpcTransportFixture: { closeWindow(role: string): void } }
      ).rpcTransportFixture.closeWindow('app'),
    )
    await appClosed
    await expect
      .poll(async () => {
        const current = await diagnostics()
        return (
          current.activeConnections === 0 &&
          current.activeServerFibers === 0 &&
          current.teardowns === beforeWindowClose.teardowns + 1
        )
      })
      .toBe(true)
    await expect.poll(async () => (await diagnostics()).lateReady.dispatched).toBe(2)
    await expect.poll(async () => (await diagnostics()).lateReady.afterDestroy).toBe(1)
    await expect.poll(async () => (await diagnostics()).peerPortCloses).toBe(beforeWindowClose.peerPortCloses + 1)
    const afterWindowClose = await diagnostics()
    expect(afterWindowClose.lastLifecycle?.afterTeardown).toEqual(afterWindowClose.lastLifecycle?.baseline)

    const beforeForeignNavigation = await diagnostics()
    const expectedCreationUrl = foreignPage.url()
    await electronApp.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          rpcTransportFixture: { navigateWindow(name: string, url: string): Promise<void> }
        }
      ).rpcTransportFixture.navigateWindow('foreign-document', 'data:text/html,<html><body>foreign</body></html>'),
    )
    await foreignPage.waitForLoadState('domcontentloaded')
    await foreignPage.waitForFunction(
      () => typeof (window as typeof window & { api?: { rpcV1?: unknown } }).api?.rpcV1 !== 'undefined',
    )
    expect(foreignPage.url()).toContain('data:text/html')
    const foreignConnection = await foreignPage.evaluate(async () =>
      (window as typeof window & { api: { rpcV1: { connect(): Promise<unknown> } } }).api.rpcV1.connect(),
    )
    expect(foreignConnection).toMatchObject({ _tag: 'Failed', code: 'unavailable' })
    expect(foreignPage.url()).not.toBe(expectedCreationUrl)
    const afterForeignNavigation = await diagnostics()
    expect(afterForeignNavigation.roleResolutionAttempts).toBe(beforeForeignNavigation.roleResolutionAttempts + 1)
    expect(afterForeignNavigation.roleResolutionRejects).toBe(beforeForeignNavigation.roleResolutionRejects + 1)
    expect(afterForeignNavigation.acceptedConnections).toBe(beforeForeignNavigation.acceptedConnections)
    expect(afterForeignNavigation.activeConnections).toBe(0)
    expect(afterForeignNavigation.activeServerFibers).toBe(0)
  } catch (error) {
    throw new Error(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}${diagnosticDetails()}`)
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
