import { writeFile } from 'node:fs/promises'
import {
  type MacReply,
  type PhoneRequestDetail,
  parsePhoneRequestBody,
  phoneReplyBodyMax,
  readDaemonInfo,
} from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'
import type { TedStore } from '../src/store/index.ts'
import { appClient } from './helpers.ts'
import {
  ctx,
  getTask,
  reviewSignoff,
  signoffWaitMs,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import { memoryKeyrings, type RelayStub, startRelayStub, TestPhone } from './support/phone-relay.ts'

useMergeHarness()

const frameLimit = 65_536
let relay: RelayStub | undefined
const phones: TestPhone[] = []

afterEach(async () => {
  for (const phone of phones.splice(0)) phone.close()
  await relay?.close()
  relay = undefined
})

function detailOf(reply: MacReply): PhoneRequestDetail {
  if (!reply.ok) throw new Error(`request failed: ${reply.error.code}`)
  return parsePhoneRequestBody(reply.body).request
}

test('a sign-off answered from the phone: the brief shows and is cut to fit, request changes leaves the drafts, and approve merges', async () => {
  relay = await startRelayStub()
  let store: TedStore | undefined
  const client = await start({
    daemon: {
      phones: {
        keyrings: memoryKeyrings().keyrings,
        relayUrl: relay.url,
        macName: async () => 'Sign-off Mac',
        relayDelaysMs: [50],
      },
      wrap: {
        store: (opened) => {
          store = opened
          return opened
        },
      },
    },
  })
  const info = await readDaemonInfo(ctx.home)
  if (!info || !ctx.daemon || !store) throw new Error('no daemon')
  const app = appClient(info, ctx.daemon.appToken)
  const offer = await app.createPhonePairing()
  const phone = new TestPhone(offer.link)
  phones.push(phone)
  await phone.online
  await phone.pair('Sign-off Phone')
  await app.approvePhonePairing({ pairing: phone.link.pairing })
  await phone.approved()

  const { task, signoff } = await toSignoff(client)
  const first = detailOf(await phone.request(signoff.id))
  expect(first).toMatchObject({
    source: 'task',
    kind: 'signoff',
    ref: task.displayId,
    onPhone: true,
    form: { type: 'signoff', stage: 'Review', cut: false },
  })
  expect(first.form.type === 'signoff' && first.form.brief).toContain(
    'Let notes be edited offline.',
  )

  const repo = (await getTask(client, task.id)).repos[0]?.repo ?? ''
  const draft = store.draftLineComment({
    taskId: task.id,
    repo,
    path: 'work.txt',
    side: 'new',
    start: 1,
    end: 1,
    commit: 'HEAD',
    quoted: [],
    body: 'Rename this file',
  })
  expect(
    await phone.answer(signoff.id, { action: 'request-changes', text: 'A bigger button' }),
  ).toMatchObject({ ok: true, body: { answered: true } })
  const changed = store.getComment(signoff.id)
  expect(changed?.answer).toMatchObject({ kind: 'changes-requested', text: 'A bigger button' })
  expect(changed?.lineComments ?? []).toEqual([])
  expect(store.lineCommentDrafts(task.id).map((c) => c.id)).toContain(draft.id)
  expect(changed?.autopilotAnswered).toBe(false)

  const again = await reviewSignoff(client, task.id)
  expect(again.id).not.toBe(signoff.id)
  const huge = `## Goal\n\n${'Notes can be edited offline ✓ “quoted” \\ path\n'.repeat(4_000)}`
  store.writeBrief({ taskId: task.id, text: huge })
  const before = relay.frames.length
  const reply = await phone.request(again.id)
  const cut = detailOf(reply)
  expect(cut.form).toMatchObject({ type: 'signoff', stage: 'Review', cut: true })
  expect(cut.form.type === 'signoff' && cut.form.brief.startsWith('## Goal')).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(reply.ok && reply.body))).toBeLessThanOrEqual(
    phoneReplyBodyMax,
  )
  const sent = relay.frames.slice(before).filter((frame) => frame.from === 'relay')
  expect(sent.length).toBeGreaterThan(0)
  for (const frame of sent) expect(Buffer.byteLength(frame.text)).toBeLessThan(frameLimit)

  await writeFile(client.mergingFile, '')
  expect(await phone.answer(again.id, { action: 'approve' })).toMatchObject({ ok: true })
  expect(store.getComment(again.id)?.answer).toMatchObject({ kind: 'approved' })
  await waitForStage(client, task, 'done', signoffWaitMs)
}, 180_000)
