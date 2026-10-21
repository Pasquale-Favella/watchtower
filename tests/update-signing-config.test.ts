import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../electron-builder.config.cjs', import.meta.url), 'utf8')

function config(platform: string, env: Record<string, string> = {}) {
  const module = { exports: {} }
  runInNewContext(source, { process: { platform, env }, module })
  return module.exports
}

describe('release signing policy', () => {
  it.each(['', ' \t '])('treats a blank CI certificate link %j as missing', CSC_LINK => {
    const env = { CSC_LINK, CSC_KEY_PASSWORD: '' }
    expect(config('darwin', env)).toMatchObject({
      forceCodeSigning: false,
      extraMetadata: { watchtowerSignedUpdates: false },
      mac: { identity: '-', hardenedRuntime: false, notarize: false },
    })
    expect(env).not.toHaveProperty('CSC_LINK')
    expect(env).toHaveProperty('CSC_KEY_PASSWORD', '')
  })

  it('keeps ad-hoc macOS releases on manual updates', () => {
    expect(config('darwin')).toMatchObject({
      forceCodeSigning: false,
      extraMetadata: { watchtowerSignedUpdates: false },
      mac: { identity: '-', hardenedRuntime: false, notarize: false },
    })
  })

  it('requires notarization credentials when macOS signing is requested', () => {
    expect(() => config('darwin', { CSC_LINK: 'certificate' })).toThrow('notarization')
    expect(
      config('darwin', {
        CSC_LINK: 'certificate',
        APPLE_ID: 'apple',
        APPLE_APP_SPECIFIC_PASSWORD: 'password',
        APPLE_TEAM_ID: 'team',
      }),
    ).toMatchObject({
      forceCodeSigning: true,
      extraMetadata: { watchtowerSignedUpdates: true },
      mac: { hardenedRuntime: true, notarize: true },
    })
  })

  it('requires Windows signatures only when credentials are supplied', () => {
    expect(config('win32')).toMatchObject({ forceCodeSigning: false })
    expect(config('win32', { CSC_LINK: 'certificate' })).toMatchObject({ forceCodeSigning: true })
  })
})
