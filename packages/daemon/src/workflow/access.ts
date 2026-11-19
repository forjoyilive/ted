import type { AccessHolder, SandboxAccessChange } from '@ted/protocol'
import { sandboxAccessChanges } from '@ted/protocol'
import { isObject, isString } from '@ted/protocol/parse'
import { sandboxAccessOf } from '../apps/declared.ts'
import { checkLayer, type WorkflowSettings } from './check.ts'

export function accessHolders(settings: WorkflowSettings | undefined): AccessHolder[] {
  const holders: AccessHolder[] = []
  for (const entry of settings?.repos ?? []) {
    const repo = entry.name
    const where = repo === undefined ? {} : { repo }
    for (const kind of ['setup', 'teardown'] as const) {
      const command = entry.worktree?.[kind]
      if (command) {
        holders.push({
          kind,
          ...where,
          name: kind,
          groups: sandboxAccessOf(command.sandbox_access),
        })
      }
    }
    for (const app of entry.apps ?? []) {
      if (!isObject(app)) continue
      const name = isString(app.name) ? app.name : ''
      holders.push({ kind: 'app', ...where, name, groups: sandboxAccessOf(app.sandbox_access) })
    }
  }
  for (const check of settings?.stages.validate?.checks ?? []) {
    if (check.run === undefined) continue
    holders.push({
      kind: 'check',
      ...(check.repo !== undefined && { repo: check.repo }),
      name: check.name,
      groups: sandboxAccessOf(check.sandbox_access),
    })
  }
  return holders
}

export function workflowAccessChanges(
  before: string | undefined,
  after: string | undefined,
): SandboxAccessChange[] {
  const holders = (text: string | undefined) =>
    text === undefined
      ? []
      : accessHolders(checkLayer({ kind: 'factory', files: { 'workflow.yaml': text } }).settings)
  return sandboxAccessChanges(holders(before), holders(after))
}
