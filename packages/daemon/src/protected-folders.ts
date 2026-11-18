import path from 'node:path'
import { isObject, isString, parseJson } from '@ted/protocol/parse'

// macOS asks the user before an app reads these, so a Run that walks into one raises a privacy prompt.
export const protectedFolders = [
  'Desktop',
  'Documents',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Library/Application Support/AddressBook',
  'Library/Calendars',
  'Library/CloudStorage',
  'Library/Containers',
  'Library/Group Containers',
  'Library/Mail',
  'Library/Messages',
  'Library/Mobile Documents',
  'Library/Reminders',
  'Library/Safari',
] as const

export function protectedPaths(home: string): string[] {
  return protectedFolders.map((folder) => path.join(home, folder))
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const before = `(?:^|[\\s'"=:(\`<>])`
const end = `(?=$|[\\s'";|&)\`<>])`

function homePattern(home: string): RegExp {
  const homes = ['~', '$HOME', '${HOME}', home.replace(/\/+$/, '')].map(escapeRegex).join('|')
  const folders = protectedFolders.map(escapeRegex).join('|')
  return new RegExp(`${before}(?:${homes})(?:/?${end}|/(?:${folders})(?=$|[/\\s'";|&)\`<>]))`, 'i')
}

export function namesHomeOrProtectedFolder(command: string, home: string): boolean {
  return homePattern(home).test(command.replaceAll('\\ ', ' '))
}

export const homeGuardMessage =
  'Ted doesn’t let a Run search the home folder or open Desktop, Documents, Downloads or other personal folders outside the sandbox, because macOS then asks the user for permission. Work inside the worktree, or name the exact folder you need outside it.'

export function refusesUnsandboxedCommand(hookInput: string, home: string): boolean {
  const input = parseJson(hookInput)
  if (!isObject(input) || input.tool_name !== 'Bash' || !isObject(input.tool_input)) return false
  const { command, dangerouslyDisableSandbox } = input.tool_input
  return (
    dangerouslyDisableSandbox === true &&
    isString(command) &&
    namesHomeOrProtectedFolder(command, home)
  )
}
