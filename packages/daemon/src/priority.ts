import { accessSync, constants } from 'node:fs'

export const lowPriorityNiceness = 10

const nicePrograms = ['/usr/bin/nice', '/bin/nice']

let warned = false

export function workCommand(
  command: string,
  args: readonly string[],
  lowPriority: boolean,
  programs: readonly string[] = nicePrograms,
): { command: string; args: string[] } {
  if (!lowPriority) return { command, args: [...args] }
  const nice = programs.find(isProgram)
  if (nice === undefined) {
    if (!warned) console.error('no nice program found; TED’s work runs at normal priority')
    warned = true
    return { command, args: [...args] }
  }
  return { command: nice, args: ['-n', String(lowPriorityNiceness), command, ...args] }
}

function isProgram(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}
