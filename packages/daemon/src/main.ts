import { mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { tedHome, tedPaths, tedVersion } from '@ted/protocol'
import { DaemonAlreadyRunningError, type RunningDaemon, startDaemon } from './index.ts'
import { closeInheritedFds } from './inherited-fds.ts'
import { logConsoleTo, openRollingLog, tedLogLimits } from './logs.ts'
import { holdAwakeWithOs } from './stay-awake.ts'

closeInheritedFds()
delete process.env.ELECTRON_RUN_AS_NODE

const paths = tedPaths(tedHome())
mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
logConsoleTo(openRollingLog(paths.daemonLog, tedLogLimits))

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { 'exit-when-idle': { type: 'boolean' } },
})

let daemon: RunningDaemon | undefined
let stopping = false

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  await daemon?.stop()
  process.exit(0)
}

try {
  daemon = await startDaemon({
    home: tedHome(),
    version: tedVersion,
    onShutdown: () => void shutdown(),
    checkAgentsOnStart: true,
    ...(process.env.TED_STAY_AWAKE !== 'off' && { holdAwake: holdAwakeWithOs() }),
    ...(process.env.TED_CLAUDE_BIN && { claudeBin: process.env.TED_CLAUDE_BIN }),
    ...(process.env.TED_CODEX_BIN && { codexBin: process.env.TED_CODEX_BIN }),
    integrations: {
      checkOnStart: true,
      loginShell: process.env.TED_LOGIN_SHELL !== 'off',
      ...(process.env.TED_GH_BIN && { ghBin: process.env.TED_GH_BIN }),
      ...(process.env.TED_FIX_LOG && {
        openTerminal: (command: string) =>
          appendFile(process.env.TED_FIX_LOG as string, `${command}\n`),
      }),
    },
    ...(process.env.TED_LINEAR_API && { linear: { apiUrl: process.env.TED_LINEAR_API } }),
    ...(values['exit-when-idle'] && {
      idleExit: { afterMs: Number(process.env.TED_IDLE_EXIT_MS) || 60_000, onIdle: shutdown },
    }),
  })
  console.log(`TED daemon ${tedVersion} listening on 127.0.0.1:${daemon.port}`)
} catch (error) {
  if (error instanceof DaemonAlreadyRunningError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
