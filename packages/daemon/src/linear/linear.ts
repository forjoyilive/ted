import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  isLinearTeamKey,
  type LinearIntakeChoices,
  type LinearIntakeScope,
  type LinearIssue,
  type LinearKeyPlace,
  type LinearLookup,
  type LinearStatus,
  type LinearTeam,
  type LinearUrl,
  linearIntakeStateTypes,
  type Priority,
  parseLinearUrl,
  type SaveLinearKeyRequest,
} from '@ted/protocol'
import {
  isArray,
  isBoolean,
  isObject,
  isString,
  type Json,
  type JsonObject,
} from '@ted/protocol/parse'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { fetchDiscussion } from './discussion.ts'
import {
  fetchLinearFiles,
  type LinearFileStore,
  type LinearIssueAttachment,
  linearUploadsOrigin,
} from './files.ts'
import { type Keyring, KeyringUnavailableError } from './keyring.ts'

export interface Linear {
  intakeChoices(options?: { fresh?: boolean }): Promise<LinearIntakeChoices>
  intakeMembership(link: LinearUrl): Promise<LinearIntakeMembership>
  intakeIssues(scope: LinearIntakeScope): Promise<LinearIntakeList>
  status(): Promise<LinearStatus>
  save(request: SaveLinearKeyRequest): Promise<LinearStatus>
  test(): Promise<LinearStatus>
  remove(): Promise<LinearStatus>
  lookup(url: string): Promise<LinearLookup>
  issueFor(url: LinearUrl): Promise<LinearLookup>
  issueStates(links: readonly LinearUrl[]): Promise<Map<string, LinearIssueState> | undefined>
  teamStates(teamId: string): Promise<LinearWorkflowState[]>
  moveIssue(issueId: string, stateId: string): Promise<void>
  linkUrl(issueId: string, url: string, title: string): Promise<void>
}

export interface LinearIntakeMembership {
  workspaceId: string
  workspace: string
  teamId: string
  projectId: string | null
}

export interface LinearIntakeList {
  workspaceId: string
  workspace: string
  issues: { identifier: string; title: string; url: string }[]
  incomplete?: string
}

export const maxLinearIntakeListed = 1000

export interface LinearWorkflowState {
  id: string
  name: string
  type: string
  position: number
}

export interface LinearIssueState {
  id: string
  identifier: string
  teamId: string
  teamKey: string
  state: LinearWorkflowState
}

export interface LinearOptions {
  keyring: Keyring
  keyFile: string
  apiUrl?: string
  timeoutMs?: number
  cacheMs?: number
  now?: () => number
  files?: LinearFileStore
}

export const linearApiUrl = 'https://api.linear.app/graphql'

const linkOnly = 'The Task will be created with the link only.'
const validKey = /^[\x21-\x7e]{8,512}$/
const maxDescription = 20_000
const maxTitle = 500
const issuesPerQuery = 50
const issueStateFields = 'id identifier state { id name type position } team { id key }'

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
  const fileOrigins = new Set([linearUploadsOrigin, new URL(apiUrl).origin])
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? 10 * 60_000
  const checked = new Map<string, LinearStatus>()
  const viewers = new Map<string, Viewer>()
  const issues = new Map<string, { at: number; lookup: LinearLookup }>()
  const teams = new Map<string, { at: number; states: LinearWorkflowState[] }>()
  let syncKey: { at: number; key: string | undefined } | undefined
  let choices: { key: string; at: number; read: Promise<LinearIntakeChoices> } | undefined

  async function intakeRead<T>(work: (key: string) => Promise<T>): Promise<T> {
    try {
      return await work(await requireKey())
    } catch (error) {
      throw new RequestError(
        409,
        redactSecrets(
          `Couldn’t verify Linear intake scope: ${reasonOf(error)}. Check Linear in App Settings → Integrations and try again.`,
        ),
      )
    }
  }

  async function intakeChoices({ fresh = false } = {}): Promise<LinearIntakeChoices> {
    return intakeRead(async (key) => {
      const cached = choices
      if (!fresh && cached && cached.key === key && now() - cached.at < cacheMs) return cached.read
      const read = readIntakeChoices(key)
      const entry = { key, at: now(), read }
      choices = entry
      read.catch(() => {
        if (choices === entry) choices = undefined
      })
      return read
    })
  }

  async function readIntakeChoices(key: string): Promise<LinearIntakeChoices> {
    const data = await query<{ organization: { id: string; urlKey: string } }>(
      key,
      'query TedIntakeWorkspace { organization { id urlKey } }',
      undefined,
      { strict: true },
    )
    if (!data.organization?.id || !data.organization.urlKey)
      throw new Error('Linear workspace is missing')
    async function pages(collection: 'teams' | 'projects') {
      const nodes: { id: string; name: string; key: string }[] = []
      let after: string | undefined
      const cursors = new Set<string>()
      for (let page = 0; page < 200; page++) {
        const result = await query<{
          targets: {
            nodes: { id: string; name: string; key: string }[]
            pageInfo: { hasNextPage: boolean; endCursor: string | null }
          }
        }>(
          key,
          `query TedIntakeChoices($after: String) { targets: ${collection}(first: 100, after: $after) { nodes { id name ${collection === 'teams' ? 'key' : ''} } pageInfo { hasNextPage endCursor } } }`,
          { after: after ?? null },
          { strict: true },
        )
        const connection = result.targets
        if (
          !Array.isArray(connection?.nodes) ||
          typeof connection.pageInfo?.hasNextPage !== 'boolean' ||
          connection.nodes.some(
            (node) => !node.id || !node.name || (collection === 'teams' && !node.key),
          )
        ) {
          throw new Error('Linear returned incomplete choices')
        }
        nodes.push(...connection.nodes)
        if (!connection.pageInfo.hasNextPage)
          return nodes.sort((a, b) => a.name.localeCompare(b.name))
        const cursor = connection.pageInfo.endCursor
        if (!cursor || cursors.has(cursor)) throw new Error('Linear returned an incomplete page')
        cursors.add(cursor)
        after = cursor
      }
      throw new Error('Linear returned too many pages')
    }
    const [teams, projects] = await Promise.all([pages('teams'), pages('projects')])
    return {
      workspaceId: data.organization.id,
      workspace: data.organization.urlKey.toLowerCase(),
      teams,
      projects,
    }
  }

  async function intakeMembership(link: LinearUrl): Promise<LinearIntakeMembership> {
    return intakeRead(async (key) => {
      const data = await query<{
        organization: { id: string; urlKey: string }
        issue: { identifier: string; team: { id: string }; project: { id: string } | null } | null
      }>(
        key,
        'query TedIntakeMembership($id: String!) { organization { id urlKey } issue(id: $id) { identifier team { id } project { id } } }',
        { id: link.identifier },
        { strict: true },
      )
      if (
        !data.organization?.id ||
        !data.organization.urlKey ||
        !data.issue?.team?.id ||
        data.issue.identifier !== link.identifier ||
        data.issue.project === undefined ||
        (data.issue.project !== null && !data.issue.project.id)
      )
        throw new Error('Linear returned incomplete issue scope')
      return {
        workspaceId: data.organization.id,
        workspace: data.organization.urlKey.toLowerCase(),
        teamId: data.issue.team.id,
        projectId: data.issue.project?.id ?? null,
      }
    })
  }

  async function intakeIssues(scope: LinearIntakeScope): Promise<LinearIntakeList> {
    if (!(await keyForSync()))
      throw new RequestError(
        409,
        'Linear isn’t connected. Connect it in App Settings → Integrations first.',
      )
    return intakeRead(async (key) => {
      const filter = {
        assignee: { isMe: { eq: true } },
        state: { type: { in: [...linearIntakeStateTypes] } },
        [scope.kind]: { id: { eq: scope.id } },
      }
      const issues: LinearIntakeList['issues'] = []
      const seen = new Set<string>()
      const cursors = new Set<string>()
      let workspace: { id: string; urlKey: string } | undefined
      let after: string | null = null
      let listed = 0
      let cut = false
      for (;;) {
        const data: Json = await query<Json>(
          key,
          'query TedIntakeIssues($filter: IssueFilter, $after: String) { organization { id urlKey } issues(first: 50, after: $after, filter: $filter) { nodes { identifier title } pageInfo { hasNextPage endCursor } } }',
          { filter, after },
          { strict: true },
        )
        const organization = isObject(data) ? data.organization : undefined
        const connection: Json | undefined = isObject(data) ? data.issues : undefined
        const pageInfo: Json | undefined = isObject(connection) ? connection.pageInfo : undefined
        const nodes = isObject(connection) ? connection.nodes : undefined
        if (
          !isObject(organization) ||
          !isString(organization.id) ||
          !isString(organization.urlKey) ||
          organization.urlKey === '' ||
          !isArray(nodes) ||
          !isObject(pageInfo) ||
          !isBoolean(pageInfo.hasNextPage)
        )
          throw new Error('Linear returned an incomplete issue list')
        const page = { id: organization.id, urlKey: organization.urlKey.toLowerCase() }
        if (workspace && (workspace.id !== page.id || workspace.urlKey !== page.urlKey))
          throw new Error('Linear changed workspace while TED read the issue list')
        workspace = page
        for (const node of nodes) {
          if (listed >= maxLinearIntakeListed) {
            cut = true
            break
          }
          listed++
          if (!isObject(node) || !isString(node.identifier) || !isString(node.title))
            throw new Error('Linear returned an incomplete issue')
          const link = parseLinearUrl(`https://linear.app/${page.urlKey}/issue/${node.identifier}`)
          if (!link) throw new Error('Linear returned an issue TED can’t link to')
          if (seen.has(link.identifier)) continue
          seen.add(link.identifier)
          issues.push({
            identifier: link.identifier,
            title: oneLine(node.title).slice(0, maxTitle) || link.identifier,
            url: link.url,
          })
        }
        const result = { workspaceId: page.id, workspace: page.urlKey, issues }
        if (!pageInfo.hasNextPage && !cut) return result
        if (listed >= maxLinearIntakeListed)
          return {
            ...result,
            incomplete: `TED read the first ${maxLinearIntakeListed} issues; the rest wait for the next run.`,
          }
        const cursor: Json | undefined = pageInfo.endCursor
        if (!isString(cursor) || cursor === '' || cursors.has(cursor))
          throw new Error('Linear returned an incomplete page')
        cursors.add(cursor)
        after = cursor
      }
    })
  }

  async function keyForSync(): Promise<string | undefined> {
    if (syncKey && now() - syncKey.at < cacheMs) return syncKey.key
    const found = await read().catch((): KeyRead => ({}))
    syncKey = { at: now(), key: found.stored?.key }
    return syncKey.key
  }

  function forgetKey(): void {
    syncKey = undefined
    choices = undefined
    teams.clear()
  }

  async function requireKey(): Promise<string> {
    const key = await keyForSync()
    if (!key) throw new LinearApiError('invalid-key', 'No Linear API key')
    return key
  }

  async function viewerOf(key: string): Promise<Viewer> {
    const viewer = viewers.get(key) ?? (await whoIs(key))
    viewers.set(key, viewer)
    return viewer
  }

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

  async function query<T>(
    key: string,
    text: string,
    variables?: JsonObject,
    { partial = false, strict = false }: { partial?: boolean; strict?: boolean } = {},
  ): Promise<T> {
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
      if (key === syncKey?.key) forgetKey()
      throw new LinearApiError('invalid-key', 'Linear didn’t accept the API key')
    }
    if (partial && response.ok && body?.data) return body.data
    if (errors.some((e) => /not found/i.test(e.message ?? ''))) {
      throw new LinearApiError('not-found', 'not found')
    }
    if (!response.ok || !body?.data || (strict && errors.length > 0)) {
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
      const { urlKey } = await viewerOf(key)
      if (urlKey !== '' && urlKey !== link.workspace) {
        return { state: 'failed', error: `This Linear key can’t read issues in ${link.workspace}` }
      }
      const data = await query<{
        issue?: {
          id?: string
          identifier?: string
          title?: string
          description?: string | null
          priority?: number
          branchName?: string | null
          team?: { key?: string; name?: string } | null
          attachments?: { nodes?: LinearIssueAttachment[] } | null
        } | null
      }>(
        key,
        'query TedIssue($id: String!) { issue(id: $id) { id identifier title description priority branchName team { key name } attachments(first: 50) { nodes { url title } } } }',
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
        ...teamOf(issue.team),
        ...(issue.description && { description: issue.description.slice(0, maxDescription) }),
      }
      const discussion = await fetchDiscussion(
        <T>(text: string, variables: JsonObject) =>
          query<T>(key, text, variables, { strict: true }),
        issue.id ?? link.identifier,
      )
      if (discussion.text) {
        found.description = [
          found.description ?? '(no description)',
          discussion.text,
          `Discussion source: ${link.url}`,
        ].join('\n\n')
      }
      if (discussion.warning) found.discussionWarning = discussion.warning
      if (options.files) {
        const { files, unfetched } = await fetchLinearFiles({
          key,
          origins: fileOrigins,
          description: found.description,
          attachments: issue.attachments?.nodes ?? [],
          store: options.files,
        })
        if (files.length > 0) found.files = files
        if (unfetched.length > 0) found.unfetched = unfetched
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

  async function issueStates(
    links: readonly LinearUrl[],
  ): Promise<Map<string, LinearIssueState> | undefined> {
    const key = await keyForSync()
    if (!key) return undefined
    const found = new Map<string, LinearIssueState>()
    const { urlKey } = await viewerOf(key)
    if (urlKey === '') return found
    const identifiers = [
      ...new Set(links.flatMap((l) => (l.workspace === urlKey ? [l.identifier] : []))),
    ]
    for (let from = 0; from < identifiers.length; from += issuesPerQuery) {
      const chunk = identifiers.slice(from, from + issuesPerQuery)
      const aliases = chunk.map((_, i) => `i${i}`)
      const params = aliases.map((a) => `$${a}: String!`).join(', ')
      const fields = aliases.map((a) => `${a}: issue(id: $${a}) { ${issueStateFields} }`)
      const data = await query<Record<string, unknown>>(
        key,
        `query TedIssueStates(${params}) { ${fields.join(' ')} }`,
        Object.fromEntries(chunk.map((identifier, i) => [`i${i}`, identifier])),
        { partial: true },
      )
      for (const alias of aliases) {
        const issue = issueStateFrom(data[alias])
        if (issue) found.set(linearIssueKey(urlKey, issue.identifier), issue)
      }
    }
    return found
  }

  async function teamStates(teamId: string): Promise<LinearWorkflowState[]> {
    const cached = teams.get(teamId)
    if (cached && now() - cached.at < cacheMs) return cached.states
    const data = await query<{ team?: { states?: { nodes?: unknown[] } } | null }>(
      await requireKey(),
      'query TedTeamStates($id: String!) { team(id: $id) { states(first: 100) { nodes { id name type position } } } }',
      { id: teamId },
    )
    const states = (data.team?.states?.nodes ?? []).flatMap((node) => {
      const state = workflowStateFrom(node)
      return state ? [state] : []
    })
    teams.set(teamId, { at: now(), states })
    return states
  }

  async function mutate(text: string, variables: JsonObject, field: string): Promise<void> {
    const data = await query<Record<string, { success?: boolean } | null>>(
      await requireKey(),
      text,
      variables,
    )
    if (data[field]?.success !== true) {
      throw new LinearApiError('failed', `Linear didn’t confirm ${field}`)
    }
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
      forgetKey()
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
      forgetKey()
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
      forgetKey()
      return problem ? { ...base(), state: problem } : noKey()
    },

    async lookup(url) {
      const link = parseLinearUrl(url)
      if (!link) throw new RequestError(400, 'That isn’t a Linear issue URL')
      return issueFor(link)
    },

    intakeChoices,
    intakeMembership,
    intakeIssues,
    issueFor,
    issueStates,
    teamStates,

    moveIssue(issueId, stateId) {
      return mutate(
        'mutation TedMoveIssue($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
        { id: issueId, stateId },
        'issueUpdate',
      )
    },

    linkUrl(issueId, url, title) {
      return mutate(
        'mutation TedLinkPullRequest($issueId: String!, $url: String!, $title: String!) { attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success } }',
        { issueId, url, title },
        'attachmentCreate',
      )
    },
  }
}

export function linearIssueKey(workspace: string, identifier: string): string {
  return `${workspace.toLowerCase()}/${identifier.toUpperCase()}`
}

function workflowStateFrom(value: unknown): LinearWorkflowState | undefined {
  const state = value as Partial<LinearWorkflowState> | null | undefined
  if (
    typeof state?.id !== 'string' ||
    typeof state.name !== 'string' ||
    typeof state.type !== 'string'
  ) {
    return undefined
  }
  return {
    id: state.id,
    name: oneLine(state.name).slice(0, 100),
    type: state.type,
    position: typeof state.position === 'number' ? state.position : 0,
  }
}

function issueStateFrom(value: unknown): LinearIssueState | undefined {
  const issue = value as
    | {
        id?: unknown
        identifier?: unknown
        state?: unknown
        team?: { id?: unknown; key?: unknown } | null
      }
    | null
    | undefined
  const state = workflowStateFrom(issue?.state)
  if (
    typeof issue?.id !== 'string' ||
    typeof issue.identifier !== 'string' ||
    typeof issue.team?.id !== 'string' ||
    typeof issue.team.key !== 'string' ||
    !state
  ) {
    return undefined
  }
  return {
    id: issue.id,
    identifier: issue.identifier,
    teamId: issue.team.id,
    teamKey: issue.team.key.toUpperCase(),
    state,
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

function teamOf(team: { key?: string; name?: string } | null | undefined): {
  team?: LinearTeam
} {
  if (typeof team?.key !== 'string' || !isLinearTeamKey(team.key)) return {}
  const key = team.key.toUpperCase()
  const name = typeof team.name === 'string' ? oneLine(team.name).slice(0, 80) : ''
  return { team: { key, name: name === '' ? key : name } }
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
