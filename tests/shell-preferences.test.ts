import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SHELL_PREFERENCES,
  loadShellPreferences,
  saveShellPreferences,
  shellPreferencesSchema,
} from '../src/platform/electron/main/shell-preferences.js'

const directories: string[] = []
function preferencesFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-shell-preferences-'))
  directories.push(directory)
  return join(directory, 'shell-preferences.json')
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('shell preference persistence contract', () => {
  it('defaults fields independently and preserves explicit false values', async () => {
    const file = preferencesFile()
    writeFileSync(file, '{"runInBackground":false,"orbEnabled":"false","orbPosition":{"x":12.6,"y":-4.7},"extra":1}')
    expect(await Effect.runPromise(loadShellPreferences(file))).toEqual({
      runInBackground: false,
      orbEnabled: true,
      orbPosition: { x: 13, y: -5 },
    })
    writeFileSync(file, '{}')
    expect(await Effect.runPromise(loadShellPreferences(file))).toEqual(DEFAULT_SHELL_PREFERENCES)
  })

  it.each([null, { x: '1', y: 2 }, { x: Infinity, y: 2 }, { x: 1 }, [], false])(
    'rejects malformed coordinates through the field fallback: %j',
    position => {
      expect(Schema.decodeUnknownSync(shellPreferencesSchema)({ orbEnabled: false, orbPosition: position })).toEqual({
        runInBackground: true,
        orbEnabled: false,
        orbPosition: null,
      })
    },
  )

  it('keeps missing files, malformed JSON and failed writes in the typed error channel', async () => {
    const file = preferencesFile()
    expect(await Effect.runPromise(Effect.result(loadShellPreferences(file)))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ShellPreferencesError', operation: 'read', code: 'ENOENT' },
    })
    writeFileSync(file, '{broken')
    expect(await Effect.runPromise(Effect.result(loadShellPreferences(file)))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ShellPreferencesError', operation: 'decode', code: 'invalid-json' },
    })
    expect(
      await Effect.runPromise(Effect.result(saveShellPreferences(join(file, 'child'), DEFAULT_SHELL_PREFERENCES))),
    ).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ShellPreferencesError', operation: 'write' },
    })
  })

  it('round-trips the existing JSON shape without adding fields', async () => {
    const file = preferencesFile()
    const preferences = { runInBackground: false, orbEnabled: false, orbPosition: { x: -100, y: 220 } }
    await Effect.runPromise(saveShellPreferences(file, preferences))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(preferences)
    expect(await Effect.runPromise(loadShellPreferences(file))).toEqual(preferences)
  })
})
