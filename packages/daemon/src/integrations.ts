import { execFile } from 'node:child_process'
import {
  type DaemonEvent,
  type FixCommand,
  type GitHealth,
  type GitHubCli,
  type GitHubHost,
  type IntegrationFix,
  type IntegrationsHealth,
  integrationFixes,
  minGhVersion,
  type RunFixRequest,
  type RunFixResult,
} from '@ted/protocol'
import { compareVersions } from './backups.ts'
import type { Banners } from './banners.ts'
import { findBin } from './cli-env.ts'
import { createEnvironment, type Environment, ghEnv, gitEnv } from './command-env.ts'
import { RequestError } from './errors.ts'
import { createGh, type Gh } from './github/gh.ts'
import { redactSecrets } from './redact.ts'
import type { TedStore } from './store/index.ts'
import type { OpenTerminal } from './terminal.ts'

export interface Integrations {
  readonly gh: Gh
  current(): IntegrationsHealth | undefined
  check(options?: { fresh?: boolean }): Promise<IntegrationsHealth>
  fix(request: RunFixRequest): Promise<RunFixResult>
  start(): void
  close(): void
}

export interface IntegrationsOptions {
  store: TedStore
  banners: Banners
  openTerminal: OpenTerminal
  emit?: (event: DaemonEvent) => void
  ghBin?: string
  gitBin?: string
  loginShell?: boolean
  environment?: Environment
  checkEveryMs?: number
  watchAfterFix?: { everyMs: number; forMs: number }
  platform?: NodeJS.Platform
  now?: () => Date
}

export const githubProblem = 'github-cli'
export const rateLimitProblem = 'github-rate-limit'
const defaultHost = 'github.com'
const rateLimitBannerAfterMs = 15 * 60_000
const validHost = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i

export function createIntegrations(options: IntegrationsOptions): Integrations {
  const { store, banners } = options
  const platform = options.platform ?? process.platform
  const now = options.now ?? (() => new Date())
  let last: IntegrationsHealth | undefined
  let running: Promise<IntegrationsHealth> | undefined
  let timer: NodeJS.Timeout | undefined
  const watches = new Set<NodeJS.Timeout>()
  let unsubscribe: (() => void) | undefined
  let closed = false

  const environment =
    options.environment ?? createEnvironment({ loginShell: options.loginShell ?? false })
  let loaded: Promise<unknown> = options.environment ? Promise.resolve() : environment.reload()
  const loadEnv = async (fresh: boolean) => {
    if (fresh) loaded = environment.reload()
    await loaded
    return gitEnv(environment.current())
  }

  const gh = createGh({
    async locate() {
      const found = await loadEnv(false)
      return { bin: options.ghBin ?? (await findBin('gh', found)) ?? 'gh', env: found }
    },
    onAuthError: () => void check().catch(() => undefined),
    rateLimit: {
      limited(host, since, retryAt) {
        if (now().getTime() - since.getTime() < rateLimitBannerAfterMs) return
        banners.raise({
          problem: rateLimitProblem,
          subject: host,
          severity: 'warning',
          text: `GitHub rate limit${host === defaultHost ? '' : ` on ${host}`} · checking again at ${clock(retryAt)}`,
        })
      },
      cleared(host) {
        banners.clear({ problem: rateLimitProblem, subject: host })
      },
    },
    ...(options.now && { now: options.now }),
  })

  async function measure(fresh: boolean): Promise<IntegrationsHealth> {
    const found = await loadEnv(fresh)
    const [github, git] = await Promise.all([checkGitHub(found), checkGit(found)])
    return { github, git, checkedAt: now().toISOString() }
  }

  async function checkGitHub(found: NodeJS.ProcessEnv): Promise<IntegrationsHealth['github']> {
    const needed = hostsInUse(store)
    const bin = options.ghBin ?? (await findBin('gh', found))
    const hosts = (state: GitHubHost['state']) =>
      needed.map(({ host, usedBy }) => ({ host, usedBy, state, scopes: [] }))
    if (bin === undefined) {
      return {
        cli: { state: 'not-installed', fix: commandFor('gh-install') },
        hosts: hosts('signed-out'),
      }
    }
    const version = await run(bin, ['--version'], found).then(
      (out) => /gh version (\d+\.\d+\.\d+)/.exec(out)?.[1],
      (error: unknown) => (isMissing(error) ? null : undefined),
    )
    if (version === null) {
      return {
        cli: { state: 'not-installed', fix: commandFor('gh-install') },
        hosts: hosts('signed-out'),
      }
    }
    if (version === undefined) {
      return {
        cli: { state: 'failed', path: bin, error: 'TED couldn’t read the GitHub CLI’s version' },
        hosts: hosts('failed'),
      }
    }
    if (compareVersions(version, minGhVersion) < 0) {
      return {
        cli: { state: 'too-old', version, path: bin, fix: commandFor('gh-update') },
        hosts: hosts('failed'),
      }
    }
    const cli: GitHubCli = { state: 'ready', version, path: bin }
    let status: Record<string, unknown[]>
    try {
      const parsed = JSON.parse(await gh.run(['auth', 'status', '--json', 'hosts'])) as {
        hosts?: Record<string, unknown[]>
      }
      status = parsed.hosts ?? {}
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error))
      return {
        cli,
        hosts: needed.map((n) => ({ ...n, state: 'failed', scopes: [], error: message })),
      }
    }
    return { cli, hosts: needed.map((n) => hostHealth(n, status[n.host])) }
  }

  function hostHealth(
    { host, usedBy }: { host: string; usedBy: string[] },
    accounts: unknown[] | undefined,
  ): GitHubHost {
    const entries = (accounts ?? []).filter(
      (a): a is Record<string, unknown> => typeof a === 'object' && a !== null,
    )
    const account = entries.find((a) => a.active === true) ?? entries[0]
    if (!account) {
      return { host, usedBy, state: 'signed-out', scopes: [], fix: commandFor('gh-login', host) }
    }
    const text = (name: string) =>
      typeof account[name] === 'string' && account[name] !== ''
        ? (account[name] as string)
        : undefined
    const login = text('login')
    const tokenSource = text('tokenSource')
    const gitProtocol = text('gitProtocol')
    const scopes = (text('scopes') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const known = {
      host,
      usedBy,
      scopes,
      ...(login !== undefined && { login }),
      ...(tokenSource !== undefined && { tokenSource }),
      ...(gitProtocol !== undefined && { gitProtocol }),
    }
    const state = text('state')
    if (state === 'timeout') {
      return { ...known, state: 'failed', error: `Couldn’t reach ${host}` }
    }
    if (state !== 'success') {
      return { ...known, state: 'signed-out', fix: commandFor('gh-login', host) }
    }
    if (gitProtocol === 'https' && !scopes.includes('workflow')) {
      return { ...known, state: 'missing-workflow-scope', fix: commandFor('gh-refresh', host) }
    }
    return { ...known, state: 'ready' }
  }

  async function checkGit(found: NodeJS.ProcessEnv): Promise<GitHealth> {
    const bin = options.gitBin ?? (await findBin('git', found))
    const version =
      bin === undefined
        ? undefined
        : await run(bin, ['--version'], found).then(
            (out) => /git version (\S+)/.exec(out)?.[1],
            () => undefined,
          )
    if (bin === undefined || version === undefined) {
      return { state: 'not-installed', fix: commandFor('git-install') }
    }
    const config = (name: string) =>
      run(bin, ['config', '--global', '--get', name], found).then(
        (out) => out.trim() || undefined,
        () => undefined,
      )
    const [name, email] = await Promise.all([config('user.name'), config('user.email')])
    const known = {
      version,
      path: bin,
      ...(name !== undefined && { name }),
      ...(email !== undefined && { email }),
    }
    if (name === undefined || email === undefined) {
      return {
        ...known,
        state: 'no-identity',
        copy: [
          ...(name === undefined ? ['git config --global user.name "Your Name"'] : []),
          ...(email === undefined ? ['git config --global user.email "you@example.com"'] : []),
        ],
      }
    }
    return { ...known, state: 'ready' }
  }

  function commandFor(fix: IntegrationFix, host: string = defaultHost): FixCommand {
    const linux = (apt: string, dnf: string) => (platform === 'linux' && hasDnf ? dnf : apt)
    switch (fix) {
      case 'gh-install':
        return {
          label: 'Install',
          command:
            platform === 'darwin'
              ? 'brew install gh'
              : linux('sudo apt install gh', 'sudo dnf install gh'),
        }
      case 'gh-update':
        return {
          label: 'Update',
          command:
            platform === 'darwin'
              ? 'brew upgrade gh'
              : linux('sudo apt install --only-upgrade gh', 'sudo dnf upgrade gh'),
        }
      case 'gh-login':
        return { label: 'Sign in', command: `gh auth login --web --hostname ${host} -s workflow` }
      case 'gh-refresh':
        return {
          label: 'Add permission',
          command: `gh auth refresh --hostname ${host} -s workflow`,
        }
      case 'gh-setup-git':
        return { label: 'Fix', command: `gh auth setup-git --hostname ${host}` }
      case 'git-install':
        return {
          label: 'Install',
          command:
            platform === 'darwin'
              ? 'xcode-select --install'
              : linux('sudo apt install git', 'sudo dnf install git'),
        }
    }
  }

  let hasDnf = false

  function updateBanner(health: IntegrationsHealth): void {
    const problem = githubBanner(health)
    if (!problem) {
      banners.clear({ problem: githubProblem })
      return
    }
    const waiting = store.listTasks().filter((t) => t.stage === 'merge').length
    const affects =
      waiting > 0
        ? `${waiting} ${waiting === 1 ? 'Task' : 'Tasks'} waiting to merge`
        : 'needed to add a Factory'
    banners.raise({
      problem: githubProblem,
      severity: 'stops-work',
      text: `${problem.text} · ${affects}`,
      action: { label: 'Fix', section: 'integrations' },
    })
  }

  function check({ fresh = false }: { fresh?: boolean } = {}): Promise<IntegrationsHealth> {
    if (running && !fresh) return running
    const next = (async () => {
      if (platform === 'linux') {
        hasDnf = (await findBin('dnf', await loadEnv(fresh))) !== undefined
      }
      const health = await measure(fresh)
      if (closed) return health
      last = health
      updateBanner(health)
      options.emit?.({ type: 'integrations-checked', health })
      return health
    })()
    running = next
    return next.finally(() => {
      if (running === next) running = undefined
    })
  }

  async function fix({ fix: kind, host }: RunFixRequest): Promise<RunFixResult> {
    if (!integrationFixes.includes(kind)) {
      throw new RequestError(400, `fix must be ${integrationFixes.join(', ')}`)
    }
    if (host !== undefined && !validHost.test(host)) {
      throw new RequestError(400, 'host must be a hostname like github.com')
    }
    const { command } = commandFor(kind, host)
    await loaded
    await options.openTerminal(command, environment.current())
    watch(kind, host ?? defaultHost)
    return { command }
  }

  function watch(kind: IntegrationFix, host: string): void {
    const { everyMs, forMs } = options.watchAfterFix ?? { everyMs: 5_000, forMs: 5 * 60_000 }
    const until = Date.now() + forMs
    const tick = setInterval(() => {
      void check({ fresh: true }).then(
        (health) => {
          if (fixed(health, kind, host) || Date.now() >= until) stop()
        },
        () => {
          if (Date.now() >= until) stop()
        },
      )
    }, everyMs)
    tick.unref()
    watches.add(tick)
    function stop() {
      clearInterval(tick)
      watches.delete(tick)
    }
  }

  banners.onAction(githubProblem, async () => {
    const health = last ?? (await check())
    const next = githubBanner(health)
    if (!next) return
    await fix(next.fix)
  })

  return {
    gh,
    current: () => last,
    check,
    fix,
    start() {
      void check({ fresh: true }).catch((error: unknown) =>
        console.error(redactSecrets(`checking GitHub and Git failed: ${String(error)}`)),
      )
      timer = setInterval(
        () => void check({ fresh: false }).catch(() => undefined),
        options.checkEveryMs ?? 10 * 60_000,
      )
      timer.unref()
      unsubscribe = store.subscribe((event) => {
        if (last && (event.type === 'task-updated' || event.type === 'task-created')) {
          updateBanner(last)
        }
      })
    },
    close() {
      closed = true
      if (timer) clearInterval(timer)
      for (const tick of watches) clearInterval(tick)
      watches.clear()
      unsubscribe?.()
    },
  }
}

function githubBanner(
  health: IntegrationsHealth,
): { text: string; fix: RunFixRequest } | undefined {
  const { cli, hosts } = health.github
  if (cli.state === 'not-installed') {
    return { text: 'GitHub CLI isn’t installed', fix: { fix: 'gh-install' } }
  }
  if (cli.state === 'too-old') {
    return {
      text: `GitHub CLI ${cli.version} is too old · TED needs ${minGhVersion}`,
      fix: { fix: 'gh-update' },
    }
  }
  const signedOut = hosts.find((h) => h.state === 'signed-out')
  if (!signedOut) return undefined
  const where = signedOut.host === defaultHost ? '' : ` of ${signedOut.host}`
  return {
    text: `GitHub CLI is signed out${where}`,
    fix: { fix: 'gh-login', host: signedOut.host },
  }
}

function fixed(health: IntegrationsHealth, kind: IntegrationFix, host: string): boolean {
  const row = health.github.hosts.find((h) => h.host === host)
  switch (kind) {
    case 'gh-install':
    case 'gh-update':
      return health.github.cli.state === 'ready'
    case 'gh-login':
      return row !== undefined && row.state !== 'signed-out'
    case 'gh-refresh':
      return row?.state === 'ready'
    case 'git-install':
      return health.git.state !== 'not-installed'
    case 'gh-setup-git':
      return false
  }
}

export function hostsInUse(store: TedStore): { host: string; usedBy: string[] }[] {
  const byHost = new Map<string, string[]>()
  for (const factory of store.listFactories()) {
    const host = hostOf(factory.cloneUrl)
    if (host === undefined) continue
    byHost.set(host, [...(byHost.get(host) ?? []), factory.name])
  }
  if (byHost.size === 0) return [{ host: defaultHost, usedBy: [] }]
  return [...byHost].map(([host, usedBy]) => ({ host, usedBy }))
}

export function hostOf(cloneUrl: string): string | undefined {
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i.exec(cloneUrl)
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/)/.exec(cloneUrl)
  const host = (url?.[1] ?? scp?.[1])?.toLowerCase()
  return host !== undefined && validHost.test(host) ? host : undefined
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'EACCES'
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        env: ghEnv(env),
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ).stdin?.end()
  })
}
