import type { Comment, RunSummary, Task, TaskBrief } from '@ted/protocol'
import { useState } from 'react'
import { stageName } from './list-view.ts'
import { ago, briefSections } from './requests.ts'
import { activeSubAgentCount, activeSubAgentLabel } from './sub-agents.ts'

export type DetailsSectionId = 'code' | 'files' | 'changes' | 'runs' | 'apps' | 'brief'

const collapsedKey = 'ted.taskDetails.collapsed'

function readCollapsed(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]')
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function useCollapsed(id: DetailsSectionId): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed().includes(id))
  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      const others = readCollapsed().filter((other) => other !== id)
      localStorage.setItem(collapsedKey, JSON.stringify(next ? [...others, id] : others))
    } catch {}
  }
  return [collapsed, toggle]
}

export function briefPart(text: string, heading: string): string | undefined {
  const body = briefSections(text).find(
    (section) => section.heading.toLowerCase() === heading.toLowerCase(),
  )?.body
  return body === undefined || body === '' ? undefined : body
}

export function briefLines(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '• ').trimEnd())
    .filter((line) => line !== '')
}

export function briefUpdatedLine(
  brief: TaskBrief,
  comments: readonly Comment[],
  now: number,
): string {
  const atGate = comments.some(
    (c) => c.gate !== undefined && c.stage === brief.stage && c.createdAt >= brief.createdAt,
  )
  const where = atGate ? `at the ${stageName(brief.stage)} Gate` : `in ${stageName(brief.stage)}`
  return `Updated by the Task Lead ${where} · ${ago(brief.createdAt, now)}`
}

export function briefSummary(brief: TaskBrief | null | undefined, now: number): string {
  return brief ? `updated ${ago(brief.createdAt, now)}` : 'not written yet'
}

export function runStateWord(run: RunSummary): string {
  if (run.paused !== undefined) return 'paused'
  if (run.onSubAgents) return 'on sub-agents'
  if (run.state === 'waiting') return 'waiting on you'
  return run.state
}

export function runsCollapsedSummary(runs: readonly RunSummary[]): string {
  const live = runs.filter((r) => r.state !== 'finished')
  const lead = live.find((r) => r.role !== 'sub-agent' && r.current)
  const subAgents = activeSubAgentCount(runs)
  const stopped = runs.length - live.length
  return [
    ...(lead ? [`Task Lead ${runStateWord(lead)}`] : []),
    activeSubAgentLabel(subAgents),
    ...(stopped > 0 ? [`${stopped} stopped`] : []),
  ].join(' · ')
}

const pullRequestWords = { draft: 'draft', ready: 'open', merged: 'merged', closed: 'closed' }

export function codeSummary(task: Task): string {
  const repos = task.repos.filter((r) => !r.removed)
  if (repos.length === 0) return task.repos.length === 0 ? 'no worktree yet' : 'worktree removed'
  if (repos.length > 1) return `${repos.length} repos`
  const [repo] = repos
  if (!repo) return ''
  const pr = repo.pullRequest
  return pr ? `PR #${pr.number} · ${pullRequestWords[pr.state]}` : repo.branch
}
