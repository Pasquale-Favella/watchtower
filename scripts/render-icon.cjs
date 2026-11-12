'use strict'
// Electron entry for icon generation (spawned by generate-icons.cjs): renders
// assets/watchtower-logo.svg into a square 1024×1024 PNG with a transparent
// background, centered, in the app's brand cyan — legible on both light and
// dark taskbars/docks.

const { app, BrowserWindow, nativeImage } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, join } = require('path')

const SIZE = 1024
// Dark-theme primary cyan (src/renderer/assets/main.css): pops on light
// and dark system chrome alike.
const BRAND = '#06b6d4'
// Square option box for the icon canvas, centered on the logo's artwork
// (viewBox 190 44 960 1008 → center 670/548, side 1152 = 960/1008 scaled to a
// square), so the glyph is centered with a small optical pad on the square.
const SQUARE_VIEWBOX = '94 -28 1152 1152'

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
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}</style></head><body><img id="src" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(framed)}" alt="" style="display:none"><canvas id="out" width="${SIZE}" height="${SIZE}"></canvas><script>
  const img = document.getElementById('src')
  const done = (result) => { window.__iconResult = result }
  img.decode().then(() => {
    // Rasterize at the canvas's own backing-store resolution (1024²), so the
    // output is an exact square with a clean transparent background — no
    // capturePage involved (its offscreen buffer is DPI-scaled and can come
    // back truncated, e.g. 1280×1020, which clips the artwork).
    const canvas = document.getElementById('out')
    canvas.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE})
    done(canvas.toDataURL('image/png'))
  }).catch((err) => done('error: ' + err))
</script></body></html>`

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
    // Give the offscreen renderer a beat to decode the image and paint the
    // canvas (img.decode + drawImage + toDataURL are synchronous once ready,
    // but the load and script tick need a frame).
    let dataUrl = await win.webContents.executeJavaScript('window.__iconResult')
    for (let i = 0; i < 20 && !dataUrl; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      dataUrl = await win.webContents.executeJavaScript('window.__iconResult')
    }
    if (!dataUrl) return fail('canvas rasterization never returned a result')
    if (dataUrl.startsWith('error:')) return fail(`SVG rasterization failed: ${dataUrl.slice(6)}`)

    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) return fail('rasterized result was empty')
    const size = image.getSize()
    if (size.width !== SIZE || size.height !== SIZE) {
      return fail(`rasterized to ${size.width}×${size.height}, expected ${SIZE}²`)
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
