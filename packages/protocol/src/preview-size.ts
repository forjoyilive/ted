export const previewPresets = ['desktop', 'tablet', 'mobile'] as const
export type PreviewPreset = (typeof previewPresets)[number]

export type PreviewSize =
  | { kind: 'desktop' }
  | { kind: 'tablet' | 'mobile'; landscape: boolean }
  | { kind: 'custom'; width: number }

export const previewWidthLimits = { min: 320, max: 3840 }

export const previewDevices = {
  tablet: {
    label: 'Tablet',
    width: 768,
    height: 1024,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'iPad',
  },
  mobile: {
    label: 'Mobile',
    width: 390,
    height: 844,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  },
} as const

export const previewZooms = ['fit', '50', '75', '100'] as const
export type PreviewZoom = (typeof previewZooms)[number]

export function previewSizeOf(preset: PreviewPreset | undefined): PreviewSize {
  return preset === 'tablet' || preset === 'mobile'
    ? { kind: preset, landscape: false }
    : { kind: 'desktop' }
}

export function previewSize(value: string): PreviewSize | string {
  const given = value.trim().toLowerCase()
  if (given === 'desktop') return { kind: 'desktop' }
  const device = /^(tablet|mobile)(-landscape)?$/.exec(given)
  if (device) return { kind: device[1] === 'tablet' ? 'tablet' : 'mobile', landscape: !!device[2] }
  const width = /^(\d{1,4})(px)?$/.exec(given)
  const { min, max } = previewWidthLimits
  if (width && Number(width[1]) >= min && Number(width[1]) <= max)
    return { kind: 'custom', width: Number(width[1]) }
  return `Give desktop, tablet, mobile, tablet-landscape, mobile-landscape or a width from ${min} to ${max}`
}

export function previewSizeValue(size: PreviewSize): string {
  if (size.kind === 'custom') return String(size.width)
  if (size.kind === 'desktop') return 'desktop'
  return size.landscape ? `${size.kind}-landscape` : size.kind
}

export function previewDimensions(
  size: PreviewSize,
): { width: number; height?: number } | undefined {
  if (size.kind === 'desktop') return undefined
  if (size.kind === 'custom') return { width: size.width }
  const { width, height } = previewDevices[size.kind]
  return size.landscape ? { width: height, height: width } : { width, height }
}

export function previewSizeLabel(size: PreviewSize): string {
  if (size.kind === 'desktop') return 'Desktop'
  if (size.kind === 'custom') return `Custom · ${size.width} px`
  const { width, height } = previewDimensions(size) ?? { width: 0, height: 0 }
  return `${previewDevices[size.kind].label} · ${width} × ${height}`
}

export function samePreviewSize(a: PreviewSize, b: PreviewSize): boolean {
  return previewSizeValue(a) === previewSizeValue(b)
}
