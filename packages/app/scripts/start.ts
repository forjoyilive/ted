import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoEnvironment, demoHome, seedDemoFromCli } from '@ted/daemon/demo'
import { installedElectron } from './electron-path.ts'
import { sandboxRefusal } from './sandbox-refusal.ts'

const refusal = sandboxRefusal()
if (refusal) {
  console.error(refusal)
  process.exit(1)
}
const args = process.argv.slice(2)
const demo = args.includes('--demo')
const forwarded = args.filter((arg) => arg !== '--demo')
const cwd = fileURLToPath(new URL('..', import.meta.url))
const started = Date.now()
let env = process.env
const executable = demo ? await installedElectron() : undefined
if (demo) {
  if (
    process.env.TED_RUN ||
    process.env.TED_TASK ||
    process.env.TED_PLAN ||
    process.env.TED_RUN_CAPABILITY ||
    process.env.TED_RUN_TOKEN
  )
    throw new Error('Launch the demo outside a Run.')
  const home = demoHome()
  env = demoEnvironment(home)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  env.TED_DEMO_STARTED = String(started)
}
async function run(command: string, argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}
const build = await run('pnpm', ['exec', 'vite', 'build'])
if (build !== 0) process.exit(build)
if (demo) await seedDemoFromCli(demoHome())
process.exitCode = executable
  ? await run(executable, [path.resolve(cwd), ...forwarded])
  : await run('pnpm', ['exec', 'electron', path.resolve(cwd), ...forwarded])
