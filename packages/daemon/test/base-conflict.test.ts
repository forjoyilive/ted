import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BaseConflictFound, SendBack, Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { commitToOrigin, waitUntil } from './helpers.ts'
import {
  branchHead,
  type Client,
  ctx,
  getTask,
  lines,
  start,
  useMergeHarness,
} from './merge-harness.ts'

useMergeHarness()

const commit = 'git -c user.name=T -c user.email=t@example.com'
const scratchFile = (name: string) => path.join(ctx.scratch, name)
const exists = (name: string) =>
  access(scratchFile(name)).then(
    () => true,
    () => false,
  )
const output = (name: string) => readFile(scratchFile(name), 'utf8')
const sendBacks = (client: Client, task: Task) =>
  client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
const conflicts = (client: Client, task: Task) =>
  client.ok<BaseConflictFound[]>('GET', `/tasks/${task.id}/base-conflicts`)

const work = () =>
  [
    'echo task > notes.txt',
    'git add notes.txt',
    `${commit} commit -qm work`,
    `touch '${scratchFile('worked')}'`,
  ].join('\n')
const waitForMain = () => `while [ ! -e '${scratchFile('moved')}' ]; do sleep 0.1; done`
const resolve = () =>
  [
    `sha=$(grep -o '[0-9a-f]\\{40\\}' '${scratchFile('refused.out')}' | head -1)`,
    `${commit} merge -q -X ours -m merge "$sha"`,
  ].join('\n')

async function begin(stages: string[], intake: string[] = []) {
  const client = await start({ files: { 'notes.txt': 'first\n' } })
  const script = [
    `if [ ! -e '${scratchFile('intake')}' ]; then`,
    `touch '${scratchFile('intake')}'`,
    ...intake,
    'ted outcome advance',
    ...stages,
    'fi',
  ].join('\n')
  const each = [{ run: ['sh', '-c', script] }, { endTurn: true }]
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ everyMessage: each }, ...each] }),
    factory: 'NB',
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return { client, task }
}

async function moveMain(after: string, files: Record<string, string> = { 'notes.txt': 'main\n' }) {
  await waitUntil(() => exists(after), `the Task Lead to reach ${after}`)
  await commitToOrigin(ctx.scratch, files)
  await writeFile(scratchFile('moved'), '')
}

describe('A branch that conflicts with its base', () => {
  test('stays in Work until the Task Lead resolves the conflict, with no send-back', async () => {
    const { client, task } = await begin([
      `elif [ ! -e '${scratchFile('worked')}' ]; then`,
      work(),
      waitForMain(),
      `ted outcome advance > '${scratchFile('refused.out')}' 2>&1`,
      resolve(),
      'ted outcome advance',
    ])
    await moveMain('worked')

    await waitUntil(
      async () => (await getTask(client, task.id)).stage === 'validate',
      'the Task to reach Validate',
    )
    const refused = await output('refused.out')
    expect(refused).toContain('conflicts with main, so Ted kept it in Work')
    expect(refused).toMatch(/(<<<FILES [0-9a-f-]{36}>>>)\n- notes\.txt\n\1\n/)
    expect(await sendBacks(client, task)).toEqual([])
    const thread = await lines(client, task)
    expect(thread.some((l) => l.includes('sent this back'))).toBe(false)
    expect(thread).toContain('Ted kept this Task in Work: its branch conflicts with main in 1 file')
    const found = await conflicts(client, task)
    expect(found).toMatchObject([
      { taskId: task.id, stage: 'work', base: 'main', fileCount: 1, files: ['notes.txt'] },
    ])
    expect(found[0]?.tip).toMatch(/^[0-9a-f]{40}$/)
    expect(found[0]).not.toHaveProperty('sendBackId')
  })

  test('is sent back from Validate with its cause recorded and not counted', async () => {
    const { client, task } = await begin([
      `elif [ ! -e '${scratchFile('worked')}' ]; then`,
      work(),
      'ted outcome advance',
      `elif [ ! -e '${scratchFile('sent-back')}' ]; then`,
      `touch '${scratchFile('validating')}'`,
      waitForMain(),
      `ted outcome advance > '${scratchFile('refused.out')}' 2>&1`,
      `ted outcome back --to work --cause base-conflict --findings '${scratchFile('findings.md')}' && touch '${scratchFile('sent-back')}'`,
      `elif [ ! -e '${scratchFile('resolved')}' ]; then`,
      resolve(),
      `touch '${scratchFile('resolved')}'`,
      'ted outcome advance',
    ])
    await moveMain('validating')

    const [sendBack] = await waitUntil(async () => {
      const found = await sendBacks(client, task)
      return found.length > 0 ? found : undefined
    }, 'the send-back')
    expect(sendBack).toMatchObject({
      from: 'validate',
      to: 'work',
      counted: false,
      cause: 'base-conflict',
    })
    expect(sendBack?.round).toBeUndefined()
    expect(sendBack?.findings).toMatch(/(<<<FILES [0-9a-f-]{36}>>>)\n- notes\.txt\n\1\n/)
    const repo = (await getTask(client, task.id)).repos[0]
    expect(repo?.pullRequest).toBeUndefined()
    expect(repo?.pushed).toBeUndefined()
    const refused = await output('refused.out')
    expect(refused).toContain('conflicts with main, so Ted kept it in Validate')
    expect(refused).toContain('--cause base-conflict')
    const thread = await lines(client, task)
    expect(thread).toContain('Validate sent this back to Work · base conflict')
    expect(
      thread.filter((l) => l.startsWith('Ted kept this Task in Validate: its branch conflicts')),
    ).toHaveLength(1)
    const found = await conflicts(client, task)
    expect(found.map((c) => [c.stage, c.files, c.sendBackId])).toEqual([
      ['validate', ['notes.txt'], undefined],
      ['validate', ['notes.txt'], sendBack?.id],
    ])

    await waitUntil(
      async () =>
        (await exists('resolved')) && (await getTask(client, task.id)).stage === 'validate',
      'the Task to come back to Validate',
    )
    expect(await sendBacks(client, task)).toHaveLength(1)
  })

  test('a send-back that names a conflict Ted can’t find is an ordinary send-back, on a branch Ted moved to the latest base at its first Work entry', async () => {
    const { client, task } = await begin(
      [
        `elif [ ! -e '${scratchFile('worked')}' ]; then`,
        `git rev-parse HEAD > '${scratchFile('head-at-work')}'`,
        work(),
        'ted outcome advance',
        `elif [ ! -e '${scratchFile('back.out')}' ]; then`,
        `ted outcome back --to work --cause base-conflict --findings '${scratchFile('findings.md')}' > '${scratchFile('back.out')}' 2>&1`,
      ],
      [waitForMain()],
    )
    await moveMain('intake', { 'other.txt': 'new on main\n' })

    const [sendBack] = await waitUntil(async () => {
      const found = await sendBacks(client, task)
      return found.length > 0 ? found : undefined
    }, 'the send-back')
    expect(sendBack).toMatchObject({
      from: 'validate',
      to: 'work',
      counted: true,
      round: 1,
      cause: 'review',
    })
    await waitUntil(
      async () => (await output('back.out')).includes('Ted found no conflict with the base branch'),
      'the reply to say Ted found no conflict',
    )

    expect((await output('head-at-work')).trim()).toBe(await branchHead('main'))
    const moves = (await lines(client, task)).filter((l) => l.startsWith('Ted moved '))
    expect(moves).toEqual(['Ted moved widgets to the latest main'])
    const { leadRunId } = await getTask(client, task.id)
    const heard = await readFile(path.join(ctx.home, 'runs', leadRunId ?? '', 'host.log'), 'utf8')
    expect(heard.split('Ted moved this Task’s branch to the latest main')).toHaveLength(2)
  })
})
