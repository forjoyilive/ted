import { type PreviewSize, type PreviewZoom, previewDimensions } from '@ted/protocol/preview-size'

export const previewMargin = 24

export interface PreviewFrame {
  width: number
  height: number
  scale: number
}

export function previewFrame(
  size: PreviewSize,
  zoom: PreviewZoom,
  area: { width: number; height: number },
): PreviewFrame {
  const dimensions = previewDimensions(size)
  if (!dimensions) return { width: area.width, height: area.height, scale: 1 }
  const roomWidth = Math.max(1, area.width - 2 * previewMargin)
  const roomHeight = Math.max(1, area.height - 2 * previewMargin)
  const fit = Math.min(
    1,
    roomWidth / dimensions.width,
    dimensions.height === undefined ? 1 : roomHeight / dimensions.height,
  )
  const scale = Math.max(0.05, zoom === 'fit' ? fit : Math.min(Number(zoom) / 100, fit))
  return {
    width: Math.round(dimensions.width * scale),
    height: dimensions.height === undefined ? roomHeight : Math.round(dimensions.height * scale),
    scale,
  }
}
