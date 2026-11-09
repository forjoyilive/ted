import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readDaemonInfo } from '@ted/protocol'
import { appDir } from './stage.ts'

const release = path.join(appDir, 'dist', 'release')

function builtTed(): string {
  const given = process.argv[2]
  if (given !== undefined) return path.resolve(given)
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') {
    const app = path.join(release, arch === 'arm64' ? 'mac-arm64' : 'mac', 'TED.app')
    return path.join(app, 'Contents', 'Resources', 'bin', 'ted')
  }
  const dir = path.join(release, arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked')
  return path.join(dir, 'resources', 'bin', 'ted')
}

function printLogs(home: string): void {
  const logs = path.join(home, 'logs')
  if (!existsSync(logs)) return
  for (const name of readdirSync(logs)) {
    console.error(`\n-- ${name}`)
    console.error(readFileSync(path.join(logs, name), 'utf8').slice(-4000))
  }
}

async function stopDaemon(home: string): Promise<void> {
  const info = await readDaemonInfo(home)
  if (info === undefined) return
  const alive = () => {
    try {
      process.kill(info.pid, 0)
      return true
    } catch {
      return false
    }
  }
  if (!alive()) return
  process.kill(info.pid, 'SIGTERM')
  for (let waited = 0; waited < 10_000 && alive(); waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function main(): Promise<number> {
  const ted = builtTed()
  if (!existsSync(ted)) {
    console.error(`smoke: no packaged ted at ${ted}; run pnpm package --dir first`)
    return 1
  }
  const home = mkdtempSync(path.join(os.tmpdir(), 'ted-smoke-'))
  try {
    console.log(`smoke: ${ted} task list (TED_HOME=${home})`)
    const result = spawnSync(ted, ['task', 'list'], {
      env: {
        ...process.env,
        TED_HOME: home,
        TED_IDLE_EXIT_MS: '3000',
        TED_LOGIN_SHELL: 'off',
        TED_EXIT_WITH_PID: String(process.pid),
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.status === 0) {
      console.log('smoke: the packaged daemon answered')
      return 0
    }
    console.error(
      `smoke: the packaged ted failed (${result.error?.message ?? `exit ${result.status}`})`,
    )
    printLogs(home)
    return 1
  } finally {
    await stopDaemon(home)
    rmSync(home, { recursive: true, force: true })
  }
}

process.exitCode = await main()
