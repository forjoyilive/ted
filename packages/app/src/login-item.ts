import { access, appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
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
  state(): Promise<LoginItemState>
}

const agent = { type: 'agentService', serviceName: macLoginService } as const

const macStates: Record<string, LoginItemState> = {
  enabled: 'on',
  'not-registered': 'off',
  'requires-approval': 'requires-approval',
  'not-found': 'unavailable',
}

function macState(system: LoginItemSystem): LoginItemState {
  const { status } = system.getLoginItemSettings(agent)
  return macStates[status ?? ''] ?? 'unavailable'
}

function applyOnMac(system: LoginItemSystem, enabled: boolean): LoginItemState {
  system.setLoginItemSettings({ openAtLogin: enabled, ...agent })
  return macState(system)
}

function quoteExecArg(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Ted’s path has a line break in it')
  const quoted = value.replace(/["`$\\]/g, (c) => `\\${c}`)
  return `"${quoted.replaceAll('\\', '\\\\').replaceAll('%', '%%')}"`
}

export function desktopEntry(executable: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Ted',
    'Comment=Starts Ted in the background',
    `Exec=${quoteExecArg(executable)} ${backgroundFlag}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

const autostartFile = (system: LoginItemSystem) => path.join(system.autostartDir, 'ted.desktop')

async function applyOnLinux(system: LoginItemSystem, enabled: boolean): Promise<LoginItemState> {
  const file = autostartFile(system)
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

function supported(system: LoginItemSystem): 'darwin' | 'linux' | undefined {
  if (!system.packaged) return undefined
  if (system.platform === 'darwin') return system.macVersion >= 13 ? 'darwin' : undefined
  return system.platform === 'linux' ? 'linux' : undefined
}

export function createLoginItem(system: LoginItemSystem): LoginItem {
  return {
    async apply(enabled) {
      const platform = supported(system)
      if (platform === 'darwin') return applyOnMac(system, enabled)
      if (platform === 'linux') return applyOnLinux(system, enabled)
      return 'unavailable'
    },
    async state() {
      const platform = supported(system)
      if (platform === 'darwin') return macState(system)
      if (platform === 'linux') {
        return access(autostartFile(system)).then(
          () => 'on',
          () => 'off',
        )
      }
      return 'unavailable'
    },
  }
}

export function recordLoginItem(file: string, state?: string): LoginItem {
  let current: LoginItemState = 'off'
  return {
    async apply(enabled) {
      await appendFile(file, `${enabled ? 'on' : 'off'}\n`)
      current = enabled ? (macStates[state ?? ''] ?? 'on') : 'off'
      return current
    },
    async state() {
      return current
    },
  }
}

export function startsInBackground(argv: readonly string[]): boolean {
  return argv.includes(backgroundFlag)
}
