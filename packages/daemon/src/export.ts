import type { ExportRun, ExportTask, FactoryExport, Run, Task } from '@ted/protocol'
import { RequestError } from './errors.ts'
import { redactSecrets } from './redact.ts'
import type { TedStore } from './store/index.ts'

function pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>
}

function runMetadata(run: Run): ExportRun {
  return {
    ...pick(run, [
      'id',
      'taskId',
      'parentRunId',
      'agent',
      'model',
      'effort',
      'usesDefaultModel',
      'name',
      'state',
      'startedAt',
      'revivedAt',
    ]),
    ...(run.ended && { ended: pick(run.ended, ['how', 'code', 'signal', 'at']) }),
  }
}

function taskExport(store: TedStore, task: Task): ExportTask {
  return {
    ...pick(task, [
      'id',
      'factoryId',
      'number',
      'displayId',
      'title',
      'description',
      'priority',
      'stage',
      'branch',
      'lead',
      'blockedBy',
      'attachments',
      'createdAt',
      'updatedAt',
      'archived',
      'followUpOf',
      'splitFrom',
      'fromPlan',
      'setup',
    ]),
    ...(task.source && { source: { url: task.source.url } }),
    repos: task.repos.map((repo) => pick(repo, ['name', 'repo', 'branch', 'pullRequest'])),
    descriptions: store.descriptionVersions(task.id),
    briefs: store.listBriefs(task.id),
    comments: store
      .listComments(task.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    runs: store
      .taskRunList(task.id)
      .map(runMetadata)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)),
  }
}

export function factoryExport(store: TedStore, factoryId: string): FactoryExport {
  const factory = store.getFactory(factoryId)
  if (!factory) throw new RequestError(404, 'No such Factory')
  const snapshot: FactoryExport = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    coverage: [
      'All retained Tasks, including Done and archived Tasks, Comments and answers, saved brief and description versions, and Task Run metadata.',
      'Attachment metadata and references only; attached files and Run Conversations are not included.',
      'Deleted records, repository files and non-Task Runs are not included. This export cannot be restored into TED.',
      'Known token-shaped secrets and URL credentials are redacted. Other authored text is preserved.',
    ],
    factory: {
      ...pick(factory, ['id', 'key', 'name', 'defaultBranch', 'createdAt']),
      repos: factory.repos.map((repo) => pick(repo, ['repo', 'name'])),
    },
    tasks: store
      .listTasks()
      .filter((task) => task.factoryId === factoryId)
      .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))
      .map((task) => taskExport(store, task)),
  }
  return JSON.parse(
    JSON.stringify(snapshot, (_, value: unknown) =>
      typeof value === 'string' ? redactSecrets(value) : value,
    ),
  ) as FactoryExport
}
