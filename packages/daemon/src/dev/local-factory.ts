import { execFile } from 'node:child_process'
import { mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { DaemonClient, type Factory, readDaemonInfo, tedVersion } from '@ted/protocol'
import { gitEnv } from '../command-env.ts'
import { clearQuit, markQuit, quitMarked } from '../launch.ts'
import { checkTrialHome } from './home.ts'

const exec = promisify(execFile)
const safeName = /^[A-Za-z0-9_.-]+$/

export interface LocalFactoryResult {
  factory: Factory
  added: boolean
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', ...args],
    { cwd, env: gitEnv(process.env) },
  )
  return stdout.trim()
}

async function sourceRepo(
  folder: string,
): Promise<{ folder: string; name: string; branch: string }> {
  const given = path.resolve(folder)
  const found = await stat(given).catch(() => undefined)
  if (!found?.isDirectory()) throw new Error(`There’s no folder at ${given}.`)
  const real = await realpath(given)
  const top = await git(real, 'rev-parse', '--show-toplevel').catch(() => '')
  if (!top || (await realpath(top)) !== real)
    throw new Error(`${given} isn’t the top folder of a git repo.`)
  if (!(await git(real, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => '')))
    throw new Error(`${given} has no commits yet. Commit first: only committed work is copied.`)
  const branch = await git(real, 'symbolic-ref', '--short', 'HEAD').catch(() => '')
  if (!branch) throw new Error(`Check out a branch in ${given}; its HEAD is detached.`)
  const name = path.basename(real)
  if (!safeName.test(name) || name === '.' || name === '..')
    throw new Error(`Rename ${given}: a repo name uses only letters, digits, “.”, “_” and “-”.`)
  return { folder: real, name, branch }
}

async function copyCommits(source: { folder: string; branch: string }, origin: string) {
  const existing = await stat(origin).catch(() => undefined)
  if (!existing) {
    await mkdir(path.dirname(origin), { recursive: true })
    await git(path.dirname(origin), 'clone', '--bare', '--quiet', '--', source.folder, origin)
    return
  }
  if (!existing.isDirectory()) throw new Error(`${origin} isn’t a folder.`)
  await git(
    origin,
    'fetch',
    '--quiet',
    '--prune',
    '--force',
    '--',
    source.folder,
    '+refs/heads/*:refs/heads/*',
  )
  await git(origin, 'symbolic-ref', 'HEAD', `refs/heads/${source.branch}`)
}

export async function addLocalFactory(
  home: string,
  { folder, key }: { folder: string; key: string },
): Promise<LocalFactoryResult> {
  const resolvedHome = await checkTrialHome(home)
  const source = await sourceRepo(folder)
  const origin = path.join(resolvedHome, 'origins', 'local', `${source.name}.git`)
  const repo = `local/${source.name}`
  const wasQuit = await quitMarked(resolvedHome)
  const { startDaemon } = await import('../daemon.ts')
  const { DaemonAlreadyRunningError } = await import('../lock.ts')
  if (wasQuit) await clearQuit(resolvedHome)
  try {
    const daemon = await startDaemon({
      home: resolvedHome,
      version: tedVersion,
      checkAgentsOnStart: false,
      integrations: { checkOnStart: false, loginShell: false },
      disk: { excludeFromBackups: async () => undefined },
    }).catch((error: Error) => {
      if (error instanceof DaemonAlreadyRunningError)
        throw new Error(`Ted Dev is running for ${resolvedHome}. Quit it first, then try again.`)
      throw error
    })
    try {
      const info = await readDaemonInfo(resolvedHome)
      if (!info) throw new Error('The daemon didn’t publish its connection.')
      const client = new DaemonClient(info, '', { appKey: daemon.appToken })
      await copyCommits(source, origin)
      try {
        const known = (await client.listFactories()).find((factory) => factory.repo === repo)
        if (known) return { factory: known, added: false }
        const factory = await client.addFactory({ repo: `file://${origin}`, key })
        return { factory, added: true }
      } finally {
        await client.shutdown({ keepRuns: true })
      }
    } finally {
      await daemon.stop()
    }
  } finally {
    if (wasQuit) await markQuit(resolvedHome)
  }
}
