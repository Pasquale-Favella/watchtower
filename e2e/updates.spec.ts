import { expect, test } from '@playwright/test'
import type { Api } from '../src/preload/index'

import { dismissOnboarding, withApp } from './app'

test('updates IPC and Settings preserve the development-build fallback', async () => {
  await withApp(async ({ window }) => {
    const statuses = await window.evaluate(async () => {
      const api = (globalThis as unknown as { api: Api }).api
      return [
        await api.getUpdateStatus(),
        await api.checkForUpdates(),
        await api.downloadUpdate(),
        await api.installUpdate(),
      ]
    })
    for (const status of statuses) {
      expect(status).toMatchObject({
        phase: 'unsupported',
        installSupported: false,
        updateAvailable: false,
        latestVersion: null,
        progress: null,
      })
    }
    await dismissOnboarding(window)
    await window.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(window.getByRole('button', { name: 'Check for updates', exact: true })).toBeDisabled()
    await expect(window.getByRole('button', { name: 'Open release page' })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Download update', exact: true })).toHaveCount(0)
    await expect(window.getByRole('button', { name: 'Restart to install', exact: true })).toHaveCount(0)
  })
})
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

test('real updater verifies downloads and rejects a mismatched checksum', async () => {
  test.skip(process.platform !== 'win32', 'Exercises the Windows NSIS download implementation')
  const artifact = Buffer.from('Watchtower update transport test. This file is never executed.')
  const checksum = createHash('sha512').update(artifact).digest('base64')
  const identifiers: string[] = []
  let artifactRequests = 0
  const server = createServer((request, response) => {
    const identifier = request.headers['x-user-staging-id']
    if (identifier) identifiers.push(String(identifier))
    if (request.url?.includes('.yml')) {
      const corrupt = request.url.includes('/corrupt/')
      response.end(
        JSON.stringify({
          version: '99.0.0',
          files: [
            {
              url: corrupt ? 'corrupt.exe' : 'valid.exe',
              sha512: checksum,
              size: artifact.length,
            },
          ],
        }),
      )
    } else {
      artifactRequests++
      response.setHeader('Content-Length', artifact.length)
      response.end(request.url?.includes('corrupt.exe') ? Buffer.alloc(artifact.length) : artifact)
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Update test server did not bind')
  try {
    await withApp(async ({ app }) => {
      const outcomes = await app.evaluate(async ({ app }, port) => {
        const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`)
        const { NsisUpdater } = require('electron-updater') as typeof import('electron-updater')
        const fs = require('node:fs') as typeof import('node:fs')
        const path = require('node:path') as typeof import('node:path')
        const cache = path.join(app.getPath('userData'), 'update-transport-cache')
        fs.mkdirSync(cache, { recursive: true })
        app.setPath('cache', cache)
        const results = []
        for (const kind of ['valid', 'corrupt']) {
          const configPath = path.join(cache, `${kind}.yml`)
          fs.writeFileSync(configPath, `updaterCacheDirName: transport-${kind}\n`)
          const updater = new NsisUpdater()
          updater.updateConfigPath = configPath
          updater.forceDevUpdateConfig = true
          updater.autoDownload = false
          updater.autoInstallOnAppQuit = false
          updater.disableDifferentialDownload = true
          updater.logger = null
          updater.requestHeaders = { 'x-user-staging-id': '' }
          updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${port}/${kind}/` })
          const check = await updater.checkForUpdates()
          let downloaded = false
          let rejected = false
          updater.on('update-downloaded', () => {
            downloaded = true
          })
          try {
            await updater.downloadUpdate()
          } catch {
            rejected = true
          }
          results.push({
            available: check?.isUpdateAvailable,
            automaticDownload: check?.downloadPromise !== null,
            downloaded,
            rejected,
          })
        }
        return results
      }, address.port)
      expect(outcomes).toEqual([
        { available: true, automaticDownload: false, downloaded: true, rejected: false },
        { available: true, automaticDownload: false, downloaded: false, rejected: true },
      ])
      expect(artifactRequests).toBe(2)
      expect(identifiers).toEqual([])
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }
})
