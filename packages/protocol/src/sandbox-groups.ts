export const sandboxGroupNames = ['ios-xcode', 'shared-tmp'] as const

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
    name: 'shared-tmp',
    label: 'Shared /tmp folder',
    summary:
      'Reading and writing /private/tmp (/tmp) on macOS, for tools that ignore TMPDIR. This is shared access on the user’s Mac: every process of the user uses this folder.',
    opens: ['/private/tmp: read and write'],
  },
]

export function isSandboxGroup(name: string): name is SandboxGroup {
  return sandboxGroupNames.some((n) => n === name)
}
