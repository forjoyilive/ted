export const sandboxGroupNames = ['ios-xcode', 'network'] as const

export type SandboxGroup = (typeof sandboxGroupNames)[number]

export interface SandboxGroupInfo {
  name: SandboxGroup
  summary: string
  opens: readonly string[]
}

export const sandboxGroups: readonly SandboxGroupInfo[] = [
  {
    name: 'ios-xcode',
    summary:
      'What Xcode, SwiftPM, actool and ibtool write outside TMPDIR. This is shared access on the user’s Mac: every process of the user uses these folders.',
    opens: [
      'Per-user temp folder: TemporaryItems/NSIRD_(xcodebuild|SWBBuildService|XCBBuildService|actool|ibtool|ibtoold|swift-build|swift-run|swift-test)_*',
      'Per-user temp folder: SwiftPM’s TemporaryDirectory.XXXXXX and Swift Build’s swbuild.tmp.XXXXXXXX',
      'Per-user temp folder: actool’s and ibtoold’s temp items, and ibtoold-<pid> pipes',
      '~/Library/Caches/org.swift.swiftpm/manifests/ManifestLoading: plain .dia files',
      'Runs with others-execute added to the umask, so its ibtoold pipes stay apart from the user’s own',
    ],
  },
  {
    name: 'network',
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
