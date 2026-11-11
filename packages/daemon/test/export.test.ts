import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DaemonClient, readDaemonInfo, tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { factoryExport } from '../src/export.ts'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import { api, makeOriginRepo } from './helpers.ts'

test('exports all retained Task states, answers, history and Run metadata from only one Factory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-export-store-'))
  const store = await openStore({ directory })
  try {
    const factory = store.addFactory({
      key: 'NB',
      name: 'Widgets',
      repo: 'acme/widgets',
      cloneUrl: 'https://user:password@github.com/acme/widgets',
      defaultBranch: 'main',
    })
    const other = await store.createTask({ title: 'Other Factory' })
    const attachment = {
      hash: 'a'.repeat(64),
      name: 'reference.txt',
      size: 20,
      mediaType: 'text/plain',
    }
    const backlog = await store.createTask({
      factoryId: factory.id,
      title: 'Backlog',
      description: 'Original',
      attachments: [attachment],
    })
    const active = await store.createTask({ factoryId: factory.id, title: 'Active' })
    store.changeStage(active.id, 'work')
    const done = await store.createTask({ factoryId: factory.id, title: 'Done' })
    store.changeStage(done.id, 'done')
    const archived = await store.createTask({ factoryId: factory.id, title: 'Archived' })
    store.archiveTask(archived.id)
    store.editTask(backlog.id, { description: 'Edited' })
    store.writeBrief({ taskId: backlog.id, text: 'First brief' })
    store.writeBrief({ taskId: backlog.id, text: 'Second brief' })
    const line = {
      taskId: backlog.id,
      repo: 'acme/widgets',
      path: 'src/app.ts',
      side: 'new' as const,
      start: 1,
      end: 1,
      commit: 'abc',
      quoted: [],
      body: 'Submitted line',
    }
    const submitted = store.draftLineComment(line)
    store.draftLineComment({ ...line, start: 2, end: 2, body: 'UNSENT DRAFT' })
    const comment = store.postComment({
      taskId: backlog.id,
      kind: 'question',
      author: { kind: 'human' },
      body: 'Bearer abcdefghijklmnop',
      choices: ['Yes', 'No'],
      attachments: [attachment],
      lineComments: [submitted.id],
      design: {
        prototype: { hash: 'b'.repeat(64), name: 'prototype.html' },
        worthYourEye: ['Keep history'],
      },
    })
    store.answerComment(comment.id, { kind: 'answered', text: 'Yes', at: new Date().toISOString() })
    store.startRun({
      id: 'lead',
      taskId: active.id,
      agent: 'codex',
      prompt: 'PRIVATE PROMPT',
      cwd: '/private/machine/path',
      sessionId: 'PRIVATE SESSION',
    })
    store.startRun({
      id: 'child',
      taskId: active.id,
      parentRunId: 'lead',
      agent: 'claude',
      prompt: 'PRIVATE CHILD',
      cwd: '/private/machine/path',
    })
    store.startRun({
      id: 'outside',
      taskId: other.id,
      agent: 'codex',
      prompt: 'OTHER PROMPT',
      cwd: '/private/machine/path',
    })
    store.recordRunOutput('child', {
      toOffset: 0,
      state: 'finished',
      ending: {
        how: 'exited',
        code: 0,
        error: 'PRIVATE END',
        errorLines: ['PRIVATE ERROR'],
        at: new Date().toISOString(),
      },
    })
    const before = store.listTasks()
    const snapshot = factoryExport(store, factory.id)
    expect(snapshot.tasks.map((task) => task.title)).toEqual([
      'Backlog',
      'Active',
      'Done',
      'Archived',
    ])
    expect(snapshot.tasks[2]?.stage).toBe('done')
    expect(snapshot.tasks[3]?.archived).toBeDefined()
    expect(snapshot.tasks[0]?.descriptions.map((version) => version.text)).toEqual([
      'Original',
      'Edited',
    ])
    expect(snapshot.tasks[0]?.attachments).toEqual([attachment])
    expect(snapshot.tasks[0]?.comments[0]).toMatchObject({
      attachments: [attachment],
      lineComments: [{ body: 'Submitted line' }],
      design: { prototype: { name: 'prototype.html' } },
    })
    expect(store.listBriefs(backlog.id).map((brief) => brief.version)).toEqual([1, 2])
    expect(snapshot.tasks[0]?.briefs.map((brief) => brief.text)).toEqual([
      'First brief',
      'Second brief',
    ])
    expect(snapshot.tasks[0]?.comments[0]).toMatchObject({
      body: 'Bearer [redacted]',
      answer: { kind: 'answered', text: 'Yes' },
      choices: ['Yes', 'No'],
    })
    expect(snapshot.tasks[1]?.runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'child', parentRunId: 'lead' })]),
    )
    const text = JSON.stringify(snapshot)
    for (const excluded of [
      'PRIVATE',
      '/private/machine/path',
      'outside',
      'Other Factory',
      'password',
      'cloneUrl',
      'sessionId',
      'cwd',
      'UNSENT DRAFT',
    ])
      expect(text).not.toContain(excluded)
    expect(store.listTasks()).toEqual(before)
    snapshot.tasks[0]?.comments.splice(0)
    expect(store.listComments(backlog.id)).toHaveLength(1)
    expect(() => factoryExport(store, 'missing')).toThrow('No such Factory')
    const empty = store.addFactory({
      key: 'EMPTY',
      name: 'Empty',
      repo: 'acme/empty',
      cloneUrl: 'https://github.com/acme/empty',
      defaultBranch: 'main',
    })
    expect(factoryExport(store, empty.id).tasks).toEqual([])
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('DaemonClient reads an export; Run tokens cannot read Factory exports', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-export-api-'))
  const daemon = await startDaemon({ home, version: 'test' })
  try {
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('No daemon info')
    const app = new DaemonClient(info, '', { appKey: daemon.appToken })
    const origin = await makeOriginRepo(home)
    const added = await api(daemon.port, { appKey: daemon.appToken }).call(
      'POST',
      '/dev/factories',
      { repo: origin, key: 'NB' },
    )
    expect(added.status).toBe(201)
    await app.createTask({ title: 'Export me', factory: 'NB' })
    const [factory] = await app.listFactories()
    if (!factory) throw new Error('No Factory')
    const client = new DaemonClient(info)
    expect((await client.exportFactory(factory.id)).tasks[0]?.title).toBe('Export me')
    await expect(client.exportFactory('missing')).rejects.toThrow('No such Factory')
    const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
    const response = await api(daemon.port, tokens.issue('test-run')).call(
      'GET',
      `/factories/${factory.id}/export`,
    )
    expect(response.status).toBe(403)
  } finally {
    await daemon.stop()
    await rm(home, { recursive: true, force: true })
  }
})
