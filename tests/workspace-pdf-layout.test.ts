import { describe, expect, it } from 'vitest'

import { pdfPreviewSize } from '@/renderer/features/workspace/right-panel/file-previews/pdf-preview-model.js'
import { extendedFilePreviewKind } from '@/renderer/features/workspace/right-panel/file-previews/preview-types.js'

describe('PDF preview routing', () => {
  it('selects the native PDF worker viewer independently of filename case', () => {
    expect(extendedFilePreviewKind('folder/REPORT.PDF')).toBe('pdf')
    expect(extendedFilePreviewKind('folder/report.pdf.ts')).toBeNull()
  })
})

describe('bounded PDF page rendering', () => {
  it('fits a normal page while preserving its aspect ratio and native pixel density', () => {
    const viewport = pdfPreviewSize(612, 792, 644, null, 2)
    expect(viewport).toMatchObject({ width: 612, height: 792, scale: 1, ratio: 2, pixelWidth: 1224, pixelHeight: 1584 })
  })
  it('caps raster allocations and dimensions for oversized authored pages', () => {
    const viewport = pdfPreviewSize(100_000, 1_000_000, 800, 3, 3)
    expect(viewport.pixelWidth * viewport.pixelHeight).toBeLessThanOrEqual(16_010_000)
    expect(viewport.pixelWidth).toBeLessThanOrEqual(16_000)
    expect(viewport.pixelHeight).toBeLessThanOrEqual(16_000)
  })
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid page width %s', width => {
    expect(() => pdfPreviewSize(width, 792, 800, null, 1)).toThrow('dimensions')
  })
})
