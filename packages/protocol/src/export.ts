import type { Factory } from './factory.ts'
import type { Run } from './run.ts'
import type { Comment, DescriptionVersion, Task, TaskBrief, TaskRepo } from './task.ts'

export type ExportFormat = 'json' | 'markdown'

export type ExportRun = Pick<
  Run,
  | 'id'
  | 'taskId'
  | 'parentRunId'
  | 'agent'
  | 'model'
  | 'effort'
  | 'usesDefaultModel'
  | 'name'
  | 'state'
  | 'startedAt'
  | 'revivedAt'
> & { ended?: Pick<NonNullable<Run['ended']>, 'how' | 'code' | 'signal' | 'at'> }

export type ExportTask = Pick<
  Task,
  | 'id'
  | 'factoryId'
  | 'number'
  | 'displayId'
  | 'title'
  | 'description'
  | 'priority'
  | 'stage'
  | 'branch'
  | 'lead'
  | 'blockedBy'
  | 'attachments'
  | 'createdAt'
  | 'updatedAt'
  | 'archived'
  | 'followUpOf'
  | 'splitFrom'
  | 'fromPlan'
  | 'setup'
> & {
  source?: { url: string }
  repos: Pick<TaskRepo, 'name' | 'repo' | 'branch' | 'pullRequest'>[]
  descriptions: DescriptionVersion[]
  briefs: TaskBrief[]
  comments: Comment[]
  runs: ExportRun[]
}

export interface FactoryExport {
  schemaVersion: 1
  exportedAt: string
  coverage: string[]
  factory: Pick<Factory, 'id' | 'key' | 'name' | 'defaultBranch' | 'createdAt' | 'repos'>
  tasks: ExportTask[]
}

export type SaveExportResult = { canceled: true } | { canceled: false; path: string; tasks: number }

export function exportFormat(value: unknown): ExportFormat {
  if (value !== 'json' && value !== 'markdown') throw new Error('format must be json or markdown')
  return value
}

function fenced(text: string, language = ''): string {
  let longest = 2
  for (const [match] of text.matchAll(/`+/g)) longest = Math.max(longest, match.length)
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language}\n${text}\n${fence}`
}

function records(value: unknown): string {
  return fenced(JSON.stringify(value, null, 2), 'json')
}

function heading(text: string): string {
  return text.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]<>#]/g, '\\$&')
}

export function formatExport(snapshot: FactoryExport, format: ExportFormat): string {
  if (format === 'json') return `${JSON.stringify(snapshot, null, 2)}\n`
  const { tasks, ...metadata } = snapshot
  const sections = [
    `# ${heading(snapshot.factory.name)} · Factory export`,
    `Exported ${snapshot.exportedAt} · Schema ${snapshot.schemaVersion}`,
    ...snapshot.coverage.map((line) => `- ${line}`),
    '## Factory metadata',
    records(metadata),
  ]
  for (const task of tasks) {
    const { descriptions, briefs, comments, runs, ...details } = task
    sections.push(
      `## ${heading(task.displayId)} · ${heading(task.title)}`,
      `Task ID: ${task.id}`,
      fenced(task.description),
      '### Task metadata',
      records(details),
      '### Description versions',
    )
    for (const version of descriptions) {
      sections.push(`#### Version ${version.version} · ${version.at}`, fenced(version.text))
    }
    sections.push('### Task brief versions')
    for (const brief of briefs) {
      sections.push(
        `#### Version ${brief.version} · ${brief.createdAt}`,
        fenced(brief.text),
        records(brief),
      )
    }
    sections.push('### Comments and answers')
    for (const comment of comments) {
      sections.push(
        `#### ${comment.createdAt} · ${heading(comment.kind)}`,
        fenced(comment.body),
        records(comment),
      )
    }
    sections.push('### Run metadata', records(runs))
  }
  if (tasks.length === 0) sections.push('No retained Tasks in this Factory.')
  return `${sections.join('\n\n')}\n`
}
