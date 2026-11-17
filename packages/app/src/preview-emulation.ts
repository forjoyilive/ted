import { type PreviewSize, previewDevices, previewDimensions } from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'

export interface PreviewEmulation {
  metrics?: {
    width: number
    height: number
    deviceScaleFactor: 0
    mobile: boolean
    scale: number
  }
  device?: { userAgent: string; platform: string }
}

export interface EmulationTarget {
  send(method: string, params?: JsonObject): Promise<void>
  reload(): void
  loaded(): boolean
}

export function previewEmulation(
  size: PreviewSize,
  height: number,
  scale: number,
): PreviewEmulation {
  const dimensions = previewDimensions(size)
  if (!dimensions) return {}
  const device =
    size.kind === 'tablet' || size.kind === 'mobile' ? previewDevices[size.kind] : undefined
  return {
    metrics: {
      width: dimensions.width,
      height: dimensions.height ?? Math.max(1, Math.round(height / scale)),
      deviceScaleFactor: 0,
      mobile: device !== undefined,
      scale,
    },
    ...(device && { device: { userAgent: device.userAgent, platform: device.platform } }),
  }
}

export async function applyEmulation(
  target: EmulationTarget,
  current: PreviewEmulation | undefined,
  next: PreviewEmulation,
  original: string,
): Promise<void> {
  if (JSON.stringify(next.metrics) !== JSON.stringify(current?.metrics)) {
    if (next.metrics) await target.send('Emulation.setDeviceMetricsOverride', next.metrics)
    else if (current?.metrics) await target.send('Emulation.clearDeviceMetricsOverride')
  }
  if (next.device?.userAgent === current?.device?.userAgent) return
  await target.send('Emulation.setTouchEmulationEnabled', {
    enabled: next.device !== undefined,
    ...(next.device && { maxTouchPoints: 5 }),
  })
  await target.send(
    'Emulation.setUserAgentOverride',
    next.device
      ? { userAgent: next.device.userAgent, platform: next.device.platform }
      : { userAgent: original },
  )
  // Touch support and the user agent are read when a document starts.
  if (target.loaded()) target.reload()
}
