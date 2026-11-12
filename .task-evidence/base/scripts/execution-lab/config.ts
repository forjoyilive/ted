import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export interface LabHost {
  role: 'controller' | 'executor'
  connection: 'local' | 'ssh'
  home: string
  root: string
  machineId: string
  node: string
  pnpm: string
  address?: string
  user?: string
  port?: number
}

export interface LabConfig {
  version: 1
  labId: string
  knownHosts: string
  identityFile: string
  reportDir: string
  hosts: [LabHost, LabHost]
}

export function absolute(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\/[a-zA-Z0-9_./ -]+$/.test(value) ||
    path.resolve(value) !== value ||
    value === '/'
  )
    throw new Error('expected a normalized absolute path')
  return value
}

export function parseConfig(value: unknown): LabConfig {
  const config = value as LabConfig
  if (config?.version !== 1 || !/^[a-z0-9-]{8,64}$/.test(config.labId))
    throw new Error('invalid lab configuration version or labId')
  for (const field of ['knownHosts', 'identityFile', 'reportDir'] as const) absolute(config[field])
  if (!Array.isArray(config.hosts) || config.hosts.length !== 2)
    throw new Error('configure exactly two hosts')
  const [controller, executor] = config.hosts
  if (
    controller.role !== 'controller' ||
    executor.role !== 'executor' ||
    controller.connection !== 'local' ||
    executor.connection !== 'ssh'
  )
    throw new Error('configure a local controller and SSH executor, in that order')
  for (const host of config.hosts) {
    for (const field of ['home', 'root', 'node', 'pnpm'] as const) absolute(host[field])
    if (!/^[A-F0-9-]{36}$/.test(host.machineId))
      throw new Error('expected pinned Mac platform UUID')
    if (host.root !== `${host.home}/ted-validation-lab`)
      throw new Error(
        'scratch root must be the dedicated ted-validation-lab child of the approved home',
      )
    if (
      host.connection === 'ssh' &&
      (!host.address ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host.address) ||
        !host.user ||
        !/^[a-z_][a-z0-9_-]*$/.test(host.user) ||
        !Number.isInteger(host.port) ||
        (host.port ?? 0) < 1 ||
        (host.port ?? 0) > 65535)
    )
      throw new Error('explicit SSH address, user and port required')
  }
  if (controller.machineId === executor.machineId) throw new Error('two distinct Macs required')
  for (const name of ['reportDir', 'knownHosts', 'identityFile'] as const) {
    if (
      config[name].includes('/.ted/') ||
      config[name].includes('/.ted-dev/') ||
      config.hosts.some(
        (host) => config[name] === host.root || config[name].startsWith(`${host.root}/`),
      )
    )
      throw new Error(
        'configuration and reports must be outside installations and personal TED homes',
      )
  }
  return config
}

export async function plainPath(target: string) {
  absolute(target)
  let cursor = '/'
  for (const part of target.slice(1).split('/')) {
    cursor = path.join(cursor, part)
    const entry = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (entry?.isSymbolicLink()) throw new Error(`symlink refused: ${cursor}`)
  }
}

export async function readConfig(file: string, checkout: string) {
  await plainPath(file)
  const actual = await realpath(file)
  const info = await lstat(actual)
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
    throw new Error('config must be a user-owned file not writable by others')
  if (actual.startsWith(`${await realpath(checkout)}/`))
    throw new Error('config must be outside checkout')
  const config = parseConfig(JSON.parse(await readFile(actual, 'utf8')))
  await plainPath(config.knownHosts)
  await plainPath(config.identityFile)
  const pinned = await lstat(config.knownHosts)
  const key = await lstat(config.identityFile)
  if (
    !pinned.isFile() ||
    pinned.uid !== process.getuid?.() ||
    (pinned.mode & 0o022) !== 0 ||
    !key.isFile() ||
    key.uid !== process.getuid?.() ||
    (key.mode & 0o077) !== 0
  )
    throw new Error(
      'SSH identity and pinned host file must be owned, regular files with safe permissions',
    )
  return config
}

export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function sshArgs(config: LabConfig, host: LabHost): string[] {
  if (host.connection !== 'ssh') throw new Error('not an SSH host')
  return [
    '-F',
    '/dev/null',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${config.knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'HostKeyAlgorithms=ssh-ed25519',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=3',
    '-i',
    config.identityFile,
    '-p',
    String(host.port),
    '--',
    `${host.user}@${host.address}`,
  ]
}
