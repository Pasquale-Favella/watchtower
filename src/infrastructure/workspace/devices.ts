import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import { type CommandHandle, CommandRunner } from '@/core/ports/process.js'
import { WorkspaceDevices } from '@/core/ports/workspace-devices.js'
import {
  WORKSPACE_DEVICE_IMAGE_LIMIT,
  type WorkspaceDevice,
  type WorkspaceDeviceAction,
  workspaceDeviceActionSchema,
  workspaceDeviceConnectSchema,
  WorkspaceDeviceError,
  workspaceDeviceIdSchema,
  type WorkspaceDeviceList,
  workspaceDeviceMessages,
  type WorkspaceDeviceRef,
  workspaceDeviceRefSchema,
  type WorkspaceDeviceScreenshot,
} from '@/shared/schemas/workspace-devices.js'

function failure(code: WorkspaceDeviceError['code']): WorkspaceDeviceError {
  return new WorkspaceDeviceError({ code, message: workspaceDeviceMessages[code] })
}

export function androidDeviceShellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

function capabilities(
  platform: 'android' | 'ios',
  running: boolean,
  emulator: boolean,
): WorkspaceDevice['capabilities'] {
  return {
    screenshot: running,
    input: running && platform === 'android',
    orientation: running && platform === 'android',
    install: running,
    launch: running,
    shutdown: running && emulator,
  }
}

export function parseAndroidDeviceList(output: string): WorkspaceDevice[] {
  const devices: WorkspaceDevice[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|offline|unauthorized)\b(.*)$/.exec(line)
    if (!match || !Schema.is(workspaceDeviceIdSchema)(match[1])) continue
    const id = match[1]
    if (!id) continue
    let state: WorkspaceDevice['state'] = 'offline'
    if (match[2] === 'device') state = 'booted'
    else if (match[2] === 'unauthorized') state = 'unauthorized'
    const model = /\bmodel:(\S+)/.exec(match[3] ?? '')?.[1]?.replaceAll('_', ' ')
    const emulator = id.startsWith('emulator-')
    devices.push({
      platform: 'android',
      id,
      name: (model || id).slice(0, 256),
      state,
      emulator,
      capabilities: capabilities('android', state === 'booted', emulator),
    })
    if (devices.length === 100) break
  }
  return devices
}

const simulatorListSchema = Schema.fromJsonString(
  Schema.Struct({
    devices: Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({
          udid: Schema.String,
          name: Schema.String,
          state: Schema.String,
          isAvailable: Schema.optional(Schema.Boolean),
        }),
      ),
    ),
  }),
)

export function deviceScreenshotFromPng(
  ref: WorkspaceDeviceRef,
  bytes: Uint8Array,
  capturedAt: number,
): WorkspaceDeviceScreenshot {
  const buffer = Buffer.from(bytes)
  if (buffer.byteLength > WORKSPACE_DEVICE_IMAGE_LIMIT) throw failure('image-too-large')
  if (
    buffer.byteLength < 24 ||
    !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw failure('command-failed')
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!width || !height || width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024)
    throw failure('image-too-large')
  return { ...ref, width, height, capturedAt, dataUrl: `data:image/png;base64,${buffer.toString('base64')}` }
}

export interface WorkspaceDeviceOptions {
  readonly platform?: NodeJS.Platform
  readonly environment?: NodeJS.ProcessEnv
}

function androidSdkRoot(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string {
  const configured = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT
  if (configured) return configured
  if (platform === 'win32') return join(environment.LOCALAPPDATA || homedir(), 'Android', 'Sdk')
  if (platform === 'darwin') return join(homedir(), 'Library', 'Android', 'sdk')
  return join(homedir(), 'Android', 'Sdk')
}

function androidToolDetail(available: boolean, emulator: boolean): string {
  if (!available) return 'Install Android SDK Platform-Tools and add adb to PATH, or set ANDROID_HOME.'
  if (!emulator) return 'Connected Android devices are available. Install the SDK emulator to start virtual devices.'
  return 'Android SDK tools are ready.'
}

function iosToolDetail(platform: NodeJS.Platform, available: boolean): string {
  if (available)
    return 'Xcode simulators support screenshots, app installation and launch. Touch input requires an interactive device host.'
  if (platform === 'darwin')
    return 'Install Xcode and its simulator runtimes, then select the Xcode command-line tools.'
  return 'Local iOS simulators require macOS with Xcode.'
}

export function workspaceDevicesLayer(options: WorkspaceDeviceOptions = {}) {
  return Layer.effect(
    WorkspaceDevices,
    Effect.gen(function* () {
      const runner = yield* CommandRunner
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Scope.Scope
      const platform = options.platform ?? process.platform
      const environment = options.environment ?? process.env
      const windows = platform === 'win32'
      const sdk = androidSdkRoot(platform, environment)
      let adb = 'adb'
      let emulator = 'emulator'
      let known = new Map<string, WorkspaceDevice>()
      let lastList = 0
      const gates = new Map<string, Semaphore.Semaphore>()
      const startingAvds = new Map<string, CommandHandle>()
      const deviceKey = (ref: WorkspaceDeviceRef) => `${ref.platform}:${ref.id}`
      const gateFor = (ref: WorkspaceDeviceRef) => {
        const key = deviceKey(ref)
        let gate = gates.get(key)
        if (!gate) {
          gate = Semaphore.makeUnsafe(1)
          gates.set(key, gate)
        }
        return gate
      }

      const run = Effect.fn('WorkspaceDevices.command')(function* (
        command: string,
        args: readonly string[],
        maxBytes = 128 * 1024,
        timeout = 10000,
      ) {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* runner
              .start(command, args, { windowsHide: true })
              .pipe(Effect.mapError(() => failure('unavailable')))
            const chunks: Uint8Array[] = []
            let length = 0
            yield* Stream.runForEach(handle.stdout, chunk => {
              length += chunk.byteLength
              if (length > maxBytes)
                return Effect.fail(
                  failure(maxBytes === WORKSPACE_DEVICE_IMAGE_LIMIT ? 'image-too-large' : 'command-failed'),
                )
              chunks.push(chunk)
              return Effect.void
            }).pipe(
              Effect.mapError(error => (Schema.is(WorkspaceDeviceError)(error) ? error : failure('command-failed'))),
            )
            const exitCode = yield* handle.exitCode.pipe(Effect.mapError(() => failure('command-failed')))
            return { bytes: Buffer.concat(chunks), exitCode }
          }),
        ).pipe(Effect.timeoutOption(Duration.millis(timeout)))
        if (Option.isNone(result)) return yield* failure('timeout')
        return result.value
      })
      const ok = Effect.fn('WorkspaceDevices.ok')(function* (
        command: string,
        args: readonly string[],
        timeout?: number,
      ) {
        const result = yield* run(command, args, 128 * 1024, timeout)
        if (result.exitCode !== 0) return yield* failure('command-failed')
        return result.bytes.toString('utf8')
      })
      const androidShell = (ref: WorkspaceDeviceRef, args: readonly string[]) =>
        ok(adb, ['-s', ref.id, 'shell', ...args.map(androidDeviceShellWord)])

      const list = Effect.fn('WorkspaceDevices.list')(function* (): Effect.fn.Return<
        WorkspaceDeviceList,
        WorkspaceDeviceError
      > {
        const devices: WorkspaceDevice[] = []
        const tools: WorkspaceDeviceList['tools'][number][] = []
        let androidAvailable = false
        for (const candidate of [...new Set([join(sdk, 'platform-tools', windows ? 'adb.exe' : 'adb'), 'adb'])]) {
          const probe = yield* run(candidate, ['version']).pipe(Effect.option)
          if (Option.isSome(probe) && probe.value.exitCode === 0) {
            adb = candidate
            androidAvailable = true
            break
          }
        }
        let avds: string[] = []
        let emulatorAvailable = false
        for (const candidate of [
          ...new Set([join(sdk, 'emulator', windows ? 'emulator.exe' : 'emulator'), 'emulator']),
        ]) {
          const probe = yield* run(candidate, ['-list-avds']).pipe(Effect.option)
          if (Option.isSome(probe) && probe.value.exitCode === 0) {
            emulator = candidate
            emulatorAvailable = true
            avds = probe.value.bytes
              .toString('utf8')
              .split(/\r?\n/)
              .map(value => value.trim())
              .filter(value => value && Schema.is(workspaceDeviceIdSchema)(value))
            break
          }
        }
        if (androidAvailable) {
          const connected = yield* ok(adb, ['devices', '-l']).pipe(Effect.option)
          if (Option.isSome(connected)) devices.push(...parseAndroidDeviceList(connected.value))
          const bootedAvds = new Set<string>()
          for (const device of devices.filter(
            item => item.platform === 'android' && item.emulator && item.state === 'booted',
          )) {
            const name = yield* ok(adb, ['-s', device.id, 'emu', 'avd', 'name']).pipe(Effect.option)
            if (Option.isSome(name)) {
              const actual = name.value.split(/\r?\n/)[0]?.trim()
              if (actual) {
                bootedAvds.add(actual)
                devices[devices.indexOf(device)] = { ...device, name: actual }
              }
            }
          }
          for (const name of avds) {
            if (bootedAvds.has(name)) {
              startingAvds.delete(name)
              continue
            }
            const owned = startingAvds.get(name)
            const isStarting = owned ? yield* owned.isRunning : false
            if (!isStarting) startingAvds.delete(name)
            devices.push({
              platform: 'android',
              id: `avd:${name}`,
              name,
              state: isStarting ? 'starting' : 'shutdown',
              emulator: true,
              capabilities: capabilities('android', false, true),
            })
          }
        }
        tools.push({
          platform: 'android',
          available: androidAvailable,
          emulatorAvailable,
          detail: androidToolDetail(androidAvailable, emulatorAvailable),
        })
        let iosAvailable = false
        if (platform === 'darwin') {
          const raw = yield* ok('xcrun', ['simctl', 'list', 'devices', 'available', '--json']).pipe(Effect.option)
          if (Option.isSome(raw)) {
            const decoded = yield* Schema.decodeUnknownEffect(simulatorListSchema)(raw.value).pipe(Effect.option)
            if (Option.isSome(decoded)) {
              iosAvailable = true
              for (const group of Object.values(decoded.value.devices))
                for (const simulator of group) {
                  if (simulator.isAvailable === false || !Schema.is(workspaceDeviceIdSchema)(simulator.udid)) continue
                  const state = simulator.state === 'Booted' ? 'booted' : 'shutdown'
                  devices.push({
                    platform: 'ios',
                    id: simulator.udid,
                    name: simulator.name.slice(0, 256),
                    state,
                    emulator: true,
                    capabilities: capabilities('ios', state === 'booted', true),
                  })
                }
            }
          }
        }
        tools.push({
          platform: 'ios',
          available: iosAvailable,
          emulatorAvailable: iosAvailable,
          detail: iosToolDetail(platform, iosAvailable),
        })
        const limited = devices.slice(0, 100)
        known = new Map(limited.map(device => [deviceKey(device), device]))
        lastList = yield* Clock.currentTimeMillis
        return { devices: limited, tools }
      })
      const resolve = Effect.fn('WorkspaceDevices.resolve')(function* (ref: WorkspaceDeviceRef, requireBooted = true) {
        yield* Schema.decodeUnknownEffect(workspaceDeviceRefSchema)(ref).pipe(
          Effect.mapError(() => failure('invalid-request')),
        )
        const now = yield* Clock.currentTimeMillis
        if (!known.has(deviceKey(ref)) || now - lastList > 30000) yield* list()
        const device = known.get(deviceKey(ref))
        if (!device) return yield* failure('not-found')
        if (requireBooted && device.state !== 'booted') return yield* failure('not-ready')
        return device
      })
      const action = Effect.fn('WorkspaceDevices.action')(function* (input: WorkspaceDeviceAction) {
        const request = yield* Schema.decodeUnknownEffect(workspaceDeviceActionSchema)(input).pipe(
          Effect.mapError(() => failure('invalid-request')),
        )
        const device = yield* resolve(request)
        if (request.platform === 'ios') {
          if (request.kind === 'launch') {
            yield* ok('xcrun', ['simctl', 'launch', request.id, request.appId])
            return
          }
          if (request.kind === 'open-url') {
            yield* ok('xcrun', ['simctl', 'openurl', request.id, request.url])
            return
          }
          if (request.kind === 'appearance') {
            yield* ok('xcrun', ['simctl', 'ui', request.id, 'appearance', request.appearance])
            return
          }
          return yield* failure('unsupported')
        }
        switch (request.kind) {
          case 'tap':
            yield* androidShell(request, ['input', 'tap', String(request.x), String(request.y)])
            return
          case 'swipe':
            yield* androidShell(request, [
              'input',
              'swipe',
              String(request.x),
              String(request.y),
              String(request.endX),
              String(request.endY),
              String(request.duration),
            ])
            return
          case 'text':
            if (/[^\x20-\x7e]/.test(request.text) || request.text.includes('%s'))
              return yield* failure('input-unsupported')
            yield* androidShell(request, ['input', 'text', request.text.replaceAll(' ', '%s')])
            return
          case 'key': {
            const keys = { home: '3', back: '4', overview: '187', power: '26', enter: '66', delete: '67' }
            yield* androidShell(request, ['input', 'keyevent', keys[request.key]])
            return
          }
          case 'orientation':
            if (device.emulator) {
              yield* androidShell(request, ['settings', 'put', 'system', 'accelerometer_rotation', '1'])
              yield* androidShell(request, ['cmd', 'window', 'user-rotation', 'free'])
              yield* ok(adb, [
                '-s',
                request.id,
                'emu',
                'sensor',
                'set',
                'acceleration',
                request.orientation === 'portrait' ? '0:9.8:0' : '9.8:0:0',
              ])
            } else {
              yield* androidShell(request, ['settings', 'put', 'system', 'accelerometer_rotation', '0'])
              yield* androidShell(request, [
                'settings',
                'put',
                'system',
                'user_rotation',
                request.orientation === 'portrait' ? '0' : '1',
              ])
            }
            return
          case 'appearance':
            yield* androidShell(request, ['cmd', 'uimode', 'night', request.appearance === 'dark' ? 'yes' : 'no'])
            return
          case 'open-url':
            yield* androidShell(request, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', request.url])
            return
          case 'launch':
            yield* androidShell(request, ['monkey', '-p', request.appId, '-c', 'android.intent.category.LAUNCHER', '1'])
            return
        }
      })
      return WorkspaceDevices.of({
        list: list(),
        connect: address =>
          Effect.gen(function* () {
            yield* Schema.decodeUnknownEffect(workspaceDeviceConnectSchema)({ address }).pipe(
              Effect.mapError(() => failure('invalid-request')),
            )
            const current = yield* list()
            if (!current.tools.some(tool => tool.platform === 'android' && tool.available))
              return yield* failure('unavailable')
            const result = yield* ok(adb, ['connect', address])
            if (!/\b(?:already )?connected to\s/i.test(result)) return yield* failure('command-failed')
            lastList = Number.NEGATIVE_INFINITY
          }),
        boot: ref =>
          gateFor(ref).withPermit(
            Effect.gen(function* () {
              const device = yield* resolve(ref, false)
              if (device.state === 'booted' || device.state === 'starting') return
              if (!device.emulator) return yield* failure('unsupported')
              if (ref.platform === 'ios') {
                yield* ok('xcrun', ['simctl', 'boot', ref.id], 30000)
                yield* ok('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', ref.id])
              } else if (ref.id.startsWith('avd:')) {
                const process = yield* runner.start(emulator, ['-avd', ref.id.slice(4)], { windowsHide: true }).pipe(
                  Effect.provideService(Scope.Scope, scope),
                  Effect.mapError(() => failure('unavailable')),
                )
                yield* Effect.forkIn(Stream.runDrain(process.all).pipe(Effect.ignore), scope)
                startingAvds.set(ref.id.slice(4), process)
              } else return yield* failure('not-ready')
              lastList = Number.NEGATIVE_INFINITY
            }),
          ),
        shutdown: ref =>
          gateFor(ref).withPermit(
            Effect.gen(function* () {
              const device = yield* resolve(ref)
              if (!device.capabilities.shutdown) return yield* failure('unsupported')
              if (ref.platform === 'ios') yield* ok('xcrun', ['simctl', 'shutdown', ref.id])
              else yield* ok(adb, ['-s', ref.id, 'emu', 'kill'])
              lastList = Number.NEGATIVE_INFINITY
            }),
          ),
        action: input => gateFor(input).withPermit(action(input)),
        screenshot: ref =>
          gateFor(ref).withPermit(
            Effect.gen(function* () {
              yield* resolve(ref)
              const bytes = yield* ref.platform === 'android'
                ? run(adb, ['-s', ref.id, 'exec-out', 'screencap', '-p'], WORKSPACE_DEVICE_IMAGE_LIMIT).pipe(
                    Effect.flatMap(result =>
                      result.exitCode === 0 ? Effect.succeed(result.bytes) : Effect.fail(failure('command-failed')),
                    ),
                  )
                : Effect.scoped(
                    Effect.gen(function* () {
                      const directory = yield* fs
                        .makeTempDirectoryScoped({ prefix: 'watchtower-device-' })
                        .pipe(Effect.mapError(() => failure('command-failed')))
                      const file = join(directory, 'screen.png')
                      yield* ok('xcrun', ['simctl', 'io', ref.id, 'screenshot', '--type=png', file])
                      const stat = yield* fs.stat(file).pipe(Effect.mapError(() => failure('command-failed')))
                      if (Number(stat.size) > WORKSPACE_DEVICE_IMAGE_LIMIT) return yield* failure('image-too-large')
                      return yield* fs.readFile(file).pipe(Effect.mapError(() => failure('command-failed')))
                    }),
                  )
              const now = yield* Clock.currentTimeMillis
              return yield* Effect.try({
                try: () => deviceScreenshotFromPng(ref, bytes, now),
                catch: error => (Schema.is(WorkspaceDeviceError)(error) ? error : failure('command-failed')),
              })
            }),
          ),
        install: (ref, path) =>
          gateFor(ref).withPermit(
            Effect.gen(function* () {
              yield* resolve(ref)
              if (!isAbsolute(path) || (ref.platform === 'android' ? !/\.apk$/i.test(path) : !/\.app$/i.test(path)))
                return yield* failure('invalid-request')
              if (ref.platform === 'android') yield* ok(adb, ['-s', ref.id, 'install', '-r', path], 60000)
              else yield* ok('xcrun', ['simctl', 'install', ref.id, path], 60000)
            }),
          ),
      })
    }),
  )
}

export const WorkspaceDevicesLive = workspaceDevicesLayer()
