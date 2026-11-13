import { describe, expect, it } from 'vitest'

import {
  compactBrowserSnapshot,
  MAX_BROWSER_SNAPSHOT_BYTES,
} from '../src/platform/electron/main/preview/browser-snapshot.js'

const source = {
  url: 'https://example.test/',
  title: 'Example',
  loading: false,
  visibleText: 'Page text',
  viewport: { width: 800, height: 600 },
  interactiveElements: [{ ref: 'g1e1', tag: 'button', role: 'button', name: 'Save', selector: '#save', x: 10, y: 20 }],
  accessibilityTree: 'button "Save"',
  console: [{ level: 'warning', text: 'A warning', timestamp: 123 }],
  network: [{ url: 'https://example.test/data', method: 'GET', status: 200, failed: false }],
  dialog: null,
}

describe('compact browser snapshots', () => {
  it('sends one ref representation and excludes optional diagnostics and internal geometry by default', () => {
    const result = compactBrowserSnapshot(source)
    expect(result.interactiveElements).toEqual([{ ref: 'g1e1', tag: 'button', role: 'button', name: 'Save' }])
    expect(result).not.toHaveProperty('accessibilityTree')
    expect(result).not.toHaveProperty('console')
    expect(result).not.toHaveProperty('network')
  })

  it('keeps pending dialogs available without diagnostic opt-in', () => {
    const result = compactBrowserSnapshot({ ...source, dialog: { type: 'confirm', message: 'Continue?' } })
    expect(result.dialog).toEqual({ type: 'confirm', message: 'Continue?' })
  })

  it('bounds UTF-8 JSON bytes while retaining usable refs and valid Unicode', () => {
    const result = compactBrowserSnapshot(
      {
        ...source,
        visibleText: '😀'.repeat(16000),
        interactiveElements: Array.from({ length: 60 }, (_, index) => ({
          ref: `g1e${index}`,
          role: 'button',
          name: '😀'.repeat(120),
        })),
        console: Array.from({ length: 24 }, () => ({ level: 'error', text: '界'.repeat(800) })),
        accessibilityTree: '界'.repeat(20000),
      },
      true,
      'C:/artifacts/screenshot.png',
    )
    const json = JSON.stringify(result)
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(MAX_BROWSER_SNAPSHOT_BYTES)
    expect(json).not.toMatch(/\\u[dD][89aAbB][0-9a-fA-F]{2}/)
    expect(result).toMatchObject({ truncated: true, screenshotPath: 'C:/artifacts/screenshot.png' })
    expect(result.interactiveElements).not.toHaveLength(0)
  })
})
