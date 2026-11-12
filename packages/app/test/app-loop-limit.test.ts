import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { commitToOrigin, makeOriginRepo, stubCodexPath } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  setUpAppTests,
  taskRow,
} from './app-harness.ts'

setUpAppTests()

test('a concise limit question keeps the complete Findings in history', async () => {
  const originDir = path.join(ctx.home, 'origin')
  const origin = await makeOriginRepo(originDir)
  await commitToOrigin(originDir, {
    '.ted/workflow.yaml':
      'version: 1\norder: [intake, work, validate, review]\nstages:\n  validate: { max_back: 1, loop_check: 1 }\n',
  })
  ctx.extraEnv.TED_CODEX_BIN = stubCodexPath
  const findings = path.join(ctx.home, 'findings.md')
  const evidence = 'The export button does nothing when the selected folder has been removed.'
  const script = [
    'f="n-$TED_RUN"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f";',
    `if [ $n -ge 3 ] && [ $((n % 2)) -eq 1 ]; then ted outcome back --to work --findings "${findings}";`,
    'else ted outcome advance; fi',
  ].join(' ')
  const run = { run: ['sh', '-c', script] }
  await writeFile(
    findings,
    `${evidence}\n\n${JSON.stringify({ steps: [run, { say: 'Earlier fixes held. One export edge case remains.\nVerdict: converging' }, { endTurn: true }] })}\n`,
  )
  await addFactory(origin, 'NB')
  const client = await daemonClient()
  await client.createTask({
    factory: 'NB',
    title: JSON.stringify({
      steps: [{ everyMessage: [run, { endTurn: true }] }, run, { endTurn: true }],
    }),
  })
  const window = await launchApp()
  await client.startTask('NB-1')
  await expect
    .poll(async () => (await client.listComments('NB-1')).some((c) => c.kind === 'question'), {
      timeout: 40_000,
    })
    .toBe(true)
  await client.editTask('NB-1', { title: 'Improve export reliability' })
  await openAllTasks(window)
  await taskRow(window, 'NB-1').click()
  const thread = window.getByRole('region', { name: 'Task thread' })
  const card = thread.getByRole('region', { name: 'Question', exact: true })
  await card.getByText(/Making progress, but Validate/).waitFor()
  expect(await card.textContent()).not.toContain(evidence)
  expect(await card.textContent()).toContain('Recommended: Try again')
  expect(await card.textContent()).toContain('leaves the Findings open')
  await card.getByRole('radio', { name: 'Try again', exact: true }).waitFor()
  await card.getByRole('radio', { name: 'Move to Review anyway', exact: true }).waitFor()
  expect(await card.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true)
  await thread.getByText('Validate wants to send this Task back to Work', { exact: true }).waitFor()
  expect(await thread.getByRole('region', { name: 'Blocking findings' }).allTextContents()).toEqual(
    expect.arrayContaining([expect.stringContaining(evidence)]),
  )

  const captures = process.env.TED_MESSAGE_CAPTURES
  if (captures) {
    await mkdir(captures, { recursive: true })
    await window.setViewportSize({ width: 1200, height: 1000 })
    for (const colorScheme of ['light', 'dark'] as const) {
      await window.emulateMedia({ colorScheme })
      await card.scrollIntoViewIfNeeded()
      await window.screenshot({ path: path.join(captures, `limit-${colorScheme}.png`) })
    }
  }
})
