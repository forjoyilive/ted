import {
  type AppKind,
  appKinds,
  isLoopbackUrl,
  isSandboxAccess,
  type PreviewPreset,
  previewPresets,
  type SandboxAccess,
} from '@ted/protocol'
import { isArray, isString, type Untyped } from '@ted/protocol/parse'

export interface AppDeclaration {
  name: string
  kind: AppKind
  run: string
  url?: string
  ready: 'url' | 'start'
  port?: number
  env: Record<string, string>
  device?: string
  electron?: true
  preview?: PreviewPreset
  sandboxAccess?: SandboxAccess[]
}

export const defaultAppUrl = `http://localhost:\${PORT}`

export function appDeclarations(apps: readonly unknown[] | undefined): AppDeclaration[] {
  return (apps ?? []).flatMap((app) => {
    if (typeof app !== 'object' || app === null) return []
    const fields = app as Record<string, unknown>
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    const run = typeof fields.run === 'string' ? fields.run.trim() : ''
    if (name === '' || run === '') return []
    const kind = appKinds.find((k) => k === fields.kind) ?? 'web'
    const electron = kind === 'command' && fields.electron === true
    const preview = kind === 'web' ? previewPresets.find((p) => p === fields.preview) : undefined
    const url =
      kind !== 'web'
        ? undefined
        : typeof fields.url === 'string' && isLoopbackUrl(fields.url.replaceAll(`\${PORT}`, '1'))
          ? fields.url
          : defaultAppUrl
    const port =
      typeof fields.port === 'number' &&
      Number.isInteger(fields.port) &&
      fields.port > 0 &&
      fields.port < 65536
        ? fields.port
        : undefined
    const env =
      typeof fields.env === 'object' && fields.env !== null
        ? Object.fromEntries(
            Object.entries(fields.env as Record<string, unknown>).flatMap(([key, value]) =>
              typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                ? [[key, String(value)]]
                : [],
            ),
          )
        : {}
    const access = sandboxAccessOf(fields.sandbox_access)
    const ready =
      fields.ready === 'url' || fields.ready === 'start'
        ? fields.ready
        : kind === 'web' || electron
          ? 'url'
          : 'start'
    return [
      {
        name,
        kind,
        run,
        ...(url !== undefined && { url }),
        ready: url === undefined && !electron ? 'start' : ready,
        ...(port !== undefined && { port }),
        env,
        ...(typeof fields.device === 'string' && { device: fields.device }),
        ...(electron && { electron: true as const }),
        ...(preview !== undefined && { preview }),
        ...(access.length > 0 && { sandboxAccess: access }),
      },
    ]
  })
}

export function sandboxAccessOf(value: Untyped): SandboxAccess[] {
  if (!isArray(value)) return []
  return [...new Set(value.filter((name) => isString(name) && isSandboxAccess(name)))]
}
