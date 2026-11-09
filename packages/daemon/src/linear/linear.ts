import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type LinearIssue,
  type LinearKeyPlace,
  type LinearLookup,
  type LinearStatus,
  type LinearUrl,
  type Priority,
  parseLinearUrl,
  type SaveLinearKeyRequest,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { type Keyring, KeyringUnavailableError } from './keyring.ts'

export interface Linear {
  status(): Promise<LinearStatus>
  save(request: SaveLinearKeyRequest): Promise<LinearStatus>
  test(): Promise<LinearStatus>
  remove(): Promise<LinearStatus>
  lookup(url: string): Promise<LinearLookup>
  issueFor(url: LinearUrl): Promise<LinearLookup>
}

export interface LinearOptions {
  keyring: Keyring
  keyFile: string
  apiUrl?: string
  timeoutMs?: number
  cacheMs?: number
  now?: () => number
}

export const linearApiUrl = 'https://api.linear.app/graphql'

const linkOnly = 'The Task will be created with the link only.'
const validKey = /^[\x21-\x7e]{8,512}$/
const maxDescription = 20_000
const maxTitle = 500

const linearPriorities: Record<number, Priority> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
}

type ApiFailure = 'invalid-key' | 'not-found' | 'unreachable' | 'failed'

class LinearApiError extends Error {
  readonly kind: ApiFailure
  constructor(kind: ApiFailure, message: string) {
    super(message)
    this.kind = kind
  }
}

interface Viewer {
  user: string
  workspace: string
  urlKey: string
}

interface StoredKey {
  key: string
  place: LinearKeyPlace
}

type KeyRead = { stored: StoredKey } | { stored?: undefined; problem?: 'no-keyring' | 'locked' }

export function createLinear(options: LinearOptions): Linear {
  const { keyring, keyFile } = options
  const apiUrl = checkedApiUrl(options.apiUrl ?? linearApiUrl)
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? 10 * 60_000
  const checked = new Map<string, LinearStatus>()
  const viewers = new Map<string, Viewer>()
  const issues = new Map<string, { at: number; lookup: LinearLookup }>()

  async function read(): Promise<KeyRead> {
    let problem: 'no-keyring' | 'locked' | undefined
    try {
      const key = await keyring.get()
      if (key) return { stored: { key, place: 'keyring' } }
    } catch (error) {
      if (!(error instanceof KeyringUnavailableError)) throw error
      problem = error.reason
    }
    const fromFile = await readKeyFile(keyFile)
    if (fromFile) return { stored: { key: fromFile, place: 'file' } }
    return problem ? { problem } : {}
  }

  const base = (): Pick<LinearStatus, 'keyring'> => ({ keyring: keyring.kind })

  function described(stored: StoredKey): Pick<LinearStatus, 'keyring' | 'last4' | 'storedIn'> {
    return { ...base(), last4: stored.key.slice(-4), storedIn: stored.place }
  }

  async function check(stored: StoredKey): Promise<LinearStatus> {
    const known = described(stored)
    let status: LinearStatus
    try {
      const viewer = await whoIs(stored.key)
      viewers.set(stored.key, viewer)
      status = { ...known, state: 'connected', user: viewer.user, workspace: viewer.workspace }
    } catch (error) {
      status = failedStatus(known, error)
    }
    checked.set(stored.key, status)
    return status
  }

  async function status(): Promise<LinearStatus> {
    const found = await read()
    if (!found.stored) return found.problem ? { ...base(), state: found.problem } : noKey()
    return checked.get(found.stored.key) ?? (await check(found.stored))
  }

  function noKey(): LinearStatus {
    return { ...base(), state: 'no-key' }
  }

  async function whoIs(key: string): Promise<Viewer> {
    const data = await query<{
      viewer?: { name?: string; displayName?: string }
      organization?: { name?: string; urlKey?: string }
    }>(key, 'query TedViewer { viewer { name displayName } organization { name urlKey } }')
    const user = data.viewer?.name || data.viewer?.displayName || ''
    const workspace = data.organization?.name ?? ''
    const urlKey = (data.organization?.urlKey ?? '').toLowerCase()
    return { user, workspace, urlKey }
  }

  async function query<T>(key: string, text: string, variables?: object): Promise<T> {
    let response: Response
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: { authorization: key, 'content-type': 'application/json' },
        body: JSON.stringify({ query: text, ...(variables && { variables }) }),
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
    } catch (error) {
      throw new LinearApiError('unreachable', `Couldn’t reach Linear (${reasonOf(error)})`)
    }
    const body = (await response.json().catch(() => undefined)) as
      | {
          data?: T | null
          errors?: { message?: string; extensions?: { code?: string; type?: string } }[]
        }
      | undefined
    const errors = body?.errors ?? []
    const auth = errors.some(
      (e) =>
        e.extensions?.code === 'AUTHENTICATION_ERROR' ||
        e.extensions?.type === 'authentication error',
    )
    if (auth || response.status === 401 || response.status === 403) {
      throw new LinearApiError('invalid-key', 'Linear didn’t accept the API key')
    }
    if (errors.some((e) => /not found/i.test(e.message ?? ''))) {
      throw new LinearApiError('not-found', 'not found')
    }
    if (!response.ok || !body?.data) {
      const said = errors[0]?.message
      throw new LinearApiError(
        'failed',
        said
          ? `Linear said “${oneLine(said).slice(0, 200)}”`
          : `Linear answered ${response.status}`,
      )
    }
    return body.data
  }

  async function fetchIssue(key: string, link: LinearUrl): Promise<LinearLookup> {
    try {
      const viewer = viewers.get(key) ?? (await whoIs(key))
      viewers.set(key, viewer)
      const { urlKey } = viewer
      if (urlKey !== '' && urlKey !== link.workspace) {
        return { state: 'failed', error: `This Linear key can’t read issues in ${link.workspace}` }
      }
      const data = await query<{
        issue?: {
          identifier?: string
          title?: string
          description?: string | null
          priority?: number
          branchName?: string | null
        } | null
      }>(
        key,
        'query TedIssue($id: String!) { issue(id: $id) { identifier title description priority branchName } }',
        { id: link.identifier },
      )
      const issue = data.issue
      if (!issue?.identifier || typeof issue.title !== 'string') {
        throw new LinearApiError('not-found', 'not found')
      }
      const found: LinearIssue = {
        url: link.url,
        identifier: issue.identifier,
        title: oneLine(issue.title).slice(0, maxTitle),
        priority: linearPriorities[issue.priority ?? 0] ?? 'none',
        ...(issue.branchName && { branchName: issue.branchName }),
        ...(issue.description && { description: issue.description.slice(0, maxDescription) }),
      }
      return { state: 'found', issue: found }
    } catch (error) {
      if (!(error instanceof LinearApiError)) throw error
      if (error.kind === 'invalid-key') {
        const stored = await read()
        viewers.delete(key)
        if (stored.stored?.key === key) {
          checked.set(key, failedStatus(described(stored.stored), error))
        }
      }
      return { state: 'failed', error: fetchError(error, link) }
    }
  }

  async function issueFor(link: LinearUrl): Promise<LinearLookup> {
    const cached = issues.get(link.url)
    if (cached && now() - cached.at < cacheMs) return cached.lookup
    const found = await read()
    if (!found.stored) return { state: 'no-key' }
    const lookup = await fetchIssue(found.stored.key, link)
    if (lookup.state === 'found') issues.set(link.url, { at: now(), lookup })
    return lookup
  }

  return {
    status,

    async save({ key: given, inFile = false }) {
      const key = given.trim()
      if (!validKey.test(key)) {
        throw new RequestError(400, 'A Linear API key is one word, like lin_api_…')
      }
      let viewer: Viewer | undefined
      let unreachable: unknown
      try {
        viewer = await whoIs(key)
      } catch (error) {
        if (error instanceof LinearApiError && error.kind === 'invalid-key') {
          throw new RequestError(400, 'Linear didn’t accept this key. Check it and try again.')
        }
        unreachable = error
      }
      let place: LinearKeyPlace
      if (inFile) {
        const usable = await keyring.get().then(
          () => true,
          (error: unknown) => !(error instanceof KeyringUnavailableError),
        )
        if (usable) {
          throw new RequestError(409, 'This computer has a keyring, so TED keeps the key there.')
        }
        await writeKeyFile(keyFile, key)
        place = 'file'
      } else {
        try {
          await keyring.set(key)
        } catch (error) {
          if (error instanceof KeyringUnavailableError) return { ...base(), state: error.reason }
          throw error
        }
        await rm(keyFile, { force: true })
        place = 'keyring'
      }
      issues.clear()
      const known = described({ key, place })
      const next: LinearStatus = viewer
        ? { ...known, state: 'connected', user: viewer.user, workspace: viewer.workspace }
        : failedStatus(known, unreachable)
      checked.clear()
      viewers.clear()
      checked.set(key, next)
      if (viewer) viewers.set(key, viewer)
      return next
    },

    async test() {
      const found = await read()
      if (!found.stored) return found.problem ? { ...base(), state: found.problem } : noKey()
      issues.clear()
      viewers.delete(found.stored.key)
      return check(found.stored)
    },

    async remove() {
      let problem: 'no-keyring' | 'locked' | undefined
      try {
        await keyring.delete()
      } catch (error) {
        if (!(error instanceof KeyringUnavailableError)) throw error
        if (error.reason === 'locked') {
          throw new RequestError(409, 'Keyring is locked. Unlock it, then remove the key.')
        }
        problem = error.reason
      }
      await rm(keyFile, { force: true })
      checked.clear()
      viewers.clear()
      issues.clear()
      return problem ? { ...base(), state: problem } : noKey()
    },

    async lookup(url) {
      const link = parseLinearUrl(url)
      if (!link) throw new RequestError(400, 'That isn’t a Linear issue URL')
      return issueFor(link)
    },

    issueFor,
  }
}

function failedStatus(known: Pick<LinearStatus, 'keyring'>, error: unknown): LinearStatus {
  if (error instanceof LinearApiError && error.kind === 'invalid-key') {
    return { ...known, state: 'invalid', error: 'Linear didn’t accept this key' }
  }
  if (error instanceof LinearApiError && error.kind === 'unreachable') {
    return { ...known, state: 'unreachable', error: error.message }
  }
  return {
    ...known,
    state: 'unreachable',
    error: `Couldn’t check the key with Linear: ${error instanceof Error ? error.message : String(error)}`,
  }
}

function fetchError(error: LinearApiError, link: LinearUrl): string {
  const reason =
    error.kind === 'invalid-key'
      ? 'Linear didn’t accept the API key'
      : error.kind === 'not-found'
        ? `${link.identifier} doesn’t exist or this key can’t see it`
        : error.kind === 'unreachable'
          ? lowerFirst(error.message)
          : error.message
  return `Couldn’t fetch from Linear: ${reason}. ${linkOnly}`
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function reasonOf(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause
  if (typeof cause?.code === 'string') return cause.code
  if (error instanceof Error && error.name === 'TimeoutError') return 'timed out'
  return redactSecrets(error instanceof Error ? error.message : String(error))
}

function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\s]+/gu, ' ').trim()
}

function checkedApiUrl(url: string): string {
  const parsed = new URL(url)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('the Linear API URL must be https, or http on this computer')
  }
  return parsed.href
}

async function readKeyFile(file: string): Promise<string | undefined> {
  const info = await lstat(file).catch(() => undefined)
  if (!info?.isFile()) return undefined
  const key = (await readFile(file, 'utf8')).trim()
  return key === '' ? undefined : key
}

async function writeKeyFile(file: string, key: string): Promise<void> {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const tmp = `${file}.${process.pid}.tmp`
  await rm(tmp, { force: true })
  await writeFile(tmp, `${key}\n`, { mode: 0o600, flag: 'wx' })
  await rename(tmp, file)
}
