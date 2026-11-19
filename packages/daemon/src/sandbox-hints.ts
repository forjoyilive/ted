import { appendFile, open } from 'node:fs/promises'
import { type SandboxGroup, sandboxGroupNames } from '@ted/protocol'
import { redactSecrets } from './redact.ts'

const perUserTemp = String.raw`/(?:private/)?var/folders/[^/\s]+/[^/\s]+/T/`
const uuid = '[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}'
const xcodeSavers =
  'xcodebuild|SWBBuildService|XCBBuildService|actool|ibtool|ibtoold|swift-build|swift-run|swift-test'

const groupPaths: Record<SandboxGroup, RegExp> = {
  'ios-xcode': new RegExp(
    [
      `${perUserTemp}(?:TemporaryItems/NSIRD_(?:${xcodeSavers})_|TemporaryDirectory\\.[A-Za-z0-9]{6}|swbuild\\.tmp\\.[A-Za-z0-9]{8}|actool-sprite-atlas-scratch-|ibtoold-[0-9]+|Untitled-[A-Za-z0-9]{8}\\.uicatalog|${uuid})`,
      '/org\\.swift\\.swiftpm/manifests/ManifestLoading/',
    ].join('|'),
    'i',
  ),
}

const refused =
  /operation not permitted|permission denied|(?:don[’']t|do not) have permission|not allowed to|sandbox(?:-exec)?:.*deny/i

export function refusedGroups(output: string): SandboxGroup[] {
  const lines = output.split('\n').filter((line) => refused.test(line))
  return sandboxGroupNames.filter((group) => lines.some((line) => groupPaths[group].test(line)))
}

export function refusalHints(output: string, held: readonly SandboxGroup[], who: string): string[] {
  return refusedGroups(output)
    .filter((group) => !held.includes(group))
    .map(
      (group) =>
        `Ted: the sandbox refused a path in the ${group} access group, which ${who} doesn’t have. Propose sandbox_access: [${group}] for it in .ted/workflow.yaml instead of working around the refusal; it takes effect once the user merges or approves it.`,
    )
}

const scannedBytes = 1024 * 1024

export async function appendRefusalHints(
  log: string,
  held: readonly SandboxGroup[],
  who: string,
): Promise<void> {
  try {
    const output = await readTail(log)
    const hints = refusalHints(output, held, who)
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
