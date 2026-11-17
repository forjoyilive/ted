import { isAgentId } from './agent-files.ts'
import { isBoolean, reader, type Untyped } from './parse.ts'
import { RequestValidationError as HttpError } from './validation.ts'

export const maxOutsideCommands = 10

export const maxOutsideArgument = 100

export const outsideCommandLimitMs = 2 * 60 * 60_000

const plainWord = /^[A-Za-z0-9@%+=:,./_-]+$/

const slotWord = /^<[a-z][a-z0-9-]{0,39}>$/

export type OutsideWord = { kind: 'text'; text: string } | { kind: 'slot'; name: string }

export type OutsideWords = { words: OutsideWord[] } | { problem: string }

export function outsideCommandWords(command: string): OutsideWords {
  if (/[\n\r\t]/.test(command)) return { problem: 'must be one line' }
  const words = command.trim().split(/ +/)
  if (words.length === 0 || words[0] === '') return { problem: 'is empty' }
  const parsed: OutsideWord[] = []
  for (const word of words) {
    if (slotWord.test(word)) {
      parsed.push({ kind: 'slot', name: word.slice(1, -1) })
      continue
    }
    if (!plainWord.test(word))
      return {
        problem: `has \`${word}\`, which isn’t a plain word; outside commands take no quotes or shell characters`,
      }
    parsed.push({ kind: 'text', text: word })
  }
  const slots = parsed.filter((w) => w.kind === 'slot').length
  if (slots > 1) return { problem: 'has more than one argument slot' }
  if (parsed[0]?.kind === 'slot') return { problem: 'can’t start with its argument slot' }
  return { words: parsed }
}

function slotOf(words: readonly OutsideWord[]): string | undefined {
  for (const word of words) if (word.kind === 'slot') return word.name
  return undefined
}

export function outsideSlot(command: string): string | undefined {
  const parsed = outsideCommandWords(command)
  return 'words' in parsed ? slotOf(parsed.words) : undefined
}

export function outsideArgumentProblem(argument: string): string | undefined {
  if (argument === '') return 'is empty'
  if (argument.length > maxOutsideArgument) return `is longer than ${maxOutsideArgument} characters`
  if (argument.startsWith('-')) return 'starts with a dash'
  if (!/^[A-Za-z0-9._-]+$/.test(argument))
    return 'isn’t a plain word; an argument may hold only letters, digits, dot, dash and underscore'
  return undefined
}

export function outsideArgv(
  command: string,
  argument: string | undefined,
): { argv: [string, ...string[]] } | { problem: string } {
  const parsed = outsideCommandWords(command)
  if ('problem' in parsed) return { problem: `The command ${parsed.problem}` }
  const { words } = parsed
  const slot = slotOf(words)
  if (slot !== undefined && argument === undefined)
    return { problem: `This command needs an argument for <${slot}>` }
  if (slot === undefined && argument !== undefined)
    return { problem: 'This command takes no argument' }
  if (argument !== undefined) {
    const problem = outsideArgumentProblem(argument)
    if (problem !== undefined) return { problem: `\`${argument}\` ${problem}` }
  }
  const argv = words.map((w) => (w.kind === 'slot' ? (argument ?? '') : w.text))
  const [program, ...rest] = argv
  if (program === undefined) return { problem: 'The command is empty' }
  return { argv: [program, ...rest] }
}

export function shownOutsideCommand(command: string, argument: string | undefined): string {
  const result = outsideArgv(command, argument)
  return 'argv' in result ? result.argv.join(' ') : command
}

export interface RunOutsideCommandRequest {
  name: string
  argument?: string
}

export interface RunOutsideCommandResult {
  state: 'asked' | 'running'
  requestId?: string
  message: string
}

export interface OutsideCommandAsk {
  name: string
  command: string
  argument?: string
  folder: string
  repo: string
  allowedBefore?: string
}

export interface OutsideCommandAnswer {
  run: boolean
  always: boolean
}

export interface OutsideCommandAllowance {
  id: string
  factoryId: string
  agentId: string
  name: string
  command: string
  allowedAt: string
}

const read = reader((message) => {
  throw new HttpError(400, message)
})

export function parseRunOutsideCommandRequest(value: Untyped): RunOutsideCommandRequest {
  const body = read.object(value, 'body', 'body must be a JSON object')
  const name = read.string(body, 'name', 'name must be one of this Agent’s outside command names')
  if (!isAgentId(name))
    throw new HttpError(400, 'name must be one of this Agent’s outside command names')
  const argument = read.optional(body, 'argument', (object, field) =>
    read.string(object, field, 'argument must be text'),
  )
  if (argument !== undefined) {
    const problem = outsideArgumentProblem(argument)
    if (problem !== undefined) throw new HttpError(400, `the argument ${problem}`)
  }
  return { name, ...(argument !== undefined && { argument }) }
}

export function parseOutsideCommandAnswer(value: Untyped): OutsideCommandAnswer {
  const body = read.object(value, 'body', 'body must be a JSON object')
  const run = body.run
  if (!isBoolean(run)) throw new HttpError(400, 'run must be true or false')
  const always = body.always ?? false
  if (!isBoolean(always)) throw new HttpError(400, 'always must be true or false')
  if (always && !run) throw new HttpError(400, 'Always allow needs Run')
  return { run, always }
}
