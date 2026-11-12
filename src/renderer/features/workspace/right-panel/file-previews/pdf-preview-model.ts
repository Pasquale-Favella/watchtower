export interface PdfPreviewSize {
  readonly scale: number
  readonly ratio: number
  readonly width: number
  readonly height: number
  readonly pixelWidth: number
  readonly pixelHeight: number
}

/** Keeps each raster allocation bounded regardless of the document's authored page dimensions. */
export function pdfPreviewSize(
  pageWidth: number,
  pageHeight: number,
  availableWidth: number,
  zoom: number | null,
  deviceRatio: number,
): PdfPreviewSize {
  if (![pageWidth, pageHeight].every(value => Number.isFinite(value) && value > 0 && value < 10_000_000))
    throw new Error('The PDF page dimensions are invalid.')
  const ratio = Math.max(1, Math.min(2, deviceRatio || 1))
  const fitted = Math.max(0.01, (availableWidth - 32) / pageWidth)
  const maximumScale = Math.min(
    3,
    16_000 / pageWidth / ratio,
    16_000 / pageHeight / ratio,
    Math.sqrt(16_000_000 / pageWidth / pageHeight) / ratio,
  )
  const scale = Math.min(zoom ?? fitted, maximumScale)
  const width = Math.max(1, pageWidth * scale)
  const height = Math.max(1, pageHeight * scale)
  return { scale, ratio, width, height, pixelWidth: Math.ceil(width * ratio), pixelHeight: Math.ceil(height * ratio) }
}
