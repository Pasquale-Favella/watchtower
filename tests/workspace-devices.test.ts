import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { CommandError, makeRecordingCommandRunner } from '../src/core/ports/process.js'
import { WorkspaceDevices } from '../src/core/ports/workspace-devices.js'
import {
  androidDeviceShellWord,
  deviceScreenshotFromPng,
  parseAndroidDeviceList,
  workspaceDevicesLayer,
} from '../src/infrastructure/workspace/devices.js'
import {
  WORKSPACE_DEVICE_IMAGE_LIMIT,
  workspaceDeviceActionSchema,
  workspaceDeviceConnectSchema,
  WorkspaceDeviceError,
  workspaceDeviceRefSchema,
} from '../src/shared/schemas/workspace-devices.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=',
  'base64',
)
const android = { platform: 'android' as const, id: 'usb123' }
const ios = { platform: 'ios' as const, id: 'B8CA1977-1111-4444-8888-D8AABC000001' }
const ANDROID_DEVICES =
  'List of devices attached\nemulator-5554 device product:sdk model:Pixel_8 device:emu\nusb123 device product:phone model:Phone_Test\nblocked unauthorized\nlost offline\n'

function harness(
  options: {
    platform?: NodeJS.Platform
    android?: boolean
    ios?: boolean
    hugeScreenshot?: boolean
    failCommand?: string
  } = {},
) {
  const killed: string[] = []
  const files: string[] = []
  const fake = makeRecordingCommandRunner(
    () => Effect.fail(new CommandError({ reason: 'spawn', message: 'Use start', command: 'unused' })),
    (command, args) =>
      Effect.gen(function* () {
        const name = command.replaceAll('\\', '/').split('/').at(-1) ?? command
        const missing = () => new CommandError({ reason: 'spawn', command, message: 'not installed' })
        let output: Uint8Array = new Uint8Array()
        let exitCode = 0
        if ((name === 'adb' || name === 'adb.exe') && options.android !== false) {
          if (args[0] === 'version') output = Buffer.from('Android Debug Bridge version 1.0.41\n')
          else if (args[0] === 'connect') output = Buffer.from(`connected to ${args[1]}\n`)
          else if (args[0] === 'devices') output = Buffer.from(ANDROID_DEVICES)
          else if (args.includes('exec-out'))
            output = options.hugeScreenshot ? new Uint8Array(WORKSPACE_DEVICE_IMAGE_LIMIT + 1) : PNG
          else if (args.includes('avd')) output = Buffer.from('Pixel_8\nOK\n')
          else if (args.includes(options.failCommand ?? '__never__')) exitCode = 1
        } else if ((name === 'emulator' || name === 'emulator.exe') && options.android !== false) {
          if (args[0] === '-list-avds') output = Buffer.from('Pixel_8\nPixel_9\n')
        } else if (name === 'xcrun' && options.ios) {
          if (args.includes('list'))
            output = Buffer.from(
              JSON.stringify({
                devices: {
                  'iOS 19': [
                    { udid: ios.id, name: 'iPhone fixture', state: 'Booted', isAvailable: true },
                    {
                      udid: 'B8CA1977-2222-4444-8888-D8AABC000002',
                      name: 'iPad fixture',
                      state: 'Shutdown',
                      isAvailable: true,
                    },
                    {
                      udid: 'B8CA1977-3333-4444-8888-D8AABC000003',
                      name: 'Unavailable fixture',
                      state: 'Shutdown',
                      isAvailable: false,
                    },
                  ],
                },
              }),
            )
          else if (args.includes('screenshot')) {
            const path = args.at(-1)
            if (!path) return yield* missing()
            writeFileSync(path, PNG)
            files.push(path)
          }
        } else if (name !== 'open') return yield* missing()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            killed.push(command)
          }),
        )
        return {
          pid: 123,
          stdout: Stream.make(output),
          stderr: Stream.empty,
          all: Stream.make(output),
          exitCode: Effect.succeed(exitCode),
          isRunning: Effect.succeed(args[0] === '-avd'),
          kill: Effect.sync(() => {
            killed.push(command)
          }),
        }
      }),
  )
  const layer = workspaceDevicesLayer({
    platform: options.platform ?? 'linux',
    environment: { ANDROID_HOME: '/sdk' },
  }).pipe(Layer.provide(Layer.merge(fake.layer, NodeFileSystem.layer)))
  return { ...fake, layer, killed, files }
}

function withDevices<A, E>(
  setup: ReturnType<typeof harness>,
  use: (devices: WorkspaceDevices['Service']) => Effect.Effect<A, E>,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const devices = yield* WorkspaceDevices
      return yield* use(devices)
    }).pipe(Effect.provide(setup.layer)),
  )
}

describe('device boundary validation', () => {
  it('accepts real Android serials and simulator IDs while rejecting shell syntax', () => {
    expect(Schema.is(workspaceDeviceRefSchema)(android)).toBe(true)
    expect(Schema.is(workspaceDeviceRefSchema)({ platform: 'android', id: '192.168.1.2:5555' })).toBe(true)
    expect(Schema.is(workspaceDeviceRefSchema)(ios)).toBe(true)
    expect(Schema.is(workspaceDeviceRefSchema)({ ...android, id: 'device;rm -rf' })).toBe(false)
    expect(Schema.is(workspaceDeviceRefSchema)({ ...android, id: '--help' })).toBe(false)
  })
  it('bounds coordinates and command text before transport', () => {
    expect(Schema.is(workspaceDeviceActionSchema)({ ...android, kind: 'tap', x: -1, y: 3 })).toBe(false)
    expect(
      Schema.is(workspaceDeviceActionSchema)({
        ...android,
        kind: 'swipe',
        x: 1,
        y: 2,
        endX: 3,
        endY: 4,
        duration: 100000,
      }),
    ).toBe(false)
    expect(Schema.is(workspaceDeviceActionSchema)({ ...android, kind: 'launch', appId: 'com.example.app;exit' })).toBe(
      false,
    )
    expect(Schema.is(workspaceDeviceActionSchema)({ ...android, kind: 'open-url', url: 'javascript:alert(1)' })).toBe(
      false,
    )
  })
  it('bounds Android network connections to one explicit host and valid port', () => {
    expect(Schema.is(workspaceDeviceConnectSchema)({ address: '192.168.1.2:5555' })).toBe(true)
    expect(Schema.is(workspaceDeviceConnectSchema)({ address: '[::1]:5555' })).toBe(true)
    expect(Schema.is(workspaceDeviceConnectSchema)({ address: '127.0.0.1:99999' })).toBe(false)
    expect(Schema.is(workspaceDeviceConnectSchema)({ address: 'host:5555;touch /tmp/x' })).toBe(false)
  })
  it('quotes adb shell words because adb joins the arguments on the device', () => {
    expect(androidDeviceShellWord('simple')).toBe('simple')
    expect(androidDeviceShellWord("it's;$(whoami) &")).toBe("'it'\\''s;$(whoami) &'")
  })
  it('parses connection and authorization status without enabling unauthorized devices', () => {
    const devices = parseAndroidDeviceList(ANDROID_DEVICES)
    expect(devices).toHaveLength(4)
    expect(devices.find(device => device.id === android.id)).toMatchObject({
      name: 'Phone Test',
      state: 'booted',
      emulator: false,
      capabilities: { screenshot: true, input: true, shutdown: false },
    })
    expect(devices.find(device => device.id === 'blocked')).toMatchObject({
      state: 'unauthorized',
      capabilities: { screenshot: false, input: false },
    })
  })
})

describe('real local device commands', () => {
  it('discovers connected devices and only dormant emulator definitions', async () => {
    const setup = harness()
    const result = await withDevices(setup, devices => devices.list)
    expect(result.devices.find(device => device.id === 'avd:Pixel_8')).toBeUndefined()
    expect(result.devices.find(device => device.id === 'avd:Pixel_9')).toMatchObject({
      name: 'Pixel_9',
      state: 'shutdown',
    })
    expect(result.devices.find(device => device.id === 'emulator-5554')?.name).toBe('Pixel_8')
    expect(result.tools).toMatchObject([
      { platform: 'android', available: true },
      { platform: 'ios', available: false },
    ])
    expect(setup.starts.some(call => call.command === 'xcrun')).toBe(false)
    expect(setup.starts.every(call => call.options.windowsHide)).toBe(true)
  })
  it('reports missing tools and unsupported host platforms accurately', async () => {
    const setup = harness({ android: false, platform: 'win32' })
    const result = await withDevices(setup, devices => devices.list)
    expect(result.devices).toEqual([])
    expect(result.tools[0]).toMatchObject({ available: false, emulatorAvailable: false })
    expect(result.tools[1]?.detail).toContain('macOS')
  })
  it('sends tap, swipe and keyboard commands only to the selected serial', async () => {
    const setup = harness()
    await withDevices(setup, devices =>
      Effect.gen(function* () {
        yield* devices.list
        yield* devices.action({ ...android, kind: 'tap', x: 10, y: 20 })
        yield* devices.action({ ...android, kind: 'swipe', x: 10, y: 20, endX: 300, endY: 400, duration: 150 })
        yield* devices.action({ ...android, kind: 'key', key: 'back' })
      }),
    )
    const commands = setup.starts.filter(call => call.args.includes('shell')).map(call => call.args)
    expect(commands).toEqual([
      ['-s', 'usb123', 'shell', 'input', 'tap', '10', '20'],
      ['-s', 'usb123', 'shell', 'input', 'swipe', '10', '20', '300', '400', '150'],
      ['-s', 'usb123', 'shell', 'input', 'keyevent', '4'],
    ])
  })
  it('passes user text as one quoted device-shell argument', async () => {
    const setup = harness()
    await withDevices(setup, devices => devices.action({ ...android, kind: 'text', text: "it's $(whoami); text" }))
    expect(setup.starts.find(call => call.args.includes('text'))?.args).toEqual([
      '-s',
      android.id,
      'shell',
      'input',
      'text',
      "'it'\\''s%s$(whoami);%stext'",
    ])
  })
  it('keeps untrusted app links inside one remote shell word', async () => {
    const setup = harness()
    await withDevices(setup, devices =>
      devices.action({ ...android, kind: 'open-url', url: 'https://example.com/$(whoami);x' }),
    )
    expect(setup.starts.find(call => call.args.includes('am'))?.args.at(-1)).toBe("'https://example.com/$(whoami);x'")
  })
  it('connects Android over TCP only after an explicit connect request', async () => {
    const setup = harness()
    await withDevices(setup, devices => devices.connect('192.168.1.2:5555'))
    expect(setup.starts.find(call => call.args[0] === 'connect')?.args).toEqual(['connect', '192.168.1.2:5555'])
  })
  it('refuses text the Android input command cannot represent faithfully', async () => {
    const setup = harness()
    const result = await withDevices(setup, devices =>
      Effect.exit(devices.action({ ...android, kind: 'text', text: 'literal%svalue' })),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(setup.starts.some(call => call.args.includes('text'))).toBe(false)
  })
  it('never controls unknown or unauthorized devices', async () => {
    const setup = harness()
    await withDevices(setup, devices =>
      Effect.gen(function* () {
        const unknown = yield* Effect.exit(
          devices.action({ ...android, id: 'missing-device', kind: 'tap', x: 2, y: 3 }),
        )
        const blocked = yield* Effect.exit(devices.action({ ...android, id: 'blocked', kind: 'tap', x: 2, y: 3 }))
        expect(Exit.isFailure(unknown)).toBe(true)
        expect(Exit.isFailure(blocked)).toBe(true)
      }),
    )
    expect(setup.starts.some(call => call.args.includes('tap'))).toBe(false)
  })
  it('captures binary PNG output without converting it through text', async () => {
    const setup = harness()
    const screenshot = await withDevices(setup, devices => devices.screenshot(android))
    expect(screenshot).toMatchObject({
      platform: 'android',
      id: android.id,
      width: 1,
      height: 1,
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    })
    expect(setup.starts.find(call => call.args.includes('screencap'))?.args).toEqual([
      '-s',
      android.id,
      'exec-out',
      'screencap',
      '-p',
    ])
  })
  it('kills command scope and rejects screenshots over the byte limit', async () => {
    const setup = harness({ hugeScreenshot: true })
    const result = await withDevices(setup, devices => Effect.exit(devices.screenshot(android)))
    expect(Exit.isFailure(result)).toBe(true)
    expect(setup.killed.length).toBeGreaterThan(0)
  })
  it('launches installed apps through argv and keeps install paths literal', async () => {
    const setup = harness()
    const appPath = resolve('fixture apps', 'debug app.apk')
    await withDevices(setup, devices =>
      Effect.gen(function* () {
        yield* devices.action({ ...android, kind: 'launch', appId: 'com.example.fixture' })
        yield* devices.install(android, appPath)
      }),
    )
    expect(setup.starts.find(call => call.args.includes('monkey'))?.args).toContain('com.example.fixture')
    expect(setup.starts.find(call => call.args.includes('install'))?.args).toEqual([
      '-s',
      android.id,
      'install',
      '-r',
      appPath,
    ])
  })
  it('does not power off a physical Android device', async () => {
    const setup = harness()
    const result = await withDevices(setup, devices => Effect.exit(devices.shutdown(android)))
    expect(Exit.isFailure(result)).toBe(true)
    expect(setup.starts.some(call => call.args.includes('kill'))).toBe(false)
  })
  it('boots only a discovered emulator using an application-owned process', async () => {
    const setup = harness()
    await withDevices(setup, devices =>
      Effect.gen(function* () {
        yield* devices.boot({ platform: 'android', id: 'avd:Pixel_9' })
        yield* devices.boot({ platform: 'android', id: 'avd:Pixel_9' })
        const status = yield* devices.list
        expect(status.devices.find(device => device.id === 'avd:Pixel_9')?.state).toBe('starting')
      }),
    )
    expect(setup.starts.find(call => call.args.includes('-avd'))?.args).toEqual(['-avd', 'Pixel_9'])
    expect(setup.starts.filter(call => call.args.includes('-avd'))).toHaveLength(1)
  })
  it('discovers iOS simulators on macOS and exposes only actual local capabilities', async () => {
    const setup = harness({ platform: 'darwin', android: false, ios: true })
    const result = await withDevices(setup, devices => devices.list)
    expect(result.devices).toHaveLength(2)
    expect(result.devices.find(device => device.id === ios.id)).toMatchObject({
      platform: 'ios',
      state: 'booted',
      capabilities: { screenshot: true, input: false, orientation: false, install: true, launch: true },
    })
    expect(result.tools.find(tool => tool.platform === 'ios')?.available).toBe(true)
  })
  it('captures iOS screenshots through scoped files and removes them afterwards', async () => {
    const setup = harness({ platform: 'darwin', android: false, ios: true })
    const screenshot = await withDevices(setup, devices => devices.screenshot(ios))
    expect(screenshot.dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(setup.files).toHaveLength(1)
    expect(setup.files.every(path => !existsSync(path))).toBe(true)
  })
  it('does not claim iOS touch input is implemented by simctl', async () => {
    const setup = harness({ platform: 'darwin', android: false, ios: true })
    const result = await withDevices(setup, devices => Effect.exit(devices.action({ ...ios, kind: 'tap', x: 1, y: 2 })))
    expect(Exit.isFailure(result)).toBe(true)
    expect(setup.starts.some(call => call.args.includes('tap'))).toBe(false)
  })
})

describe('device screenshot decoding', () => {
  it('rejects command errors masquerading as image output and excessive dimensions', () => {
    expect(() => deviceScreenshotFromPng(android, Buffer.from('adb: device offline'), 0)).toThrow(WorkspaceDeviceError)
    const image = Buffer.from(PNG)
    image.writeUInt32BE(999999, 16)
    expect(() => deviceScreenshotFromPng(android, image, 0)).toThrow(WorkspaceDeviceError)
  })
})
