import type {
  Automation,
  AutomationNow,
  AutomationRun,
  AutomationSchedule,
  CreateAutomationRequest,
  Weekday,
} from '@ted/protocol'
import { describeSchedule } from '@ted/protocol/schedule'
import type { StatusTone } from './components/StatusChip.tsx'
import { ago } from './requests.ts'
import { agentLabels } from './task-fields.ts'
import { formatDate, formatTime, timePreferences } from './time.ts'

export type ScheduleKind = AutomationSchedule['kind']

export interface ScheduleDraft {
  kind: ScheduleKind
  every: string
  unit: 'minutes' | 'hours'
  at: string
  days: Weekday[]
  expression: string
}

const blankDraft: ScheduleDraft = {
  kind: 'every',
  every: '30',
  unit: 'minutes',
  at: '09:00',
  days: ['mon'],
  expression: '',
}

export function draftOf(schedule: AutomationSchedule): ScheduleDraft {
  switch (schedule.kind) {
    case 'every':
      return { ...blankDraft, kind: 'every', every: String(schedule.every), unit: schedule.unit }
    case 'daily':
    case 'weekdays':
      return { ...blankDraft, kind: schedule.kind, at: schedule.at }
    case 'weekly':
      return { ...blankDraft, kind: 'weekly', days: [...schedule.days], at: schedule.at }
    case 'custom':
      return { ...blankDraft, kind: 'custom', expression: schedule.expression }
  }
}

export function scheduleOf(draft: ScheduleDraft): AutomationSchedule | string {
  const at = () => (/^\d{2}:\d{2}$/.test(draft.at) ? draft.at : undefined)
  switch (draft.kind) {
    case 'every': {
      const text = draft.every.trim()
      if (text === '') return 'Enter how often.'
      const every = Number(text)
      if (!/^\d+$/.test(text) || every < 1) return 'Enter a whole number.'
      return { kind: 'every', every, unit: draft.unit }
    }
    case 'daily':
    case 'weekdays': {
      const time = at()
      return time === undefined ? 'Enter a time.' : { kind: draft.kind, at: time }
    }
    case 'weekly': {
      const time = at()
      if (draft.days.length === 0) return 'Pick at least one day.'
      return time === undefined ? 'Enter a time.' : { kind: 'weekly', days: draft.days, at: time }
    }
    case 'custom': {
      const expression = draft.expression.trim()
      return expression === '' ? 'Enter a cron or RRULE.' : { kind: 'custom', expression }
    }
  }
}

export function templateScheduleText(schedule: AutomationSchedule): string {
  return describeSchedule(schedule, 'UTC', timePreferences().timeFormat).replace(/ · UTC$/, '')
}

export function firingDate(iso: string): string {
  return `${formatDate(iso, { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')} ${formatTime(iso)}`
}

export function clockOf(iso: string): string {
  return formatTime(iso)
}

export function scheduleDescription(automation: Automation): string {
  return describeSchedule(automation.schedule, automation.timeZone, timePreferences().timeFormat)
}

function hoursAndMinutes(ms: number): string {
  const total = Math.max(Math.round(ms / 60_000), 1)
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

export function nextFiring(automation: Automation, now: number): string {
  const next = automation.nextFirings[0]
  if (!automation.on || next === undefined) return 'Off'
  const ms = Date.parse(next) - now
  if (ms < 24 * 60 * 60_000) return `in ${hoursAndMinutes(ms)}`
  return firingDate(next)
}

export interface LastResult {
  text: string
  tasks?: string[]
  failed?: true
  age?: string
}

export function lastResult(run: AutomationRun | undefined, now: number): LastResult | undefined {
  if (!run) return undefined
  const when = run.finishedAt ?? run.startedAt
  const age = when === undefined ? {} : { age: ago(when, now) }
  switch (run.result.kind) {
    case 'created':
      return { text: 'Created', tasks: run.result.tasks.map((t) => t.displayId), ...age }
    case 'passed':
      return { text: 'Passed', ...age }
    case 'check-failed':
      return {
        text: 'Check failed',
        failed: true,
        tasks: [
          ...run.result.tasks,
          ...(run.check?.updated ?? []),
          ...(run.check?.agent?.noted ?? []),
        ].map((t) => t.displayId),
        ...age,
      }
    case 'no-new-tasks':
      return { text: 'No new Tasks', ...age }
    case 'failed':
      return { text: 'Failed', failed: true, ...age }
    case 'stopped':
      return { text: 'Stopped by you', ...age }
    case 'skipped':
      return { text: 'Skipped' }
    case 'dropped':
      return { text: 'Dropped' }
    case 'queued':
      return { text: 'Queued' }
    case 'running':
      return { text: 'Running' }
  }
}

export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

export function nowChip(
  now: AutomationNow | undefined,
): { text: string; tone: StatusTone } | undefined {
  if (!now) return undefined
  switch (now.kind) {
    case 'working':
      return { text: 'Working', tone: 'working' }
    case 'waiting':
      return { text: 'Waiting on you', tone: 'waiting' }
    case 'queued':
      return { text: `Queued · ${ordinal(now.place)}`, tone: 'working' }
    case 'paused':
      return { text: `Paused · ${now.reason}`, tone: 'neutral' }
  }
}

export function agentModel(automation: Pick<Automation, 'agent' | 'model' | 'check'>): string {
  if (automation.check) return 'Check · no agent'
  return [agentLabels[automation.agent], automation.model].filter(Boolean).join(' · ')
}

export function trigger(
  run: AutomationRun,
  history: readonly AutomationRun[],
): { text: string; under?: string } {
  switch (run.trigger) {
    case 'scheduled':
      return { text: 'Scheduled' }
    case 'run-now':
      return { text: 'Run now' }
    case 'made-up':
      return run.slotAt === undefined
        ? { text: 'Made up' }
        : { text: 'Made up', under: `for ${firingDate(run.slotAt)}` }
    case 'retry': {
      const of = history.find((r) => r.id === run.retryOf)
      const at = of?.slotAt ?? of?.at
      return at === undefined ? { text: 'Retry' } : { text: 'Retry', under: `of ${clockOf(at)}` }
    }
  }
}

export function retryable(history: readonly AutomationRun[]): string | undefined {
  const newest = history.find((r) => r.result.kind === 'failed')
  return newest && newest.retriedAt === undefined ? newest.id : undefined
}

export function historyResult(run: AutomationRun): { text: string; failed?: true; under?: string } {
  const under =
    run.retriedAt !== undefined
      ? { under: `Retried at ${clockOf(run.retriedAt)}` }
      : run.message !== undefined
        ? { under: run.message }
        : {}
  switch (run.result.kind) {
    case 'created':
      return { text: 'Created', ...under }
    case 'passed':
      return { text: 'Passed', ...checkNotes(run, under) }
    case 'check-failed':
      return { text: checkFailedText(run), failed: true, ...checkNotes(run, under) }
    case 'no-new-tasks':
      return { text: 'No new Tasks', ...under }
    case 'failed':
      return { text: `Failed: ${run.result.error}`, failed: true, ...under }
    case 'skipped':
      return { text: 'Skipped: previous Run still open', ...under }
    case 'stopped':
      return { text: 'Stopped by you', ...under }
    case 'dropped':
      return { text: 'Dropped: turned off before it started', ...under }
    case 'queued':
      return { text: 'Queued', ...under }
    case 'running':
      if (run.check?.agent) {
        return {
          text: run.check.agent.state === 'queued' ? 'Agent queued' : 'Agent working',
          ...checkNotes(run, under),
        }
      }
      return { text: 'Running', ...under }
  }
}

function checkFailedText(run: AutomationRun): string {
  const check = run.check
  if (check?.state === 'timed-out') return 'Timed out'
  const count = check?.failing.length ?? 0
  return count === 0 ? 'Failed' : `Failed · ${count} failing test ${count === 1 ? 'file' : 'files'}`
}

function checkNotes(run: AutomationRun, under: { under?: string }): { under?: string } {
  const notes = [
    ...(run.check?.ranWhileBusy ? ['Ran at its cutoff while the computer was busy'] : []),
    ...(run.check?.skipped ?? []).map((note) => `Skipped ${note}`),
    ...(under.under !== undefined ? [under.under] : []),
  ]
  return notes.length > 0 ? { under: notes.join(' · ') } : {}
}

export function duration(run: AutomationRun, now: number): string {
  if (run.check) return durationText(run.check.durationMs)
  if (run.startedAt === undefined) return '—'
  const end = run.finishedAt === undefined ? now : Date.parse(run.finishedAt)
  return durationText(end - Date.parse(run.startedAt))
}

function durationText(ms: number): string {
  const seconds = Math.max(Math.round(ms / 1000), 0)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function duplicateOf(automation: Automation): CreateAutomationRequest {
  return {
    factory: automation.factoryKey,
    name: `${automation.name} copy`,
    prompt: automation.prompt,
    schedule: automation.schedule,
    agent: automation.agent,
    ...(automation.model !== undefined && { model: automation.model }),
    ...(automation.effort !== undefined && { effort: automation.effort }),
    ...(automation.checkout && { checkout: true }),
    ...(automation.check && { check: automation.check }),
    on: false,
  }
}
