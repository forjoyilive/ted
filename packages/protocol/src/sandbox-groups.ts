export const sandboxGroupNames = ['ios-xcode', 'shared-tmp', 'electron', 'network'] as const

export type SandboxGroup = (typeof sandboxGroupNames)[number]

export interface SandboxGroupInfo {
  name: SandboxGroup
  label: string
  summary: string
  opens: readonly string[]
}

export const sandboxGroups: readonly SandboxGroupInfo[] = [
  {
    name: 'ios-xcode',
    label: 'Xcode and SwiftPM builds',
    summary:
      'What Xcode, SwiftPM, actool and ibtool write outside TMPDIR, and the iOS Simulator runtimes Xcode reads. This is shared access on the user’s Mac: every process of the user uses these folders.',
    opens: [
      'Per-user temp folder: TemporaryItems/NSIRD_(xcodebuild|SWBBuildService|XCBBuildService|actool|ibtool|ibtoold|swift-build|swift-run|swift-test)_*',
      'Per-user temp folder: SwiftPM’s TemporaryDirectory.XXXXXX and Swift Build’s swbuild.tmp.XXXXXXXX',
      'Per-user temp folder: actool’s and ibtoold’s temp items, and ibtoold-<pid> pipes',
      '~/Library/Caches/org.swift.swiftpm/manifests/ManifestLoading: plain .dia files',
      'Runs with others-execute added to the umask, so its ibtoold pipes stay apart from the user’s own',
      'Reads iOS Simulator runtimes mounted at /private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-*',
    ],
  },
  {
    name: 'shared-tmp',
    label: 'Shared /tmp folder',
    summary:
      'Reading and writing /private/tmp (/tmp) on macOS, for tools that ignore TMPDIR. This is shared access on the user’s Mac: every process of the user uses this folder.',
    opens: ['/private/tmp: read and write'],
  },
  {
    name: 'electron',
    label: 'Electron and its windows',
    summary:
      'The macOS services an Electron app needs to start and open a window. electron: true on an App gives it this group.',
    opens: [
      'macOS: com.apple.coreservices.launchservicesd, which Electron checks in with at launch',
      'macOS: com.apple.windowserver.active, without which no window opens',
      'Sets TED_SANDBOX_ELECTRON=1, so tools know Electron can start in this sandbox',
    ],
  },
  {
    name: 'network',
    label: 'Network access',
    summary:
      'Connections to any host, for package installs and Apps that call outside services. Without it a command reaches only loopback, or nothing when the Factory sets sandbox_network: none.',
    opens: [
      'Outbound connections to any IP address',
      'DNS lookups through mDNSResponder (macOS)',
      'Host networking (Linux)',
    ],
  },
]

export function isSandboxGroup(name: string): name is SandboxGroup {
  return sandboxGroupNames.some((n) => n === name)
}

export type SocketAccess = `socket:${string}`

export type SandboxAccess = SandboxGroup | SocketAccess

export interface NamedSocket {
  name: string
  path: string
}

const socketPrefix = 'socket:'

export function isSocketName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)
}

export function socketAccess(name: string): SocketAccess {
  return `${socketPrefix}${name}`
}

export function isSandboxAccess(entry: string): entry is SandboxAccess {
  return isSandboxGroup(entry) || socketOf(entry) !== undefined
}

export function socketOf(entry: string): string | undefined {
  if (!entry.startsWith(socketPrefix)) return undefined
  const name = entry.slice(socketPrefix.length)
  return isSocketName(name) ? name : undefined
}

export function accessGroups(access: readonly SandboxAccess[] | undefined): SandboxGroup[] {
  return (access ?? []).filter(isSandboxGroup)
}

export function accessSockets(access: readonly SandboxAccess[] | undefined): string[] {
  return (access ?? []).flatMap((entry) => socketOf(entry) ?? [])
}
