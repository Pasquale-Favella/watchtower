// Ensures the Electron binary is present after `npm install`.
//
// Electron downloads its ~100 MB binary via its own postinstall script.
// In corporate/proxied environments (Zscaler etc.) that download can be
// interrupted or silently skipped, leaving `node_modules/electron/dist`
// missing — which makes `npm run dev` fail with "Error: Electron uninstall".
// This script runs after every install and re-runs Electron's installer
// whenever the binary is missing. It is a no-op (and instant) when the
// binary is already present.
'use strict'

const { existsSync, readFileSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const electronDir = join(__dirname, '..', 'node_modules', 'electron')
const pathFile = join(electronDir, 'path.txt')
const distDir = join(electronDir, 'dist')

function binaryIsPresent() {
  if (!existsSync(distDir) || !existsSync(pathFile)) return false
  const binName = readFileSync(pathFile, 'utf8').trim()
  return binName.length > 0 && existsSync(join(distDir, binName))
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log('[ensure-electron] ELECTRON_SKIP_BINARY_DOWNLOAD is set, skipping check.')
  process.exit(0)
}

if (binaryIsPresent()) {
  console.log('[ensure-electron] Electron binary OK.')
  process.exit(0)
}

console.warn('[ensure-electron] Electron binary is missing — re-downloading…')
try {
  execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(electronDir, 'install.js'))}`, {
    stdio: 'inherit',
  })
  if (!binaryIsPresent()) {
    console.error(
      '[ensure-electron] Download finished but the binary is still missing. ' +
        'Check your network, proxy, or antivirus settings, then run `npm install` again.',
    )
    process.exit(1)
  }
  console.log('[ensure-electron] Electron binary restored.')
} catch (err) {
  console.error('[ensure-electron] Failed to download the Electron binary:', err.message || err)
  process.exit(1)
}
