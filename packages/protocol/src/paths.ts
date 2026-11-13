import { homedir } from 'node:os'
import path from 'node:path'
import { type Edition, edition, identity } from './edition.ts'
import { tedEnv } from './env.ts'

export function tedHome(env: NodeJS.ProcessEnv = process.env, which: Edition = edition): string {
  return tedEnv('TED_HOME', env, which) || path.join(homedir(), identity(which).homeFolder)
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
    quitMark: path.join(home, 'quit-mark'),
    runTokenKey: path.join(home, 'run-token.key'),
    repos: path.join(home, 'repos'),
    worktrees: path.join(home, 'worktrees'),
    library: path.join(home, 'library'),
    backups: path.join(home, 'backups'),
    attachments: path.join(home, 'attachments'),
    tmp: path.join(home, 'tmp'),
    runs: path.join(home, 'runs'),
    apps: path.join(home, 'apps'),
    simulators: path.join(home, 'simulators'),
    scratch: path.join(home, 'scratch'),
    plans: path.join(home, 'plans'),
    secrets: path.join(home, 'secrets'),
    linearKeyFile: path.join(home, 'secrets', 'linear-api-key'),
  }
}
