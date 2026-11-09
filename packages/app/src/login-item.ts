import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type LoginItemState = 'on' | 'off' | 'requires-approval' | 'unavailable'

export const macLoginService = 'design.kriya.ted.background.plist'

export const backgroundFlag = '--background'

interface LoginItemSettings {
  openAtLogin?: boolean
  type?: 'agentService'
  serviceName?: string
}

export interface LoginItemSystem {
  platform: NodeJS.Platform
  packaged: boolean
  macVersion: number
  executable: string
  autostartDir: string
  getLoginItemSettings(options: LoginItemSettings): { status?: string }
  setLoginItemSettings(settings: LoginItemSettings): void
}

export interface LoginItem {
  apply(enabled: boolean): Promise<LoginItemState>
}

const agent = { type: 'agentService', serviceName: macLoginService } as const

const macStates: Record<string, LoginItemState> = {
  enabled: 'on',
  'not-registered': 'off',
  'requires-approval': 'requires-approval',
  'not-found': 'unavailable',
}

function applyOnMac(system: LoginItemSystem, enabled: boolean): LoginItemState {
  if (system.macVersion < 13) return 'unavailable'
  system.setLoginItemSettings({ openAtLogin: enabled, ...agent })
  const { status } = system.getLoginItemSettings(agent)
  return macStates[status ?? ''] ?? 'unavailable'
}

function quoteExecArg(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('TED’s path has a line break in it')
  const quoted = value.replace(/["`$\\]/g, (c) => `\\${c}`)
  return `"${quoted.replaceAll('\\', '\\\\').replaceAll('%', '%%')}"`
}

export function desktopEntry(executable: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=TED',
    'Comment=Starts TED in the background',
    `Exec=${quoteExecArg(executable)} ${backgroundFlag}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

async function applyOnLinux(system: LoginItemSystem, enabled: boolean): Promise<LoginItemState> {
  const file = path.join(system.autostartDir, 'ted.desktop')
  if (!enabled) {
    await rm(file, { force: true })
    return 'off'
  }
  const text = desktopEntry(system.executable)
  await mkdir(system.autostartDir, { recursive: true })
  await rm(file, { force: true })
  await writeFile(file, text, { mode: 0o644, flag: 'wx' })
  return 'on'
}

export function createLoginItem(system: LoginItemSystem): LoginItem {
  return {
    async apply(enabled) {
      if (!system.packaged) return 'unavailable'
      if (system.platform === 'darwin') return applyOnMac(system, enabled)
      if (system.platform === 'linux') return applyOnLinux(system, enabled)
      return 'unavailable'
    },
  }
}

export function recordLoginItem(file: string, state?: string): LoginItem {
  return {
    async apply(enabled) {
      await appendFile(file, `${enabled ? 'on' : 'off'}\n`)
      if (!enabled) return 'off'
      return macStates[state ?? ''] ?? 'on'
    },
  }
}

export function startsInBackground(argv: readonly string[]): boolean {
  return argv.includes(backgroundFlag)
}
