import type { InboxItem, Task, TaskGates } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { waitUntil } from './helpers.ts'
import {
  approve,
  type Client,
  getTask,
  lines,
  merges,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import { eventWait } from './support/event-wait.ts'
import { ci, comments } from './support/merge-gate.ts'

useMergeHarness()

const mergeSignoff = (client: Client, task: Task) =>
  eventWait(
    client.subscribe,
    async () => {
      const items = await client.ok<InboxItem[]>('GET', '/inbox')
      return items.find(
        (i) => i.task.id === task.id && i.request.kind === 'signoff' && i.request.stage === 'merge',
      )?.request
    },
    'the Merge sign-off',
  )

describe('Merge sign-off', () => {
  test('Ted posts the Merge sign-off only once CI passes, Autopilot approves the waiting request when turned on, and Merge merges at once', async () => {
    const client = await start({
      files: ci,
      workflow: ['stages:', '  merge: { gate: true }'],
      merge: { title: 'Edit notes offline', checks: [{ name: 'test', status: 'IN_PROGRESS' }] },
    })
    const { task, signoff } = await toSignoff(client)
    expect(signoff.gate?.approveLabel).toBe('Approve')
    await approve(client, signoff)

    const waiting = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.stage === 'merge' && current.status?.kind === 'waiting-for-github'
        ? current
        : undefined
    }, 'Waiting for CI')
    expect(waiting.status).toEqual({ kind: 'waiting-for-github', on: 'ci' })
    expect((await comments(client, task)).filter((c) => c.stage === 'merge')).toEqual([])

    await setGh({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
    const card = await mergeSignoff(client, task)
    const name = waiting.repos[0]?.name ?? ''
    expect(card.author).toEqual({ kind: 'ted' })
    expect(card.title).toBe('Ready to merge: PR #7')
    expect(card.gate).toEqual({
      approveLabel: 'Merge',
      pullRequests: [
        {
          name,
          repo: 'acme/widgets',
          number: 7,
          title: 'Edit notes offline',
          url: waiting.repos[0]?.pullRequest?.url,
          checks: { passed: 1, failed: 0, pending: 0 },
          mergeable: true,
          method: 'squash',
          reviewMissing: false,
        },
      ],
      changes: { since: signoff.id, repos: [{ name, files: [] }] },
    })
    expect(await merges()).toEqual([])

    await client.ok('PATCH', '/settings', { overnightMode: true })
    await waitForStage(client, task, 'done')
    const automatic = (await comments(client, task)).find((c) => c.id === card.id)
    expect(automatic).toMatchObject({ autopilotAnswered: true, answer: { kind: 'approved' } })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await merges()).toHaveLength(1)
    expect(await lines(client, task)).not.toContain(
      'Autopilot is on, so Ted skipped the Merge Sign-Off',
    )
  })

  test('Autopilot merges without the Merge sign-off, and turning it off does not bring the sign-off back', async () => {
    const client = await start({
      files: ci,
      workflow: ['stages:', '  merge: { gate: true }'],
      merge: { checks: [{ name: 'test', status: 'IN_PROGRESS' }] },
    })
    const { task } = await toSignoff(client)
    await client.ok('PATCH', '/settings', { overnightMode: true })
    await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.stage === 'merge' && current.status?.kind === 'waiting-for-github'
    }, 'Waiting for CI')
    expect(await lines(client, task)).toContain(
      'Autopilot is on, so Ted skipped the Merge Sign-Off',
    )
    await client.ok('PATCH', '/settings', { overnightMode: false })
    const { rows } = await client.ok<TaskGates>('GET', `/tasks/${task.id}/gates`)
    expect(rows.find((r) => r.stage === 'merge')).toMatchObject({
      inherited: true,
      effective: false,
      overnight: true,
    })
    expect(await merges()).toEqual([])

    await setGh({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await merges()).toHaveLength(1)
    expect((await comments(client, task)).filter((c) => c.stage === 'merge')).toEqual([])
  })

  test('with no Review sign-off, the Merge sign-off carries the brief', async () => {
    const client = await start({
      workflow: ['stages:', '  review: { gate: false }', '  merge: { gate: true }'],
    })
    const { task, signoff } = await toSignoff(client)
    expect(signoff.stage).toBe('merge')
    expect(signoff.author).toEqual({ kind: 'ted' })
    expect(signoff.body).toContain('Let notes be edited offline.')
    expect(signoff.gate?.changes).toBeUndefined()
    expect(signoff.gate?.pullRequests?.[0]?.checks).toEqual({ passed: 0, failed: 0, pending: 0 })
    expect(await merges()).toEqual([])
    await approve(client, signoff)
    await waitForStage(client, task, 'done')
  })
})

test('a Task can turn off the inherited Merge sign-off before entry, while CI still controls merging', async () => {
  const client = await start({
    files: ci,
    workflow: ['stages:', '  merge: { gate: true }'],
    merge: { checks: [{ name: 'test', status: 'IN_PROGRESS' }] },
  })
  const { task, signoff } = await toSignoff(client)
  expect(signoff.stage).toBe('review')
  const route = `/tasks/${task.id}/gates`
  const before = await client.ok<TaskGates>('GET', route)
  await client.ok('PUT', route, { overrides: { merge: false }, revision: before.revision })
  await approve(client, signoff)
  await waitForStage(client, task, 'merge')
  await waitUntil(
    async () => (await getTask(client, task.id)).status?.kind === 'waiting-for-github',
    'CI to hold merging',
  )
  expect(await merges()).toEqual([])
  const merging = await client.ok<TaskGates>('GET', route)
  expect(merging.rows.find((row) => row.stage === 'merge')).toMatchObject({
    effective: false,
    locked: 'Merge has started',
  })
  expect(
    (await client.call('PUT', route, { overrides: { merge: true }, revision: merging.revision }))
      .status,
  ).toBe(409)
  await setGh({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  await waitForStage(client, task, 'done')
  expect(await merges()).toHaveLength(1)
  expect(
    (await comments(client, task)).some((comment) => comment.gate && comment.stage === 'merge'),
  ).toBe(false)
  const done = await client.ok<TaskGates>('GET', route)
  expect(done.rows.every((row) => !!row.locked)).toBe(true)
})
