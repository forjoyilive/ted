import { lstat, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AppRef, TaskApp } from '@ted/protocol'
import type { AppRepo, Apps, AppTask } from '../apps/apps.ts'
import type { AppDeclaration } from '../apps/declared.ts'
import type { Banners } from '../banners.ts'
import { type CopiedRepo, freshFolder, makeCopy, removeCopy } from '../code-copy.ts'
import { RequestError } from '../errors.ts'
import { clonePath } from '../factories.ts'
import { taskFolder } from '../leftover-processes.ts'
import type { Sandbox } from '../sandbox.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import type { FactoryRepoEntry } from './repos.ts'
import { runScratchSetup } from './scratch-setup.ts'

interface Dependency {
  entry: FactoryRepoEntry
  app: AppDeclaration
}

interface PreviewRequest {
  taskId: string
  factory: StoredFactory
  task: AppTask
  desktop: Dependency
  relay: Dependency
  phone: AppRef
  runId: string
  assertLive(): void
  startPhone(): Promise<TaskApp>
}

interface PreviewRepo extends AppRepo {
  apps: [AppDeclaration]
  preview: NonNullable<AppRepo['preview']>
}

interface Preview {
  repos: [relay: PreviewRepo, desktop: PreviewRepo]
  copies: CopiedRepo[]
  phone: AppRef
  runId: string
  relayOrigin?: string
}

const desktopSource = 'desktop-source'

const keyring = `const keys = new Map()
export default function keyring(account) {
  return {
    kind: 'macos-keychain',
    async get() { return keys.get(account) },
    async set(secret) { keys.set(account, secret) },
    async delete() { keys.delete(account) },
  }
}
`

function refOf(repo: AppRepo, app: AppDeclaration): AppRef {
  return { repo: repo.name, name: app.name }
}

export function createPairedPreviews(options: {
  root: string
  reposDir: string
  apps: Apps
  store: TedStore
  banners: Banners
  sandbox: Sandbox
  env(): NodeJS.ProcessEnv
}) {
  const live = new Map<string, Preview>()
  const pending = new Map<string, Promise<void>>()

  function serial<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const result = (pending.get(taskId) ?? Promise.resolve()).then(work)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    pending.set(taskId, settled)
    return result.finally(() => {
      if (pending.get(taskId) === settled) pending.delete(taskId)
    })
  }

  async function stop(taskId: string): Promise<void> {
    const preview = live.get(taskId)
    if (!preview) return
    for (const repo of preview.repos.toReversed()) {
      await options.apps.stop(taskId, refOf(repo, repo.apps[0]), { runId: preview.runId })
    }
    live.delete(taskId)
    await removeCopy(preview.copies, options.root, taskId)
  }

  async function removeStale(taskId: string, factory: StoredFactory): Promise<void> {
    const folder = await taskFolder(options.root, taskId)
    if (!folder || !(await lstat(folder).catch(() => undefined))?.isDirectory()) return
    const worktree = path.join(folder, desktopSource)
    await removeCopy(
      [{ clone: clonePath(options.reposDir, factory), worktree }],
      options.root,
      taskId,
    )
  }

  async function prepare(input: PreviewRequest): Promise<Preview> {
    const { taskId, task, desktop, relay } = input
    const grants = task.sandbox
    if (!grants) throw new RequestError(409, 'Paired previews require the App sandbox')
    const mobile = task.repos.find((repo) => repo.name === relay.entry.name)
    if (!mobile) throw new RequestError(409, 'The local relay needs a Task worktree')
    const problem = await options.sandbox.problem()
    if (problem !== undefined) throw new RequestError(409, problem)
    input.assertLive()
    const previousApps = await options.apps.list(taskId)
    for (const app of previousApps) {
      if (app.removed && (app.name === desktop.app.name || app.name === relay.app.name))
        await options.apps.stop(taskId, { repo: app.repo, name: app.name })
    }
    await removeStale(taskId, input.factory)
    const folder = await freshFolder(options.root, taskId)
    const copies: CopiedRepo[] = []
    try {
      const existing = task.repos.find((repo) => repo.name === desktop.entry.name)
      if (!existing) {
        copies.push(
          ...(await makeCopy(options, {
            folder,
            factory: input.factory,
            entries: [{ ...desktop.entry, name: desktopSource, copy: [] }],
            branch: 'default',
            clone: { ensure: options.banners },
            fetch: 'none',
            copyFiles: 'required',
          })),
        )
      }
      const desktopTree = existing?.worktree ?? copies[0]?.worktree
      if (!desktopTree) throw new RequestError(409, 'Ted couldn’t prepare the desktop preview')
      const home = path.join(folder, 'ted-home')
      const relayState = path.join(folder, 'relay')
      const module = path.join(folder, 'keyring.mjs')
      await mkdir(home, { mode: 0o700 })
      await mkdir(relayState, { mode: 0o700 })
      await writeFile(module, keyring, { flag: 'wx', mode: 0o600 })
      const scope = (entry: FactoryRepoEntry, tree: string, state: string) => ({
        ...grants,
        writable: [tree, state],
        readable: [clonePath(options.reposDir, entry)],
      })
      const desktopScope = scope(desktop.entry, desktopTree, folder)
      await runScratchSetup({
        repos: copies.map(({ entry, worktree }) => ({
          name: entry.name,
          worktree,
          env: entry.env,
          ...(entry.setup && { setup: entry.setup }),
        })),
        factoryId: input.factory.id,
        sandbox: options.sandbox,
        banners: options.banners,
        scope: desktopScope,
        tmpRoot: folder,
        logDir: folder,
        env: options.env(),
        lowPriority: options.store.settings().lowPriorityWork,
      })
      return {
        copies,
        phone: input.phone,
        runId: input.runId,
        repos: [
          {
            ...mobile,
            apps: [relay.app],
            preview: {
              scope: scope(relay.entry, mobile.worktree, relayState),
              env: { TED_PREVIEW_DIR: relayState },
            },
          },
          {
            name: desktop.entry.name,
            worktree: desktopTree,
            env: existing?.env ?? desktop.entry.env,
            apps: [desktop.app],
            preview: {
              scope: desktopScope,
              env: {
                TED_HOME: home,
                TED_KEYRING_MODULE: module,
                TED_SKIP_FIRST_LAUNCH: '1',
                TED_STAY_AWAKE: 'off',
              },
            },
          },
        ],
      }
    } catch (error) {
      await removeCopy(copies, options.root, taskId)
      throw error
    }
  }

  async function ready(taskId: string, app: TaskApp, assertLive: () => void): Promise<TaskApp> {
    while (app.state === 'starting') {
      await sleep(250)
      assertLive()
      const port = app.port
      const current = (await options.apps.list(taskId)).find(
        (item) => item.repo === app.repo && item.name === app.name && item.port === port,
      )
      if (!current) throw new RequestError(409, `${app.name} disappeared while starting`)
      app = current
    }
    if (app.state !== 'running') {
      const log = await options.apps.log(taskId, { repo: app.repo, name: app.name })
      const tail = log.text.split('\n').slice(-10).join('\n').trim()
      const detail = tail ? `\n${tail}` : ''
      throw new RequestError(
        409,
        `${app.name} couldn’t start: ${app.problem ?? app.state}.${detail}`,
      )
    }
    return app
  }

  async function start(input: PreviewRequest): Promise<TaskApp> {
    const { taskId, runId, assertLive } = input
    try {
      let preview = live.get(taskId)
      if (!preview) {
        preview = await prepare(input)
        live.set(taskId, preview)
      }
      const [relay, desktop] = preview.repos
      assertLive()
      const startedRelay = await ready(
        taskId,
        await options.apps.start(taskId, refOf(relay, relay.apps[0]), 'task-lead', {
          runId,
          preview: true,
        }),
        assertLive,
      )
      if (startedRelay.url === undefined) {
        throw new RequestError(409, 'Ted couldn’t find the preview relay URL')
      }
      const relayOrigin = new URL(startedRelay.url).origin
      if (preview.relayOrigin !== undefined && preview.relayOrigin !== relayOrigin)
        await options.apps.stop(taskId, refOf(desktop, desktop.apps[0]))
      preview.relayOrigin = relayOrigin
      desktop.preview.env.TED_RELAY_URL = relayOrigin
      assertLive()
      await ready(
        taskId,
        await options.apps.start(taskId, refOf(desktop, desktop.apps[0]), 'task-lead', {
          runId,
          preview: true,
        }),
        assertLive,
      )
      assertLive()
      return await input.startPhone()
    } catch (error) {
      await stop(taskId)
      throw error
    }
  }

  return {
    repos: (taskId: string) => live.get(taskId)?.repos ?? [],
    start: (input: PreviewRequest) => serial(input.taskId, () => start(input)),
    removeStale,
    stop: (taskId: string, phone?: AppRef) =>
      serial(taskId, async () => {
        const active = live.get(taskId)?.phone
        if (phone && (!active || active.name !== phone.name || active.repo !== phone.repo)) return
        await stop(taskId)
      }),
  }
}
