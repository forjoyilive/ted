import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isModelName } from '@ted/protocol'
import { isObject, isString, parseJson } from '@ted/protocol/parse'
import { runCli } from '../health/cli.ts'
import type { AuthCheck } from './agent.ts'

export const piNoModels = 'Pi lists no models. Add a model to Pi, then choose Check again.'

export function piModelRows(listing: string): number {
  const lines = listing.split('\n').map((line) => line.trim())
  const header = lines.findIndex((line) => /^provider\s+model\b/.test(line))
  if (header === -1) return 0
  return lines.slice(header + 1).filter((line) => /^\S+\s+\S+/.test(line)).length
}

export async function piHealth(options: {
  binary: string
  env: NodeJS.ProcessEnv
  cwd: string
}): Promise<AuthCheck> {
  const listing = await runCli(options.binary, ['--list-models'], { ...options, timeoutMs: 30_000 })
  if (listing.code !== 0 || piModelRows(listing.stdout) === 0)
    return { signedIn: false, problem: { reason: piNoModels } }
  return { signedIn: true }
}

function agentDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir()
  const given = env.PI_CODING_AGENT_DIR
  if (!given) return path.join(home, '.pi', 'agent')
  if (given === '~') return home
  return given.startsWith('~/') ? path.join(home, given.slice(2)) : path.resolve(given)
}

export function piSavedModel(env: NodeJS.ProcessEnv): string | undefined {
  let text: string
  try {
    text = readFileSync(path.join(agentDir(env), 'settings.json'), 'utf8')
  } catch {
    return undefined
  }
  const settings = parseJson(text)
  if (!isObject(settings) || !isString(settings.defaultModel)) return undefined
  const model = settings.defaultModel.trim()
  const provider = isString(settings.defaultProvider) ? settings.defaultProvider.trim() : ''
  const named =
    provider !== '' && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model
  return model !== '' && isModelName(named) ? named : undefined
}
