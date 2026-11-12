import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { type AsanaStatus, parseAsanaConfiguration } from '@ted/protocol'
import { type Keyring, KeyringUnavailableError } from '../linear/keyring.ts'

export interface Credentials {
  version: 1
  clientId: string
  clientSecret: string
  tokens?: {
    access: string
    refresh: string
    expires: number
    user: NonNullable<AsanaStatus['user']>
  }
}

export function credentialStore(home: string, keyring: Keyring) {
  const directory = path.join(home, 'asana-credentials')
  const file = path.join(directory, 'oauth.json')
  async function safeDirectory(create = false) {
    if (create)
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!info) return false
    if (
      !info.isDirectory() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) ||
      (await realpath(directory)) !== path.join(await realpath(home), 'asana-credentials')
    ) {
      throw new Error('Unsafe Asana credential folder')
    }
    return true
  }
  async function readFile() {
    if (!(await safeDirectory())) return undefined
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      },
    )
    if (!handle) return undefined
    try {
      const info = await handle.stat()
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 32_768 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error('Unsafe Asana credential file')
      return decode(await handle.readFile('utf8'))
    } finally {
      await handle.close()
    }
  }
  return {
    async read(): Promise<{ record?: Credentials; place?: 'file' | 'keyring' }> {
      const stored = await readFile()
      if (stored) return { record: stored, place: 'file' }
      const secret = await keyring.get()
      return secret ? { record: decode(secret), place: 'keyring' } : {}
    },
    async write(record: Credentials, place: 'file' | 'keyring') {
      if (place === 'keyring') {
        await keyring.set(JSON.stringify(record))
        if (await safeDirectory()) await rm(file, { force: true })
      } else {
        try {
          await keyring.delete()
        } catch (error) {
          if (!(error instanceof KeyringUnavailableError) || error.reason !== 'no-keyring')
            throw error
        }
        await safeDirectory(true)
        const temporary = path.join(directory, `${randomUUID()}.tmp`)
        try {
          const handle = await open(temporary, 'wx', 0o600)
          try {
            await handle.writeFile(JSON.stringify(record))
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temporary, file)
        } finally {
          await rm(temporary, { force: true })
        }
      }
    },
    async remove(place: 'file' | 'keyring') {
      if (place === 'keyring') await keyring.delete()
      if (await safeDirectory()) await rm(file, { force: true })
    },
  }
}

function decode(text: string): Credentials {
  const value = JSON.parse(text) as Credentials
  parseAsanaConfiguration(value)
  if (
    value.version !== 1 ||
    (value.tokens &&
      (typeof value.tokens.access !== 'string' ||
        !value.tokens.access ||
        typeof value.tokens.refresh !== 'string' ||
        !value.tokens.refresh ||
        !Number.isFinite(value.tokens.expires) ||
        typeof value.tokens.user?.gid !== 'string' ||
        typeof value.tokens.user?.name !== 'string' ||
        typeof value.tokens.user?.email !== 'string'))
  )
    throw new Error('Invalid stored Asana credentials')
  return value
}
