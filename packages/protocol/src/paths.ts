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
    public: path.join(home, 'public'),
    publicDaemonInfo: path.join(home, 'public', 'daemon.json'),
    daemonLock: path.join(home, 'daemon-lock.db'),
    quitMark: path.join(home, 'quit-mark'),
    runTokenKey: path.join(home, 'run-token.key'),
    repos: path.join(home, 'repos'),
    worktrees: path.join(home, 'worktrees'),
    sandbox: path.join(home, 'sandbox'),
    library: path.join(home, 'library'),
    backups: path.join(home, 'backups'),
    attachments: path.join(home, 'attachments'),
    phoneUploads: path.join(home, 'phone-uploads'),
    tmp: path.join(home, 'tmp'),
    phoneImages: path.join(home, 'cache', 'phone-images'),
    runs: path.join(home, 'runs'),
    apps: path.join(home, 'apps'),
    simulators: path.join(home, 'simulators'),
    emulators: path.join(home, 'emulators'),
    scratch: path.join(home, 'scratch'),
    seeds: path.join(home, 'seeds'),
    plans: path.join(home, 'plans'),
    chatCode: path.join(home, 'chat-code'),
    automationRuns: path.join(home, 'automation-runs'),
    secrets: path.join(home, 'secrets'),
    linearKeyFile: path.join(home, 'secrets', 'linear-api-key'),
  }
}
