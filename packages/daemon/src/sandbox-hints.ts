import { appendFile, open } from 'node:fs/promises'
import { type SandboxAccess, type SandboxGroup, sandboxGroupNames } from '@ted/protocol'
import { redactSecrets } from './redact.ts'

const perUserTemp = String.raw`/(?:private/)?var/folders/[^/\s]+/[^/\s]+/T/`
const uuid = '[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}'
const xcodeSavers =
  'xcodebuild|SWBBuildService|XCBBuildService|actool|ibtool|ibtoold|swift-build|swift-run|swift-test'

const groupPaths: Record<Exclude<SandboxGroup, 'network'>, RegExp> = {
  'ios-xcode': new RegExp(
    [
      `${perUserTemp}(?:TemporaryItems/NSIRD_(?:${xcodeSavers})_|TemporaryDirectory\\.[A-Za-z0-9]{6}|swbuild\\.tmp\\.[A-Za-z0-9]{8}|actool-sprite-atlas-scratch-|ibtoold-[0-9]+|Untitled-[A-Za-z0-9]{8}\\.uicatalog|${uuid}|\\.?[^/\\s]+_${uuid}-[0-9]+-[0-9A-F]{16}\\.png)`,
      '/org\\.swift\\.swiftpm/manifests/ManifestLoading/',
    ].join('|'),
    'i',
  ),
  'shared-tmp': /(?<![\w./~-])\/(?:private\/)?tmp(?:\/|$|[\s'"`:,)])/m,
  electron: /com\.apple\.(?:coreservices\.launchservicesd|windowserver\.active)/i,
}

const refused =
  /operation not permitted|permission denied|(?:don[’']t|do not) have permission|not allowed to|sandbox(?:-exec)?:.*deny/i

// Without the network group, connects outside loopback get EPERM and macOS lookups fail, because mDNSResponder is closed.
const networkRefused =
  /connect EPERM|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|could not resolve host|nodename nor servname provided|temporary failure in name resolution/i

const groupRefusals: Record<SandboxGroup, (line: string) => boolean> = {
  'ios-xcode': (line) => refused.test(line) && groupPaths['ios-xcode'].test(line),
  'shared-tmp': (line) => refused.test(line) && groupPaths['shared-tmp'].test(line),
  electron: (line) => refused.test(line) && groupPaths.electron.test(line),
  network: (line) => networkRefused.test(line),
}

function refusedWhat(group: SandboxGroup, who: string): string {
  return group === 'network'
    ? `a connection or lookup outside this machine. The network access group allows it, and ${who} doesn’t have it`
    : `something in the ${group} access group, which ${who} doesn’t have`
}

const macOnly: readonly SandboxGroup[] = ['shared-tmp']

export function refusedGroups(
  output: string,
  platform: NodeJS.Platform = process.platform,
): SandboxGroup[] {
  const lines = output.split('\n')
  return sandboxGroupNames.filter(
    (group) =>
      (platform === 'darwin' || !macOnly.includes(group)) &&
      lines.some((line) => groupRefusals[group](line)),
  )
}

export function refusalHints(
  output: string,
  held: readonly SandboxAccess[],
  who: string,
  missingSockets: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    ...refusedGroups(output, platform)
      .filter((group) => !held.includes(group))
      .map(
        (group) =>
          `Ted: the sandbox refused ${refusedWhat(group, who)}. Propose sandbox_access: [${group}] for it in .ted/workflow.yaml instead of working around the refusal; it takes effect once the user merges or approves it.`,
      ),
    ...missingSockets.map(
      (name) =>
        `Ted: ${who} asks for socket:${name}, but the user’s Library names no socket ${name}, so the sandbox gave it none. The user adds ${name}: <socket path> under sandbox_sockets in the Library’s workflow.yaml.`,
    ),
  ]
}

const scannedBytes = 1024 * 1024

export async function appendRefusalHints(
  log: string,
  held: readonly SandboxAccess[],
  who: string,
  missingSockets: readonly string[] = [],
): Promise<void> {
  try {
    const output = await readTail(log)
    const hints = refusalHints(output, held, who, missingSockets)
    if (hints.length === 0) return
    const lead = output === '' || output.endsWith('\n') ? '' : '\n'
    await appendFile(log, `${lead}${hints.join('\n')}\n`)
  } catch (error) {
    console.error(
      redactSecrets(`couldn’t check ${who}’s output for sandbox refusals: ${String(error)}`),
    )
  }
}

async function readTail(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, scannedBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}
