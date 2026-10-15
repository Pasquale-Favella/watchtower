'use strict'
// Electron entry for icon generation (spawned by generate-icons.cjs): renders
// assets/watchtower-logo.svg into a square 1024×1024 PNG with a transparent
// background, centered, in the app's brand cyan — legible on both light and
// dark taskbars/docks.

const { app, BrowserWindow } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, join } = require('path')

const SIZE = 1024
// Dark-theme primary cyan (src/renderer/src/assets/main.css): pops on light
// and dark system chrome alike.
const BRAND = '#06b6d4'
// The logo's native viewBox is a portrait crop (320.1 191.9 354 572) — the
// same bounds WatchtowerIcon renders. For an icon canvas, replace it with a
// square viewBox centered on that artwork (center 497.1/477.9 + 300 pad),
// so the glyph is centered with a small optical pad on the square.
const SQUARE_VIEWBOX = '197.1 177.9 600 600'

const root = join(__dirname, '..')
const outPath = join(root, 'build', 'icon.png')

const fail = message => {
  console.error(`[icons] ${message}`)
  app.exit(1)
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(join(root, 'assets', 'watchtower-logo.svg'), 'utf8')
  if (!/<svg/.test(svg)) return fail('source is not an SVG')

  // Frame the artwork: square viewBox, explicit canvas size, brand fill
  // inherited by the paths (the source paths carry no fill attribute).
  const framed = svg.replace(
    /<svg[^>]*>/,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SQUARE_VIEWBOX}" width="${SIZE}" height="${SIZE}" fill="${BRAND}">`,
  )
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style></head><body>${framed}</body></html>`

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    // Give the offscreen renderer a beat to paint the first frame.
    await new Promise(resolve => setTimeout(resolve, 500))
    let image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
    if (image.isEmpty()) return fail('capture was empty')

    // Some DPI configurations return a scaled, non-square page (e.g.
    // 1280×1020). electron-builder needs a square icon, so crop to the
    // centered square — the artwork is centered, so the glyph stays put.
    const page = image.getSize()
    if (page.width !== page.height) {
      const side = Math.min(page.width, page.height)
      const x = Math.round((page.width - side) / 2)
      const y = Math.round((page.height - side) / 2)
      image = image.crop({ x, y, width: side, height: side })
      if (image.isEmpty()) return fail('cropped icon was empty')
    }
    // Normalize to exactly 1024² so the committed build/icon.png is identical
    // regardless of the machine's DPI scale (capture can return 1020² etc.).
    if (page.width !== SIZE) {
      image = image.resize({ width: SIZE, height: SIZE })
      if (image.isEmpty()) return fail('resized icon was empty')
    }

    // Sanity-check the corner is transparent (BGRA), so the icon isn't a
    // white square in the taskbar.
    const bgra = image.toBitmap()
    const alpha = bgra[3]
    if (alpha > 0) {
      console.warn(`[icons] warning: icon background is not transparent (corner alpha ${alpha}) — check the SVG frame.`)
    }

    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, image.toPNG())
    console.log(`[icons] wrote ${outPath}`)
    app.exit(0)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
})
