import { parseArgs } from 'node:util'
import { tedHome, tedVersion } from '@ted/protocol'
import { DaemonAlreadyRunningError, type RunningDaemon, startDaemon } from './index.ts'
import { closeInheritedFds } from './inherited-fds.ts'

closeInheritedFds()

const { values } = parseArgs({ options: { 'exit-when-idle': { type: 'boolean' } } })

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
    ...(process.env.TED_CLAUDE_BIN && { claudeBin: process.env.TED_CLAUDE_BIN }),
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
