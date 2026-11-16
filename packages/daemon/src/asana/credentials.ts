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
    scopes?: string[]
    user: NonNullable<AsanaStatus['user']>
  }
}

type Removed = { version: 1; removed: true; cleanupPending: boolean }
type StoredFile = Credentials | Removed

export class CredentialCleanupError extends Error {
  readonly reason: 'locked' | 'no-keyring' | undefined
  constructor(cause: unknown) {
    super('Asana keyring cleanup is pending')
    this.reason = cause instanceof KeyringUnavailableError ? cause.reason : undefined
  }
}

export type CommitFile = (temporary: string, file: string) => Promise<void>

export function credentialStore(home: string, keyring: Keyring, commitFile: CommitFile = rename) {
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
      return decodeFile(await handle.readFile('utf8'))
    } finally {
      await handle.close()
    }
  }
  async function writeFile(record: StoredFile) {
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
      await commitFile(temporary, file)
      const folder = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await folder.sync()
      } finally {
        await folder.close()
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
  return {
    async read(): Promise<{ record?: Credentials; place?: 'file' | 'keyring' }> {
      const stored = await readFile()
      if (stored && 'removed' in stored) {
        if (stored.cleanupPending) {
          try {
            await keyring.delete()
            await writeFile({ version: 1, removed: true, cleanupPending: false })
          } catch (error) {
            throw new CredentialCleanupError(error)
          }
        }
        return {}
      }
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
          await keyring.get()
        } catch (error) {
          if (!(error instanceof KeyringUnavailableError) || error.reason !== 'no-keyring')
            throw error
        }
        const previous = await readFile()
        try {
          await writeFile(record)
        } catch (error) {
          if (previous) await writeFile(previous)
          else await rm(file, { force: true })
          throw error
        }
        try {
          await keyring.delete()
        } catch (error) {
          if (error instanceof KeyringUnavailableError && error.reason === 'no-keyring') return
          if (previous) await writeFile(previous)
          else await rm(file, { force: true })
          throw error
        }
      }
    },
    async remove() {
      await writeFile({ version: 1, removed: true, cleanupPending: true })
      try {
        await keyring.delete()
      } catch {
        return
      }
      await writeFile({ version: 1, removed: true, cleanupPending: false })
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
        (value.tokens.scopes !== undefined &&
          (!Array.isArray(value.tokens.scopes) ||
            value.tokens.scopes.length > 100 ||
            value.tokens.scopes.some((scope) => typeof scope !== 'string'))) ||
        typeof value.tokens.user?.gid !== 'string' ||
        typeof value.tokens.user?.name !== 'string' ||
        typeof value.tokens.user?.email !== 'string'))
  )
    throw new Error('Invalid stored Asana credentials')
  return value
}

function decodeFile(text: string): StoredFile {
  const value = JSON.parse(text) as Partial<Removed> | null
  if (value?.removed === true) {
    if (value.version !== 1 || typeof value.cleanupPending !== 'boolean')
      throw new Error('Invalid removed credential record')
    return { version: 1, removed: true, cleanupPending: value.cleanupPending }
  }
  return decode(text)
}
