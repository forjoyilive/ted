import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  commitToOrigin,
  isAlive,
  makeOriginRepo,
  waitForExit,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import {
  addFactory,
  channelsOf,
  commandOf,
  ctx,
  daemonClient,
  daemonPid,
  electronPath,
  launchApp,
  onePixelPng,
  openAllTasks,
  pickFolderWith,
  setUpAppTests,
  sidebar,
  startDaemonAsApp,
  taskRow,
  ted,
} from './app-harness.ts'

setUpAppTests()

describe('TED app', () => {
  test('launching the app starts the daemon through Electron when none is running', async () => {
    await launchApp()

    expect(await commandOf(await daemonPid())).toContain(electronPath)
  })

  test('a Task created from the CLI appears in the window within a second', async () => {
    const window = await launchApp()
    await openAllTasks(window)
    await window.getByText('No Tasks yet', { exact: true }).waitFor()

    await ted('task', 'create', 'Fix login')

    await taskRow(window, 'DEV-1').filter({ hasText: 'Fix login' }).waitFor({ timeout: 1_000 })
  })

  test('a Task Lead’s Comment and the move to Done show in the window as they happen', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await commitToOrigin(path.join(ctx.home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'Halfway there'] },
        { waitFor: path.join(ctx.home, 'go') },
        { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
        { run: ['ted', 'outcome', 'advance'] },
      ],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Backlog').waitFor()

    await ted('task', 'start', 'NB-1')

    await details.getByText('Intake', { exact: true }).waitFor()
    await window.getByRole('region', { name: 'Task thread' }).getByText('Halfway there').waitFor()
    await writeFile(path.join(ctx.home, 'go'), '')
    await details.getByText('Done', { exact: true }).waitFor()
  })

  test('the thread shows event lines, and ⌘↵ sends a Comment into the Task Lead’s Run', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await commitToOrigin(path.join(ctx.home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText('You created this Task').waitFor()
    const box = thread.getByRole('textbox', { name: 'Comment' })
    expect(await box.getAttribute('placeholder')).toBe('Comment…')
    await box.fill('Keep the old export format.')
    await box.press('ControlOrMeta+Enter')
    await thread.getByText('Goes to the next Task Lead Run').waitFor()

    await ted('task', 'start', 'NB-1')

    await thread.getByText('Task moved to Intake').waitFor()
    await thread.getByText('Task Lead started · Claude').waitFor()
    await thread.getByText('Goes to the next Task Lead Run').waitFor({ state: 'detached' })
    await expect.poll(() => box.getAttribute('placeholder')).toBe('Comment to the Task Lead…')
    await thread.getByText('Not read yet').waitFor({ state: 'detached' })
    const dot = thread.locator('[data-tone="run"]').first()
    expect(await dot.textContent()).toContain('Task Lead started')

    await box.fill('Also handle the empty query.')
    await box.press('ControlOrMeta+Enter')
    await thread.getByText('Also handle the empty query.').waitFor()
    await expect.poll(() => box.inputValue()).toBe('')
    const client = await daemonClient()
    await expect
      .poll(async () => {
        const comments = await client.listComments('NB-1')
        return comments.find((c) => c.body === 'Also handle the empty query.')?.readAt !== undefined
      })
      .toBe(true)
  })

  test('files in Comments: an agent’s image and HTML show in the thread; the human drops and pastes files', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await commitToOrigin(path.join(ctx.home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await addFactory(origin, 'NB')
    const shot = path.join(ctx.home, 'shot.png')
    const report = path.join(ctx.home, 'report.html')
    await writeFile(shot, Buffer.from(onePixelPng, 'base64'))
    await writeFile(report, '<h1>Report</h1><script>document.title = "ran"</script>')
    const attach = ['ted', 'comment', '--attach', shot, '--attach', report, 'Here is the screen']
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      '--start',
      JSON.stringify({ steps: [{ run: attach }, { endTurn: true }] }),
    )
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })

    await thread.getByRole('img', { name: 'shot.png' }).waitFor()
    const frame = thread.locator('iframe[title="report.html"]')
    await frame.waitFor()
    expect(await frame.getAttribute('sandbox')).toBe('')
    await frame.contentFrame().getByRole('heading', { name: 'Report' }).waitFor()
    expect(
      await frame.evaluate((f: HTMLIFrameElement) => {
        try {
          return f.contentDocument?.title ?? 'no access'
        } catch {
          return 'no access'
        }
      }),
    ).toBe('no access')

    const box = thread.getByRole('textbox', { name: 'Comment' })
    const dropped = await window.evaluateHandle((png) => {
      const data = new DataTransfer()
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      data.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }))
      return data
    }, onePixelPng)
    await box.dispatchEvent('drop', { dataTransfer: dropped })
    await thread.getByRole('listitem').filter({ hasText: 'dropped.png' }).waitFor()
    await box.evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(new File(['pasted words'], 'notes.txt', { type: 'text/plain' }))
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
    })
    await thread.getByRole('listitem').filter({ hasText: 'notes.txt' }).waitFor()
    await box.fill('Compare with this.')
    await box.press('ControlOrMeta+Enter')

    await thread.getByRole('img', { name: 'dropped.png' }).waitFor()
    await expect.poll(() => box.inputValue()).toBe('')
    const client = await daemonClient()
    const sent = await waitUntil(async () => {
      const found = (await client.listComments('NB-1')).find((c) => c.body === 'Compare with this.')
      return found?.readAt !== undefined ? found : undefined
    }, 'the Task Lead to read the Comment')
    expect(sent.attachments?.map((a) => a.name)).toEqual(['dropped.png', 'notes.txt'])
  })

  test('the design review card shows screenshots, the video, a runnable sandboxed prototype, the Figma link and Worth your eye', async () => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, design, work]\n',
    })
    await addFactory(origin, 'NB')
    const files = path.join(ctx.home, 'design')
    await mkdir(files)
    const at = (name: string) => path.join(files, name)
    await writeFile(at('welcome.png'), Buffer.from(onePixelPng, 'base64'))
    await writeFile(at('walkthrough.webm'), 'not really a video')
    await writeFile(
      at('onboarding.html'),
      [
        '<p id="step">Step 1 of 2</p>',
        '<script>',
        'const next = document.createElement("button")',
        'next.textContent = "Next"',
        'next.addEventListener("click", () => {',
        '  document.getElementById("step").textContent = "Step 2 of 2"',
        '})',
        'document.body.append(next)',
        '</script>',
      ].join('\n'),
    )
    await writeFile(
      at('brief.md'),
      '## Goal\n\nOnboarding design: two steps\n\n## Decisions so far\n\nNone.\n\n## Current state\n\nReady.\n\n## Open questions\n\nNone.\n\n## Next step\n\nBuild.\n',
    )
    await writeFile(
      at('design.json'),
      JSON.stringify({
        summary: 'Merged the welcome and sync screens into one.',
        screenshots: [{ path: at('welcome.png'), caption: 'Step 1 · Welcome' }],
        video: { path: at('walkthrough.webm'), caption: 'Walkthrough · 0:42' },
        prototype: at('onboarding.html'),
        figma: { url: 'https://www.figma.com/design/abc/Onboarding', label: 'Onboarding v2' },
        worthYourEye: ['Skipping sign-in on step 1.', 'The notification ask waits.'],
      }),
    )
    const steps = JSON.stringify({
      steps: [
        {
          everyMessage: [
            { run: ['ted', 'brief', 'write', '--file', at('brief.md')] },
            { run: ['ted', 'outcome', 'advance', '--design', at('design.json')] },
            { endTurn: true },
          ],
        },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ],
    })
    await ted('task', 'create', '--factory', 'NB', '--start', steps)
    const window = await launchApp()
    await ctx.app?.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { opened })
      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    const card = thread.getByRole('region', { name: 'Design review' })
    await card.waitFor({ timeout: 40_000 })

    await card.getByRole('heading', { name: 'Onboarding design: two steps' }).waitFor()
    await card.getByText('Merged the welcome and sync screens into one.').waitFor()
    await card.getByRole('img', { name: 'Step 1 · Welcome' }).waitFor()
    await card.getByRole('button', { name: 'Play Walkthrough · 0:42' }).click()
    const player = window.getByRole('dialog', { name: 'Walkthrough · 0:42' })
    await player.locator('video').waitFor()
    await player.press('Escape')
    await player.waitFor({ state: 'detached' })

    const prototype = card.getByRole('region', { name: 'Prototype' })
    await prototype.getByText('onboarding.html · interactive · sandboxed').waitFor()
    const frame = prototype.locator('iframe[title="onboarding.html"]')
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts')
    const inside = frame.contentFrame()
    await inside.getByRole('button', { name: 'Next' }).click()
    await inside.getByText('Step 2 of 2').waitFor()
    expect(
      await inside.locator('body').evaluate(async () => {
        const parentReach = (() => {
          try {
            return typeof self.parent.document
          } catch {
            return 'blocked'
          }
        })()
        const fetched = await fetch(location.href).then(
          () => 'fetched',
          () => 'blocked',
        )
        return [parentReach, fetched]
      }),
    ).toEqual(['blocked', 'blocked'])
    await prototype.getByRole('button', { name: 'Restart' }).click()
    await frame.contentFrame().getByText('Step 1 of 2').waitFor()
    await prototype.getByRole('button', { name: 'Open full size ↗' }).click()
    const full = window.getByRole('dialog', { name: 'onboarding.html' })
    await full
      .locator('iframe[title="onboarding.html"]')
      .contentFrame()
      .getByText('Step 1 of 2')
      .waitFor()
    await full.press('Escape')
    await full.waitFor({ state: 'detached' })

    const figma = card.getByRole('group', { name: 'Figma' })
    await figma.getByText('Onboarding v2').waitFor()
    await figma.getByRole('button', { name: 'Open ↗' }).click()
    await expect
      .poll(() => ctx.app?.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
      .toEqual(['https://www.figma.com/design/abc/Onboarding'])

    const worth = card.getByRole('region', { name: 'Worth your eye' })
    expect(await worth.getByRole('listitem').allTextContents()).toEqual([
      'Skipping sign-in on step 1.',
      'The notification ask waits.',
    ])

    await card.getByRole('textbox', { name: 'Your answer' }).fill('Keep the Skip link.')
    await card.getByRole('button', { name: 'Approve' }).click()
    const answered = thread.getByRole('region', { name: 'Design review, answered' })
    await answered.getByText('You approved').waitFor()
    await answered.getByText('“Keep the Skip link.”').waitFor()
  }, 90_000)

  test('a Run opens in a Conversation tab with its chat, takes messages, and the tab persists', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await commitToOrigin(path.join(ctx.home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await startDaemonAsApp()
    await addFactory(origin, 'NB')
    const edit = {
      emit: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Edit',
              input: {
                file_path: 'notes.ts',
                old_string: 'by updated\n',
                new_string: 'by pinned\n',
              },
            },
          ],
        },
      },
    }
    const done = {
      emit: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
      },
    }
    const steps = [
      { everyMessage: [{ say: 'Noted.' }, { endTurn: true }] },
      edit,
      done,
      { say: 'Pinned notes now sort first.' },
      { endTurn: true },
    ]
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps }))
    await ted('task', 'start', 'NB-1')
    const client = await daemonClient()
    await expect
      .poll(async () => (await client.listTasks())[0]?.runs[0]?.state, { timeout: 20_000 })
      .toBe('idle')

    let window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: /Task Lead/ }).click()

    const chat = window.getByRole('region', { name: 'Run chat' })
    await chat.getByText('Pinned notes now sort first.').waitFor()
    await chat.getByRole('button', { name: /TED’s instructions for this Run/ }).waitFor()
    await chat.getByRole('button', { name: /^Edit/ }).click()
    await chat.getByText('by pinned').waitFor()
    expect(await chat.getByRole('button', { name: 'Restart' }).isEnabled()).toBe(true)

    const box = chat.getByRole('textbox', { name: 'Message to this Run' })
    await box.fill('Keep pinned notes in the order they were pinned.')
    await box.press('Enter')
    await chat.getByText(/to this Run only/).waitFor()
    await chat.getByText('Noted.').waitFor()
    expect(await client.listComments('NB-1')).toEqual([])

    await window.getByRole('tab', { name: 'Thread' }).click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText('You steered the Task Lead in its Conversation').waitFor()
    await thread.getByRole('button', { name: 'View message' }).click()
    await chat.getByText('Keep pinned notes in the order they were pinned.').waitFor()

    await ctx.app?.close()
    ctx.app = undefined
    window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    await window.getByRole('tab', { name: /Task Lead/ }).click()
    await window
      .getByRole('region', { name: 'Run chat' })
      .getByText('Pinned notes now sort first.')
      .waitFor()
    await window.getByRole('button', { name: 'Close Task Lead' }).click()
    await window.getByRole('tab', { name: 'Thread' }).waitFor({ state: 'detached' })
  }, 90_000)

  test('a working Run’s chat queues a message, deletes it, and interrupts the turn with ⌘↵', async () => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    const steps = [
      { everyMessage: [{ say: 'Redirected.' }, { endTurn: true }] },
      { say: 'Working on the sync layer.' },
      { waitFor: path.join(ctx.home, 'never') },
      { endTurn: true },
    ]
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps }))
    await ted('task', 'start', 'NB-1')
    const client = await daemonClient()
    await expect
      .poll(async () => (await client.listTasks())[0]?.runs[0]?.state, { timeout: 20_000 })
      .toBe('working')

    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    await window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('button', { name: /Task Lead/ })
      .click()
    const chat = window.getByRole('region', { name: 'Run chat' })
    await chat.getByText('Working on the sync layer.').waitFor()

    const box = chat.getByRole('textbox', { name: 'Message to this Run' })
    await box.fill('Leave archived notes alone.')
    await box.press('Enter')
    const queued = chat.getByText('Leave archived notes alone.')
    await chat.getByText('Queued', { exact: true }).waitFor()
    await queued.hover()
    await chat.getByRole('button', { name: 'Delete' }).click()
    await queued.waitFor({ state: 'detached' })

    await box.fill('Keep the fix in the swipe handler.')
    await box.press('Meta+Enter')
    await chat.getByText(/Interrupted by you/).waitFor()
    await chat.getByText('Redirected.').waitFor()
    expect(await client.listComments('NB-1')).toEqual([])
  }, 90_000)

  test('Runs lists a sub-agent under its Task Lead, opens its chat and stops it from its row', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    const promptFile = path.join(ctx.home, 'explore.md')
    await writeFile(
      promptFile,
      `# Explore the parser\n\n${JSON.stringify({ steps: [{ say: 'Reading src/parse.ts' }, { waitFor: path.join(ctx.home, 'never') }] })}\n`,
    )
    const command = `id=$(ted run start --prompt-file ${promptFile} | grep -o "[0-9a-f-]\\{36\\}" | head -1); ted run wait "$id"`
    const steps = [{ run: ['sh', '-c', command] }, { say: 'Sub-agent done.' }, { endTurn: true }]
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps }))
    await ted('task', 'start', 'NB-1')
    const client = await daemonClient()
    await expect
      .poll(async () => (await client.listTasks())[0]?.runs.map((r) => r.role), { timeout: 20_000 })
      .toEqual(['lead', 'sub-agent'])

    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByRole('img', { name: 'Claude Code, idle' }).waitFor()
    await thread.getByRole('img', { name: 'Claude Code, working' }).waitFor()

    const runs = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Runs' })
    await runs.getByText('2 Runs').waitFor()
    const rows = runs.getByRole('listitem')
    await expect
      .poll(() => rows.allInnerTexts())
      .toEqual([
        expect.stringMatching(/^Task Lead\s+on sub-agents\s+Claude · default model/),
        expect.stringMatching(/^Explore the parser\s+working\s+Claude · default model/),
      ])

    const sub = rows.filter({ hasText: 'Explore the parser' })
    await sub.getByRole('button', { name: /Explore the parser/ }).click()
    const chat = window.getByRole('region', { name: 'Run chat' })
    await chat.getByText('Reading src/parse.ts').waitFor()
    await window.getByRole('tab', { name: /Explore the parser/ }).waitFor()

    await sub.hover()
    await sub.getByRole('button', { name: 'Stop Run' }).click()
    await runs.getByRole('button', { name: '1 stopped Run' }).click()
    await expect
      .poll(async () => (await client.listTasks())[0]?.runs.map((r) => r.role), { timeout: 20_000 })
      .toEqual(['lead'])
    await rows.filter({ hasText: /Explore the parser\s*(just now|\d+m ago)/ }).waitFor()
  }, 90_000)

  test('the Task Lead field shows the agent, model and effort, and saves a change', async () => {
    await ted('task', 'create', 'Fix login')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'DEV-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await expect.poll(() => details.getByLabel('Agent').inputValue()).toBe('claude')

    await details.getByLabel('Agent').selectOption('codex')
    await details.getByLabel('Model').fill('gpt-6-mini')
    await details.getByLabel('Effort').selectOption('low')
    await details.getByRole('button', { name: 'Save' }).click()

    await details.getByText('Codex · gpt-6-mini · low').waitFor()

    await ted('task', 'lead', 'DEV-1', 'claude', '--model', 'opus')
    await expect.poll(() => details.getByLabel('Model').inputValue()).toBe('opus')
    expect(await details.getByLabel('Agent').inputValue()).toBe('claude')
    expect(await details.getByLabel('Effort').inputValue()).toBe('')
  })

  test('a model the plan doesn’t include shows Model unavailable until the human picks the default', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    await ted('task', 'lead', 'NB-1', 'claude', '--model', 'unavailable-9')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Backlog').waitFor()

    await ted('task', 'start', 'NB-1')

    await details.getByText('Model unavailable').waitFor()
    await window
      .getByRole('region', { name: 'Task thread' })
      .getByText(/won’t switch models on its own/)
      .waitFor()
    await details.getByRole('button', { name: 'Use the default model' }).click()
    await details.getByText('Model unavailable').waitFor({ state: 'detached' })
  })

  test('the thread header shows the status, the live activity line and the Stage track', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    const go = (n: number) => path.join(ctx.home, `go-${n}`)
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'Read the brief'] },
        { run: ['ted', 'status', 'Running Checks · Tests (2 of 3)'] },
        { waitFor: go(1) },
        { hook: 'PermissionRequest' },
        { waitFor: go(2) },
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['ted', 'comment', 'Asking the questions'] },
        { endTurn: true },
      ],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    const header = thread.locator('header')
    await header.getByText('· Not started').waitFor()

    await ted('task', 'start', 'NB-1')

    await header.getByText('Working', { exact: true }).waitFor()
    await header.getByText('· Running Checks · Tests (2 of 3)').waitFor()
    await header.getByRole('img', { name: 'Claude Code, working' }).waitFor()
    await writeFile(go(1), '')
    await header.getByText('Waiting on you', { exact: true }).waitFor()
    await writeFile(go(2), '')
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    await header.getByText('Clarify', { exact: true }).waitFor()
    expect(await header.getByText('· Running Checks').count()).toBe(0)

    const intake = header.getByRole('button', { name: 'Intake, done' })
    await intake.click()
    expect(await intake.getAttribute('aria-pressed')).toBe('true')
    await thread.getByText('Asking the questions', { exact: true }).waitFor({ state: 'detached' })
    await thread.getByText('Read the brief', { exact: true }).waitFor()
    await header.getByRole('button', { name: 'Clarify, now' }).click()
    await thread.getByText('Read the brief', { exact: true }).waitFor({ state: 'detached' })
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    await header.getByRole('button', { name: 'Clarify, now' }).click()
    await thread.getByText('Read the brief', { exact: true }).waitFor()
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    expect(
      await header.getByRole('button', { name: 'Design, not yet' }).getAttribute('aria-pressed'),
    ).toBeNull()
  })

  test('Validate’s ✓ row shows each Check’s state, the Blocking findings box, and opens the output', async () => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    const flag = path.join(ctx.home, 'failed-once')
    await commitToOrigin(parent, {
      '.gitignore': 'stub-*\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate]',
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Typecheck, run: "echo typed" }',
        `      - { name: Tests, run: "if [ -e '${flag}' ]; then echo ok; else touch '${flag}'; echo 'SearchPanel hangs'; exit 1; fi" }`,
        '      - { name: Lint, run: "echo linted" }',
        '',
      ].join('\n'),
    })
    const advance = { run: ['ted', 'outcome', 'advance'] }
    const steps = JSON.stringify({
      steps: [{ everyMessage: [{ run: ['sh', '-c', 'echo x > work.txt'] }, advance] }, advance],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })

    await ted('task', 'start', 'NB-1')

    const sentBack = thread.getByRole('listitem').filter({
      hasText: 'Validate sent this back to Work (round 1 of 5)',
    })
    await sentBack.waitFor({ timeout: 40_000 })
    const row = sentBack.getByRole('list', { name: 'Checks' })
    await row.getByRole('button', { name: '✓ Typecheck' }).waitFor()
    await row.getByRole('button', { name: '✗ Tests' }).waitFor()
    await row.getByRole('listitem').filter({ hasText: 'Lint · not run' }).waitFor()
    await sentBack
      .getByRole('region', { name: 'Blocking findings' })
      .getByText(/The Check “Tests”/)
      .waitFor()
    await thread
      .getByText(/^(Checks passed at Validate|Validate passed)$/)
      .first()
      .waitFor({ timeout: 40_000 })

    await row.getByRole('button', { name: '✗ Tests' }).click()
    const dialog = window.getByRole('dialog', { name: 'Tests output' })
    await dialog.getByText('SearchPanel hangs', { exact: true }).waitFor()
    await dialog.getByRole('tab', { name: 'Typecheck' }).click()
    await window
      .getByRole('dialog', { name: 'Typecheck output' })
      .getByText('typed', { exact: true })
      .waitFor()
    await window.getByRole('button', { name: 'Close' }).click()
    await dialog.waitFor({ state: 'detached' })
  }, 90_000)

  test('the Review sign-off card starts with the confirmation row, Review notes included', async () => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, {
      '.gitignore': 'stub-*\nn\nbrief.md\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate, review]',
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Typecheck, run: "echo typed" }',
        '',
      ].join('\n'),
    })
    const brief = [
      '## Goal',
      'Export works.',
      '## Decisions so far',
      'None.',
      '## Current state',
      'Done.',
      '## Open questions',
      'None.',
      '## Next step',
      'Merge.',
    ].join('\n\n')
    const script = [
      'n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n;',
      'case $n in',
      '2) echo x > work.txt; ted outcome advance;;',
      '3) ted outcome advance --review pass --review-notes 2 --visual pass;;',
      `4) printf '%s' '${brief}' > brief.md; ted brief write --file brief.md; ted outcome advance;;`,
      '[5-9]) :;;',
      '*) ted outcome advance;;',
      'esac',
    ].join(' ')
    const run = { run: ['sh', '-c', script] }
    const steps = JSON.stringify({ steps: [{ everyMessage: [run, { endTurn: true }] }, run] })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })

    await ted('task', 'start', 'NB-1')

    const passed = thread.getByRole('listitem').filter({ hasText: 'Validate passed' })
    await passed.waitFor({ timeout: 40_000 })
    await passed.getByRole('listitem').filter({ hasText: 'Review · 2 notes' }).waitFor()
    const card = thread.getByRole('region', { name: 'Sign-off' })
    await card.waitFor({ timeout: 40_000 })
    const row = card.getByRole('list', { name: 'Checks' })
    await row.getByRole('button', { name: '✓ Typecheck' }).waitFor()
    await row.getByRole('listitem').filter({ hasText: '✓Review · 2 notes' }).waitFor()
    await row
      .getByRole('listitem')
      .filter({ hasText: /^✓Visual$/ })
      .waitFor()
  }, 90_000)

  test('the Code section shows No worktree yet, then the branch and worktree path', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const code = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Code' })
    await code.getByText('No worktree yet').waitFor()

    await ted('task', 'start', 'NB-1')

    await code.getByText(/^ted\/nb-1/).waitFor()
    await code.getByText(path.join(ctx.home, 'worktrees', 'NB-1', 'widgets')).waitFor()
  })

  test('a missing local folder raises a Factory banner whose Locate picks a new folder', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    const folder = path.join(ctx.home, 'local')
    const moved = path.join(ctx.home, 'moved')
    await mkdir(folder)
    await addFactory(origin, 'NB', folder)
    await rm(folder, { recursive: true })
    await mkdir(moved)

    const window = await launchApp()
    await pickFolderWith(moved)
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()

    const banners = window.getByRole('region', { name: 'widgets problems' })
    await banners.getByText('Local folder for widgets not found').waitFor()
    await banners.getByRole('button', { name: 'Locate' }).click()

    await window.getByText('Local folder for widgets not found').waitFor({ state: 'detached' })
    const [factory] = await (await daemonClient()).listFactories()
    expect(factory?.localFolder).toEqual({ path: moved, found: true })
  })

  test('quitting with nothing running ends the app and TED’s background process', async () => {
    await launchApp()
    const pid = await daemonPid()
    const electronPid = ctx.app?.process().pid ?? 0

    await ctx.app?.close()
    ctx.app = undefined

    await waitForExit(pid)
    expect(isAlive(electronPid)).toBe(false)
  })

  test('the app takes over a daemon that ted started, which never learned the app’s token', async () => {
    await ted('task', 'create', 'Fix login')
    const pid = await daemonPid()

    const window = await launchApp()

    await openAllTasks(window)
    await taskRow(window, 'DEV-1').waitFor()
    expect(await daemonPid()).not.toBe(pid)
    expect(await (await daemonClient()).caller()).toMatchObject({ kind: 'app' })
  })

  test('the renderer has no Node, filesystem or store access, only the bridge', async () => {
    const window = await launchApp()

    const globals = await window.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys((globalThis as unknown as { ted: object }).ted).sort(),
    }))

    expect(globals).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridge: ['onEvent', 'request'],
    })
  })

  test.runIf(process.platform === 'linux')(
    'the daemon the app starts shares no pipes or sockets with Electron',
    async () => {
      await launchApp()
      const electronPid = ctx.app?.process().pid
      if (electronPid === undefined) throw new Error('no Electron pid')

      const electron = new Set(await channelsOf(electronPid))
      const shared = (await channelsOf(await daemonPid())).filter((c) => electron.has(c))

      expect(shared).toEqual([])
    },
  )
})
