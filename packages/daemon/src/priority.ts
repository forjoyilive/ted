import { accessSync, constants } from 'node:fs'

export const lowPriorityNiceness = 10

export interface PriorityWrapper {
  programs: readonly string[]
  args: readonly string[]
}

// macOS ignores niceness when it shares out the processor; a utility QoS clamp is what gives way.
const platformWrapper: PriorityWrapper =
  process.platform === 'darwin'
    ? { programs: ['/usr/sbin/taskpolicy'], args: ['-c', 'utility'] }
    : { programs: ['/usr/bin/nice', '/bin/nice'], args: ['-n', String(lowPriorityNiceness)] }

let warned = false

export function workCommand(
  command: string,
  args: readonly string[],
  lowPriority: boolean,
  wrapper: PriorityWrapper = platformWrapper,
): { command: string; args: string[] } {
  if (!lowPriority) return { command, args: [...args] }
  const program = wrapper.programs.find(isProgram)
  if (program === undefined) {
    if (!warned) {
      console.error(
        `${wrapper.programs.join(' or ')} isn’t there; TED’s work runs at normal priority`,
      )
    }
    warned = true
    return { command, args: [...args] }
  }
  return { command: program, args: [...wrapper.args, command, ...args] }
}

function isProgram(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}
