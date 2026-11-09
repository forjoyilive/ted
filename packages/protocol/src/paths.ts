import { homedir } from 'node:os'
import path from 'node:path'

export function tedHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TED_HOME || path.join(homedir(), '.ted')
}

export function tedPaths(home: string) {
  return {
    home,
    store: path.join(home, 'store'),
    logs: path.join(home, 'logs'),
    daemonLog: path.join(home, 'logs', 'daemon.log'),
    daemonOutput: path.join(home, 'logs', 'daemon-output.log'),
    daemonInfo: path.join(home, 'daemon.json'),
    daemonLock: path.join(home, 'daemon-lock.db'),
    runTokenKey: path.join(home, 'run-token.key'),
    repos: path.join(home, 'repos'),
    worktrees: path.join(home, 'worktrees'),
    library: path.join(home, 'library'),
    backups: path.join(home, 'backups'),
    attachments: path.join(home, 'attachments'),
    tmp: path.join(home, 'tmp'),
    runs: path.join(home, 'runs'),
    simulators: path.join(home, 'simulators'),
    scratch: path.join(home, 'scratch'),
    secrets: path.join(home, 'secrets'),
    linearKeyFile: path.join(home, 'secrets', 'linear-api-key'),
  }
}
