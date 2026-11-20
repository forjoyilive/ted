import { mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { format, parseArgs } from 'node:util'
import { crashFrom, edition, sentryDsn, tedEnv, tedHome, tedPaths, tedVersion } from '@ted/protocol'
import { crashReporter } from './crash-report.ts'
import { watchExitWith } from './exit-with.ts'
import { DaemonAlreadyRunningError, type RunningDaemon, startDaemon } from './index.ts'
import { closeInheritedFds } from './inherited-fds.ts'
import { daemonAlreadyRunningExitCode, tedQuitExitCode } from './launch.ts'
import { logConsoleTo, openRollingLog, tedLogLimits } from './logs.ts'
import { QuitMarkedError } from './quit-mark.ts'
import { redactSecrets } from './redact.ts'
import { holdAwakeWithOs, holdOnPowerWithOs } from './stay-awake.ts'

closeInheritedFds()
delete process.env.ELECTRON_RUN_AS_NODE

const paths = tedPaths(tedHome())
mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
logConsoleTo(openRollingLog(paths.daemonLog, tedLogLimits))

let running: RunningDaemon | undefined
const testSentryDsn = tedEnv('TED_SENTRY_DSN')
const reportCrash = crashReporter({
  part: 'daemon',
  dsn: testSentryDsn ?? sentryDsn,
  allowLoopbackHttp: testSentryDsn !== undefined,
  version: tedVersion,
  edition,
  enabled: () => running?.reporting() ?? false,
  post: (url, init) => fetch(url, init),
})
let crashing = false
process.on('uncaughtException', (error, origin) => {
  console.error('Uncaught exception:', error)
  process.stderr.write(`${redactSecrets(format(error))}\n`)
  if (crashing) process.exit(1)
  crashing = true
  setTimeout(() => process.exit(1), 6000).unref()
  void reportCrash(
    crashFrom(origin === 'unhandledRejection' ? 'rejection' : 'uncaught', error),
  ).finally(() => process.exit(1))
})

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { 'exit-when-idle': { type: 'boolean' }, 'app-token-stdin': { type: 'boolean' } },
})

async function readAppToken(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  const token = text.trim()
  if (token === '') throw new Error('--app-token-stdin was given but stdin held no token')
  return token
}

const appToken = values['app-token-stdin'] ? await readAppToken() : undefined

const demoLinear =
  edition === 'dev' && tedEnv('TED_DEMO') === '1'
    ? await import('../test/fixtures/stub-linear.ts').then(({ startStubLinear }) =>
        startStubLinear(),
      )
    : undefined

const asanaApi = tedEnv('TED_ASANA_API')
const linearApi = demoLinear?.url || tedEnv('TED_LINEAR_API')

let starting: Promise<RunningDaemon> | undefined
let stopping = false

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  const daemon = await starting?.catch(() => null)
  if (daemon === null) return
  await daemon?.stop((step) => console.log(`stopping Ted’s daemon: ${step}`))
  console.log('Ted’s daemon stopped')
  await demoLinear?.close()
  process.exit(0)
}

async function leaveUnattended(stoppedRuns: number): Promise<void> {
  if (stopping) return
  console.log(
    `nothing has used Ted’s daemon for a while: stopped ${stoppedRuns} Runs and stopping the daemon`,
  )
  if (demoLinear && stoppedRuns > 0) {
    const { checkDemoHome, markDemo } = await import('./dev/home.ts')
    await checkDemoHome(tedHome())
      .then((demo) => demo && markDemo(tedHome(), { ...demo, complete: false }))
      .catch((error: unknown) => console.error('couldn’t mark the demo as stopped:', error))
  }
  await shutdown()
}

const claudeBin = tedEnv('TED_CLAUDE_BIN')
const codexBin = tedEnv('TED_CODEX_BIN')
const antigravityBin = tedEnv('TED_ANTIGRAVITY_BIN')
const piBin = tedEnv('TED_PI_BIN')
const ghBin = tedEnv('TED_GH_BIN')
const fixLog = tedEnv('TED_FIX_LOG')

try {
  starting = startDaemon({
    home: tedHome(),
    version: tedVersion,
    ...(edition === 'dev' &&
      tedEnv('TED_DEMO') === '1' && {
        mergePollMs: 500,
        simulators: { supported: true },
      }),
    onShutdown: () => void shutdown(),
    stallProfiles: {},
    checkAgentsOnStart: true,
    ...(appToken !== undefined && { appToken }),
    ...(tedEnv('TED_STAY_AWAKE') !== 'off' && {
      holdAwake: holdAwakeWithOs(),
      holdOnPower: holdOnPowerWithOs(),
    }),
    ...(claudeBin && { claudeBin }),
    ...(codexBin && { codexBin }),
    ...(antigravityBin && { antigravityBin }),
    ...(piBin && { piBin }),
    integrations: {
      checkOnStart: true,
      loginShell: tedEnv('TED_LOGIN_SHELL') !== 'off',
      ...(ghBin && { ghBin }),
      ...(fixLog && {
        openTerminal: (command: string) => appendFile(fixLog, `${command}\n`),
      }),
    },
    ...(asanaApi && {
      asana: {
        oauthOrigin: asanaApi,
        apiOrigin: asanaApi,
        ...(tedEnv('TED_ASANA_CALLBACK_PORT') && {
          callbackPort: Number(tedEnv('TED_ASANA_CALLBACK_PORT')),
        }),
      },
    }),
    ...(linearApi && { linear: { apiUrl: linearApi } }),
    ...(Number(tedEnv('TED_NUDGE_AFTER_MS')) > 0 && {
      nudgeAfterMs: Number(tedEnv('TED_NUDGE_AFTER_MS')),
    }),
    ...(Number(tedEnv('TED_STALL_AFTER_MS')) > 0 && {
      stallAfterMs: Number(tedEnv('TED_STALL_AFTER_MS')),
    }),
    ...(values['exit-when-idle'] && {
      idleExit: {
        afterMs: Number(tedEnv('TED_IDLE_EXIT_MS')) || 60_000,
        onIdle: shutdown,
        ...(edition === 'dev' && {
          unattended: {
            afterMs: Number(tedEnv('TED_UNATTENDED_EXIT_MS')) || 60 * 60_000,
            onExit: (stoppedRuns: number) => void leaveUnattended(stoppedRuns),
          },
        }),
      },
    }),
  })
  const daemon = await starting
  running = daemon
  console.log(`Ted daemon ${tedVersion} listening on 127.0.0.1:${daemon.port}`)
  if (tedEnv('TED_FORCE_ERROR')?.split(',').includes('daemon')) {
    setTimeout(() => {
      throw new Error(`Forced error in the daemon (TED_FORCE_ERROR) in ${tedHome()}`)
    })
  }
} catch (error) {
  await demoLinear?.close()
  if (error instanceof DaemonAlreadyRunningError) {
    console.error(error.message)
    process.exit(daemonAlreadyRunningExitCode)
  }
  if (error instanceof QuitMarkedError) {
    console.error(error.message)
    process.exit(tedQuitExitCode)
  }
  throw error
}

function stopOnSignal(signal: NodeJS.Signals): void {
  if (stopping) {
    console.log(
      `${signal} again while stopping: Ted’s daemon is exiting without finishing the stop`,
    )
    process.exit(1)
  }
  void shutdown()
}

watchExitWith(() => void shutdown())
process.on('SIGTERM', stopOnSignal)
process.on('SIGINT', stopOnSignal)
