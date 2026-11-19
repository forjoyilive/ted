import { spawn } from 'node:child_process'
import { isModelName } from '@ted/protocol'
import { isArray, isObject, isString, parseJson } from '@ted/protocol/parse'

export const piModelsTimeoutMs = 30_000

const request = 'ted-models'

export function piModelsReply(line: string): string[] | undefined {
  const reply = parseJson(line)
  if (!isObject(reply) || reply.type !== 'response' || reply.command !== 'get_available_models')
    return undefined
  if (reply.success !== true || !isObject(reply.data) || !isArray(reply.data.models)) return []
  const names: string[] = []
  for (const model of reply.data.models) {
    if (!isObject(model) || !isString(model.provider) || !isString(model.id)) continue
    const name = `${model.provider}/${model.id}`
    if (isModelName(name) && !names.includes(name)) names.push(name)
  }
  return names
}

export function piModels(options: {
  binary: string
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs?: number
}): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    let settled = false
    let buffered = ''
    const child = spawn(options.binary, ['--mode', 'rpc', '--no-session'], {
      env: options.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const finish = (models: string[] | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(models)
    }
    const timer = setTimeout(() => finish(undefined), options.timeoutMs ?? piModelsTimeoutMs)
    child.on('error', () => finish(undefined))
    child.on('close', () => finish(undefined))
    child.stdin.on('error', () => undefined)
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      let end = buffered.indexOf('\n')
      while (end !== -1) {
        const models = piModelsReply(buffered.slice(0, end).replace(/\r$/, ''))
        if (models !== undefined) return finish(models)
        buffered = buffered.slice(end + 1)
        end = buffered.indexOf('\n')
      }
    })
    child.stdin.end(`${JSON.stringify({ type: 'get_available_models', id: request })}\n`)
  })
}
