import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { DaemonClient } from '../packages/protocol/src/client.ts'
import { readDaemonInfo } from '../packages/protocol/src/daemon-info.ts'
import { identity } from '../packages/protocol/src/edition.ts'
import type { SlotHolder } from '../packages/protocol/src/slots.ts'
import { hasPassed, runRefusal } from './check.ts'
import {
  builderIdentity,
  builtAppIn,
  checkSignature,
  chosenSigningIdentity,
  copyIntoApplications,
  installedApp,
  installedRunning,
  packageApp,
  type Step,
  sideCheckout,
  signingRefusal,
  smokeTest,
} from './mac-app.ts'

const root = path.resolve(import.meta.dirname, '..')
const installedHome = path.join(os.homedir(), identity('release').homeFolder)
const bundleId = 'design.kriya.ted'
const notaryVariables = [
  'APPLE_KEYCHAIN_PROFILE',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
]

export interface UpdateOptions {
  skipChecks: boolean
  yes: boolean
  finish?: Finish
}

export interface Finish {
  built: string
  commit: string
  log: string
}

export function updateOptions(args: string[]): UpdateOptions {
  const { values } = parseArgs({
    args,
    options: {
      'skip-checks': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      finish: { type: 'string' },
      commit: { type: 'string', default: '' },
      log: { type: 'string', default: '' },
    },
  })
  const options = { skipChecks: values['skip-checks'], yes: values.yes }
  if (values.finish === undefined) return options
  return { ...options, finish: { built: values.finish, commit: values.commit, log: values.log } }
}

export type ChecksPlan =
  | { action: 'run' }
  | { action: 'skip'; reason: 'asked' | 'passed' }
  | { refusal: string }

export function checksPlan(facts: {
  skipChecks: boolean
  passed: boolean
  inRun: boolean
}): ChecksPlan {
  if (facts.skipChecks) return { action: 'skip', reason: 'asked' }
  if (facts.passed) return { action: 'skip', reason: 'passed' }
  if (facts.inRun) {
    return {
      refusal:
        'a Run can’t run pnpm check, and this commit hasn’t passed it yet. Run pnpm check --all in a terminal first, or pass --skip-checks.',
    }
  }
  return { action: 'run' }
}

export function otherWorkingTasks(holders: readonly SlotHolder[], ownTask?: string): string[] {
  return holders.flatMap((holder) =>
    holder.kind === 'task' &&
    holder.runs > 0 &&
    holder.taskId !== ownTask &&
    holder.displayId !== ownTask
      ? [holder.displayId]
      : [],
  )
}

export type QuitDecision = { action: 'quit' | 'ask' } | { refusal: string }

export function quitDecision(facts: {
  working: number | undefined
  yes: boolean
  terminal: boolean
}): QuitDecision {
  if (facts.yes || facts.working === 0) return { action: 'quit' }
  if (facts.working === undefined) {
    return {
      refusal:
        'Ted is running, but its working Tasks couldn’t be counted. Run again with --yes to quit it anyway.',
    }
  }
  if (facts.terminal) return { action: 'ask' }
  const tasks = facts.working === 1 ? '1 other Task is' : `${facts.working} other Tasks are`
  return {
    refusal: `${tasks} working, and quitting Ted stops them. Run again with --yes to quit anyway.`,
  }
}

export function installFailedMessage(built: string, error: string, log: string): string {
  return `The install failed (${error}), so ${installedApp} may be missing or incomplete. Run pnpm update-installed again, or copy this build yourself: ditto '${built}' ${installedApp}. See ${log}`
}

export function notificationScript(title: string, message: string): string {
  const text = (value: string) => JSON.stringify(value.replace(/\s+/g, ' '))
  return `display notification ${text(message)} with title ${text(title)}`
}

function fail(message: string): never {
  console.error(`update-installed: ${message}`)
  process.exit(1)
}

function stepIn(cwd: string, env: NodeJS.ProcessEnv = process.env): Step {
  return (title, command, args) => {
    console.log(`\n== ${title}`)
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`${title} failed`)
  }
}

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function prepareCheckout(checkout: string): string {
  const here = stepIn(root)
  here('Fetch', 'git', ['fetch', 'origin', 'main'])
  if (existsSync(checkout)) {
    if (gitIn(checkout, 'status', '--porcelain') !== '') {
      fail(`the update checkout at ${checkout} has changes; remove them first`)
    }
    stepIn(checkout)('Check out origin/main', 'git', [
      'checkout',
      '--quiet',
      '--detach',
      'origin/main',
    ])
  } else {
    here('Prune old worktrees', 'git', ['worktree', 'prune'])
    here('Check out origin/main', 'git', ['worktree', 'add', '--detach', checkout, 'origin/main'])
  }
  stepIn(checkout)('Install', 'pnpm', ['install', '--frozen-lockfile'])
  return gitIn(checkout, 'rev-parse', 'HEAD')
}

function runChecks(checkout: string, commit: string, skipChecks: boolean): void {
  const plan = checksPlan({
    skipChecks,
    passed: hasPassed(commit),
    inRun: runRefusal() !== undefined,
  })
  if ('refusal' in plan) fail(plan.refusal)
  if (plan.action === 'skip' && plan.reason === 'asked') {
    console.log(
      `\n== Skipping the checks (--skip-checks): ${commit.slice(0, 8)} hasn’t passed a full run`,
    )
  } else if (plan.action === 'skip') {
    console.log('\n== Checks already passed on this commit; skipping them')
  } else {
    stepIn(checkout)('Check', 'pnpm', ['check', '--all'])
  }
}

function buildEnv() {
  const refusal = signingRefusal(process.env)
  if (refusal !== undefined) fail(refusal)
  const env = { ...process.env }
  for (const name of notaryVariables) delete env[name]
  const name = chosenSigningIdentity(process.env)
  if (name === undefined) {
    delete env.CSC_NAME
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    console.log('\n== No Developer ID Application certificate in the keychain; building unsigned')
    return { env, signed: false }
  }
  env.CSC_NAME = builderIdentity(name)
  console.log(`\n== Signing with ${name}, without notarizing`)
  return { env, signed: true }
}

async function workingTasks(): Promise<string[] | undefined> {
  const info = await readDaemonInfo(installedHome).catch(() => undefined)
  if (info === undefined) return undefined
  try {
    const slots = await new DaemonClient(info).getSlots()
    return otherWorkingTasks(slots.holders, process.env.TED_TASK)
  } catch {
    return undefined
  }
}

async function confirmQuit(yes: boolean): Promise<void> {
  if (!installedRunning()) return
  const working = await workingTasks()
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const decision = quitDecision({ working: working?.length, yes, terminal })
  const names = working?.join(', ') ?? ''
  if ('refusal' in decision)
    fail(names ? `${decision.refusal} Working: ${names}` : decision.refusal)
  if (decision.action === 'quit') return
  console.log(`\nWorking now: ${names}. Quitting Ted stops them.`)
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question('Quit Ted anyway? [y/N] ')
  prompt.close()
  if (!/^y(es)?$/i.test(answer.trim())) fail('stopped; Ted is still running the old build')
}

function startFinish(checkout: string, built: string, commit: string): void {
  const log = `${checkout}.log`
  const out = openSync(log, 'w')
  const child = spawn(
    process.execPath,
    [
      path.join(root, 'scripts/update-installed.ts'),
      '--finish',
      built,
      '--commit',
      commit,
      '--log',
      log,
    ],
    { cwd: os.homedir(), detached: true, stdio: ['ignore', out, out] },
  )
  child.unref()
  console.log(`\nTed quits now and reopens on ${commit.slice(0, 8)}. Progress is in ${log}`)
}

async function update(options: UpdateOptions): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('this updates /Applications/Ted.app, so it runs only on an Apple silicon Mac')
  }
  const checkout = sideCheckout(root, 'update')
  if (existsSync(checkout) && realpathSync(checkout) === realpathSync(root)) {
    fail('run this from your own checkout, not the update checkout')
  }
  const commit = prepareCheckout(checkout)
  try {
    runChecks(checkout, commit, options.skipChecks)
    const { env, signed } = buildEnv()
    packageApp(stepIn(checkout, env), { installers: false })
    const built = builtAppIn(checkout)
    if (signed) checkSignature(stepIn(checkout), built)
    smokeTest(stepIn(checkout))
    await confirmQuit(options.yes)
    startFinish(checkout, built, commit)
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}; Ted wasn’t touched`)
  }
}

function notify(title: string, message: string): void {
  console.log(`\n${title}: ${message}`)
  spawnSync('osascript', ['-e', notificationScript(title, message)])
}

async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) return false
    await sleep(500)
  }
  return true
}

async function quitInstalled(): Promise<void> {
  if (!installedRunning()) return
  const { markQuit, stopTedProcesses } = await import('../packages/daemon/src/launch.ts')
  console.log('== Quit Ted')
  await markQuit(installedHome)
  const info = await readDaemonInfo(installedHome).catch(() => undefined)
  // The daemon.json token may only stop the daemon with keepRuns; stopTedProcesses then ends the
  // Run hosts with SIGTERM, and the next daemon offers those Tasks a restart.
  if (info !== undefined) {
    await Promise.race([
      new DaemonClient(info).shutdown({ keepRuns: true }).catch(() => undefined),
      sleep(15_000),
    ])
  }
  await stopTedProcesses(installedHome)
  const deadline = Date.now() + 15_000
  spawnSync('osascript', ['-e', `tell application id "${bundleId}" to quit`], { timeout: 10_000 })
  if (await waitFor(() => !installedRunning(), Math.max(0, deadline - Date.now()))) return
  console.log('Ted didn’t quit by itself; stopping it')
  spawnSync('pkill', ['-KILL', '-f', `${installedApp}/Contents/MacOS/`])
  if (!(await waitFor(() => !installedRunning(), 10_000))) throw new Error('Ted didn’t quit')
}

async function finish({ built, commit, log }: Finish): Promise<void> {
  const short = commit.slice(0, 8)
  try {
    await quitInstalled()
  } catch (error) {
    notify(
      'Ted didn’t update',
      `It couldn’t quit Ted (${String(error)}). Quit Ted, then open ${installedApp}. See ${log}`,
    )
    process.exit(1)
  }
  try {
    console.log(`\n== Install into ${installedApp}`)
    copyIntoApplications(stepIn(os.homedir()), built)
  } catch (error) {
    notify('Ted didn’t update', installFailedMessage(built, String(error), log))
    process.exit(1)
  }
  console.log('\n== Open Ted')
  spawnSync('open', [installedApp])
  if (!(await waitFor(installedRunning, 60_000))) {
    notify('Ted updated but didn’t open', `Open ${installedApp} yourself. See ${log}`)
    process.exit(1)
  }
  notify('Ted updated', `Ted is running ${short} from main.`)
}

function optionsOrFail(args: string[]): UpdateOptions {
  try {
    return updateOptions(args)
  } catch (error) {
    return fail(
      `${error instanceof Error ? error.message : String(error)}\nusage: pnpm update-installed [--skip-checks] [--yes]`,
    )
  }
}

if (import.meta.main) {
  const options = optionsOrFail(process.argv.slice(2))
  if (options.finish !== undefined) await finish(options.finish)
  else await update(options)
}
