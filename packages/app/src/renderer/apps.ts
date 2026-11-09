import type { PullRequestPreview, SimulatorSlots, Task, TaskApp } from '@ted/protocol'
import { isSimulatorApp } from '@ted/protocol/app'
import { age, ago } from './requests.ts'

export interface HostedPreview {
  repo: string
  pullRequest: number
  preview: PullRequestPreview
}

export type PreviewChoice =
  | { kind: 'hosted'; hosted: HostedPreview }
  | { kind: 'local'; app: TaskApp }
  | { kind: 'run'; app: TaskApp; again: boolean }

export function hostedPreviews(task: Task): HostedPreview[] {
  return task.repos.flatMap((repo) => {
    const pr = repo.pullRequest
    if (!pr?.preview || pr.state === 'closed') return []
    return [{ repo: repo.name, pullRequest: pr.number, preview: pr.preview }]
  })
}

export function previewChoice(task: Task, apps: readonly TaskApp[]): PreviewChoice | undefined {
  const [hosted] = hostedPreviews(task)
  if (hosted) return { kind: 'hosted', hosted }
  const web = apps.filter((a) => a.kind === 'web' && !a.removed)
  const live = web.find((a) => a.state === 'running') ?? web.find((a) => a.state === 'starting')
  if (live) return { kind: 'local', app: live }
  const [first] = web
  if (!first) return undefined
  return { kind: 'run', app: first, again: first.startedAt !== undefined }
}

export const isLive = (app: TaskApp) =>
  app.state === 'running' || app.state === 'starting' || app.state === 'waiting'

export function needsSlot(app: TaskApp, slots: SimulatorSlots | undefined): boolean {
  return (
    isSimulatorApp(app) &&
    slots !== undefined &&
    app.simulator?.booted !== true &&
    slots.booted.length >= slots.limit
  )
}

export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export function appStatusLine(app: TaskApp, now: number): string {
  const line = stateLine(app, now)
  return app.removed ? `Removed from settings · ${line}` : line
}

function simulatorLine(app: TaskApp, now: number): string | undefined {
  const simulator = app.simulator
  if (!simulator) return undefined
  if (app.state === 'waiting') return `Waiting for a simulator · ${simulator.device}`
  if (simulator.booted) {
    return `${simulator.device} · ${simulator.recording ? 'recording' : 'booted'}`
  }
  const shutDown = simulator.shutDown
  if (!shutDown || app.state === 'failed') return undefined
  return shutDown.for !== undefined
    ? `Shut down ${ago(shutDown.at, now)} to free a slot for ${shutDown.for}`
    : `${simulator.device} · shut down ${ago(shutDown.at, now)}`
}

function stateLine(app: TaskApp, now: number): string {
  const simulator = simulatorLine(app, now)
  if (simulator !== undefined) return simulator
  switch (app.state) {
    case 'waiting':
      return 'Waiting for a simulator'
    case 'running':
      return app.url !== undefined
        ? hostOf(app.url)
        : `Running · ${app.startedAt !== undefined ? age(app.startedAt, now) : 'now'}`
    case 'starting':
      return app.url !== undefined ? `Starting · ${hostOf(app.url)}` : 'Starting…'
    case 'exited':
      if (app.exitCode !== undefined) return `Exited with code ${app.exitCode}`
      return app.signal !== undefined ? `Ended by ${app.signal}` : 'Stopped running'
    case 'failed': {
      const problem = app.problem ?? 'it failed'
      return `Couldn’t start: ${problem}`
    }
    default:
      return app.endedAt !== undefined ? `Stopped ${ago(app.endedAt, now)}` : 'Not running'
  }
}

export function appsSummary(apps: readonly TaskApp[], hosted: number): string | undefined {
  const running = apps.filter((a) => a.state === 'running' || a.state === 'starting').length
  if (running > 0) return `${running} running`
  if (hosted > 0) return hosted === 1 ? '1 hosted preview' : `${hosted} hosted previews`
  return undefined
}
