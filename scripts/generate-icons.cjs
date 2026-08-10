'use strict';
// Regenerates the app icon — build/icon.png (1024×1024) — from the brand SVG
// (assets/watchtower-logo.svg) using Electron's offscreen rendering, so no
// image toolchain (ImageMagick, sharp, …) is required. electron-builder
// auto-converts this single PNG into .ico (Windows), .icns (macOS), and PNG
// (Linux) at package time (ADR 0015).
//
// Usage: npm run icons

const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const svgPath = join(root, 'assets', 'watchtower-logo.svg');

if (!existsSync(svgPath)) {
  console.error(`[icons] missing source: ${svgPath}`);
  process.exit(1);
}

// Windows: spawn Electron's real binary (dist/electron.exe) directly — the
// node_modules/.bin/electron.cmd shim can't be exec'd without a shell, and
// shell-wrapping .cmd files is fragile. POSIX: the .bin/electron symlink is
// executable directly.
const electronBin = process.platform === 'win32'
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(root, 'node_modules', '.bin', 'electron');
if (!existsSync(electronBin)) {
  console.error(`[icons] Electron is not installed — run \`npm install\` first (missing ${electronBin}).`);
  process.exit(1);
}

const result = spawnSync(electronBin, [join(__dirname, 'render-icon.cjs')], {
  stdio: 'inherit',
  cwd: root,
});
if (result.error || result.status !== 0) {
  console.error('[icons] icon generation failed.');
  process.exit(result.status ?? 1);
}
