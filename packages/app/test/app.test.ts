import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  commitToOrigin,
  makeOriginRepo,
  waitForExit,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import {
  addFactory,
  commandOf,
  ctx,
  daemonClient,
  daemonPid,
  electronPath,
  launchApp,
  onePixelPng,
  openAllTasks,
  setUpAppTests,
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

  test('the thread shows event lines; ↵ sends a Comment, ⇧↵ adds a line and ⌘↵ sends too', async () => {
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
    await box.press('Enter')
    await box.fill('   ')
    await box.press('Enter')
    expect(await box.inputValue()).toBe('   ')
    await box.fill('Keep the old export format.')
    await box.press('Shift+Enter')
    await box.pressSequentially('Same for CSV.')
    expect(await box.inputValue()).toBe('Keep the old export format.\nSame for CSV.')
    await box.press('Enter')
    await thread.getByText('Goes to the next Task Lead Run').waitFor()
    await expect.poll(() => box.inputValue()).toBe('')
    expect((await (await daemonClient()).listComments('NB-1')).map((c) => c.body)).toEqual([
      'Keep the old export format.\nSame for CSV.',
    ])

    await ted('task', 'start', 'NB-1')

    await thread.getByText('Task moved to Intake').waitFor()
    await thread.getByText('Task Lead started · Claude').waitFor()
    await thread.getByText('Goes to the next Task Lead Run').waitFor({ state: 'detached' })
    const message = thread.getByRole('textbox', { name: 'Message the Task Lead' })
    await expect.poll(() => message.getAttribute('placeholder')).toBe('Message the Task Lead…')
    await thread.getByText('Not read yet').waitFor({ state: 'detached' })
    const dot = thread.locator('[data-tone="run"]').first()
    expect(await dot.textContent()).toContain('Task Lead started')

    await message.fill('Also handle the empty query.')
    await message.press('ControlOrMeta+Enter')
    await thread
      .getByRole('paragraph')
      .filter({ hasText: 'Also handle the empty query.' })
      .waitFor()
    await expect.poll(() => message.inputValue()).toBe('')
    const client = await daemonClient()
    const runId = (await client.listTasks())[0]?.leadRunId
    if (runId === undefined) throw new Error('Task has no Lead Run')
    await expect
      .poll(async () => {
        const { items } = await client.getRunChat(runId)
        return items.find(
          (item) => item.kind === 'human' && item.text === 'Also handle the empty query.',
        )
      })
      .toMatchObject({ sent: true })
    expect((await client.listComments('NB-1')).map((c) => c.body)).toEqual([
      'Keep the old export format.\nSame for CSV.',
    ])
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
    const image = thread.getByRole('button', { name: 'View shot.png', exact: true })
    await image.click({ timeout: 3000 })
    const viewer = window.getByRole('dialog', { name: 'shot.png', exact: true })
    await viewer.getByRole('img', { name: 'shot.png', exact: true }).waitFor()
    expect(await viewer.getByRole('img').getAttribute('src')).toBe(
      `data:image/png;base64,${onePixelPng}`,
    )
    await viewer.getByRole('button', { name: 'Close', exact: true }).click()
    await viewer.waitFor({ state: 'detached' })
    await expect.poll(() => image.evaluate((el) => el === document.activeElement)).toBe(true)
    for (const key of ['Enter', 'Space']) {
      await image.press(key)
      await viewer.waitFor()
      await viewer.press('Escape')
      await viewer.waitFor({ state: 'detached' })
      await expect.poll(() => image.evaluate((el) => el === document.activeElement)).toBe(true)
    }
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

    const box = thread.getByRole('textbox', { name: 'Message the Task Lead' })
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
    await writeFile(
      at('welcome.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="1000"><rect width="100" height="1000" fill="#eeeeee"/></svg>',
    )
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
        screenshots: [{ path: at('welcome.svg'), caption: 'Step 1 · Welcome' }],
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
    const answer = thread.getByRole('region', { name: 'Answer', exact: true })
    await card.waitFor({ timeout: 40_000 })

    await card.getByRole('heading', { name: 'Onboarding design: two steps' }).waitFor()
    await card.getByText('Merged the welcome and sync screens into one.').waitFor()
    await card.getByRole('img', { name: 'Step 1 · Welcome' }).waitFor()
    const screenshot = card.getByRole('button', { name: 'View Step 1 · Welcome' })
    await expect
      .poll(() =>
        screenshot.locator('img').evaluate((el) => (el as HTMLImageElement).naturalHeight),
      )
      .toBe(1000)
    const client = await daemonClient()
    await ctx.app?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 1600),
    )
    for (const textSize of [100, 200]) {
      await client.updateSettings({ textSize, appearance: textSize === 200 ? 'dark' : 'light' })
      await expect
        .poll(() => screenshot.evaluate((el) => el.getBoundingClientRect().height))
        .toBe(108)
      await expect
        .poll(() =>
          screenshot
            .getByText('Step 1 · Welcome', { exact: true })
            .evaluate((el) => getComputedStyle(el).fontSize),
        )
        .toBe(`${(12.5 * textSize) / 100}px`)
      await mkdir(path.resolve('node_modules/.cache/ted-100/app'), { recursive: true })
      await screenshot.screenshot({
        path: path.resolve(`node_modules/.cache/ted-100/app/design-review-${textSize}.png`),
      })
    }
    await client.updateSettings({ textSize: 100, appearance: 'light' })
    await screenshot.click()
    const imageViewer = window.getByRole('dialog', { name: 'Step 1 · Welcome', exact: true })
    await imageViewer.getByRole('img', { name: 'Step 1 · Welcome' }).waitFor()
    await imageViewer.press('Escape')
    await imageViewer.waitFor({ state: 'detached' })
    await expect.poll(() => screenshot.evaluate((el) => el === document.activeElement)).toBe(true)
    await card.getByRole('button', { name: 'Play Walkthrough · 0:42' }).click()
    const player = window.getByRole('dialog', { name: 'Walkthrough · 0:42' })
    await player.locator('video').waitFor()
    await player.press('Escape')
    await player.waitFor({ state: 'detached' })

    const prototype = card.getByRole('region', { name: 'Prototype' })
    await prototype.getByText('onboarding.html · interactive · sandboxed').waitFor()
    const frame = prototype.locator('iframe[title="onboarding.html"]')
    expect(await card.evaluate((el) => el.closest('[data-scroller]') !== null)).toBe(true)
    expect(
      await card.evaluate(
        (el) =>
          [...el.querySelectorAll('*')].filter(
            (child) =>
              child.tagName !== 'TEXTAREA' &&
              /auto|scroll/.test(getComputedStyle(child).overflowY) &&
              child.scrollHeight > child.clientHeight,
          ).length,
      ),
    ).toBe(0)
    await ctx.app?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setMinimumSize(900, 400),
    )
    for (const [height, expected] of [
      [500, 360],
      [1000, 650],
      [1400, 720],
    ] as const) {
      await window.setViewportSize({ width: 1440, height })
      await expect
        .poll(() => frame.evaluate((el) => el.getBoundingClientRect().height))
        .toBe(expected)
    }
    await window.setViewportSize({ width: 1440, height: 1000 })
    await thread.getByRole('button', { name: /Jump to Design review/ }).click()
    const captures = path.resolve('node_modules/.cache/ted-152-design')
    await mkdir(captures, { recursive: true })
    await window.screenshot({ path: path.join(captures, 'native-review.png') })
    await card.getByText('Answer at the bottom of the Task ↓').scrollIntoViewIfNeeded()
    await answer.getByRole('button', { name: 'Approve', exact: true }).waitFor()
    await window.screenshot({ path: path.join(captures, 'native-review-controls.png') })
    await window.setViewportSize({ width: 1000, height: 900 })
    await thread.getByRole('button', { name: /Jump to Design review/ }).click()
    await window.screenshot({ path: path.join(captures, 'native-review-narrow.png') })
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

    expect(await card.getByRole('textbox', { name: 'Your answer' }).count()).toBe(0)
    expect(await thread.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    await answer.getByRole('textbox', { name: 'Your answer' }).fill('Keep the Skip link.')
    await answer.getByRole('button', { name: 'Approve' }).click()
    const answered = thread.getByRole('region', { name: 'Design review, answered' })
    await answered.getByText('You approved').waitFor()
    await answered.locator('blockquote').getByText('Keep the Skip link.', { exact: true }).waitFor()
  }, 90_000)

  test('a Run opens in a Conversation tab with its chat, takes messages, and the tab persists', async () => {
    const started = performance.now()
    const reached = (step: string) =>
      console.log(`Conversation tab: ${step} at ${Math.round(performance.now() - started)} ms`)
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

    reached('run-idle')

    let window = await launchApp()
    reached('first-launch-loaded')
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: /Task Lead/ }).click()

    const chat = window.getByRole('region', { name: 'Run chat' })
    await chat.getByText('Pinned notes now sort first.').waitFor()
    await chat.getByRole('button', { name: /TED’s instructions for this Run/ }).waitFor()
    await chat.getByRole('button', { name: /^Edit/ }).click()
    await chat.getByText('by pinned').waitFor()
    expect(await chat.getByRole('button', { name: 'Restart' }).count()).toBe(0)
    const taskHeader = window.getByRole('region', { name: 'Task thread' }).locator('header')
    await taskHeader.getByRole('button', { name: 'Task actions' }).click()
    expect(await window.getByRole('menuitem', { name: 'Restart', exact: true }).isEnabled()).toBe(
      true,
    )
    await chat
      .locator('[data-scroller]')
      .first()
      .evaluate((scroller) => scroller.dispatchEvent(new Event('scroll')))
    expect(await window.getByRole('menuitem', { name: 'Restart', exact: true }).count()).toBe(1)
    const runId = (await client.listTasks())[0]?.leadRunId
    if (runId === undefined) throw new Error('Task has no Lead Run')
    const { run } = await client.getRun(runId)
    await writeFile(
      path.join(ctx.home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ say: 'Noted.' }, { endTurn: true }] }),
    )
    await window.getByRole('menuitem', { name: 'Restart', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readFile(path.join(run.cwd, 'stub-starts.jsonl'), 'utf8')).trim().split('\n')
            .length,
      )
      .toBe(2)
    expect((await client.listTasks())[0]?.leadRunId).toBe(runId)
    await window
      .getByRole('menuitem', { name: 'Restart', exact: true })
      .waitFor({ state: 'detached' })
    await taskHeader.getByRole('button', { name: 'Task actions' }).click()
    await expect
      .poll(() => window.getByRole('menuitem', { name: 'Restart', exact: true }).isEnabled())
      .toBe(true)
    await window.keyboard.press('Escape')

    const box = chat.getByRole('textbox', { name: 'Message the Task Lead' })
    await box.fill('Keep pinned notes in the order they were pinned.')
    await box.press('Enter')
    await chat.getByText(/to the Task Lead/).waitFor()
    await chat.getByText('Noted.').waitFor()
    expect(await client.listComments('NB-1')).toEqual([])

    await window.getByRole('tab', { name: 'Task Lead' }).click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText('You steered the Task Lead in its Conversation').waitFor()
    await thread.getByRole('button', { name: 'View message' }).click()
    await chat.getByText('Keep pinned notes in the order they were pinned.').waitFor()
    reached('message-delivered')

    const oldDaemon = await daemonPid()
    reached('quit-start')
    await ctx.app?.close()
    ctx.app = undefined
    reached('quit-finished')
    await waitForExit(oldDaemon)
    reached('old-daemon-exited')
    window = await launchApp()
    reached('second-launch-loaded')
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    await window.getByRole('tab', { name: /Task Lead/ }).click()
    await window
      .getByRole('region', { name: 'Run chat' })
      .getByText('Pinned notes now sort first.')
      .waitFor()
    expect(await window.getByRole('tab', { name: 'Task Lead', exact: true }).count()).toBe(1)
    expect(await window.getByRole('tab', { name: 'Thread', exact: true }).count()).toBe(0)
  }, 90_000)

  test('the thread opens at its newest messages, keeps its place across tabs, and never yanks a scrolled-up reader', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await commitToOrigin(path.join(ctx.home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await addFactory(origin, 'NB')
    const steps = [{ say: 'Started.' }, { waitFor: path.join(ctx.home, 'never') }]
    await ted('task', 'create', '--factory', 'NB', '--start', JSON.stringify({ steps }))
    const client = await daemonClient()
    for (let n = 1; n <= 12; n++) {
      const lines = Array.from({ length: 6 }, (_, i) => `Detail ${n}.${i} of the sync work.`)
      await client.postComment('NB-1', [`Note ${n}`, ...lines].join('\n\n'))
    }
    await expect
      .poll(async () => (await client.listTasks())[0]?.runs[0]?.state, { timeout: 20_000 })
      .toBe('working')

    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    const scroller = thread.locator('[data-scroller]')
    await scroller.getByText(/Detail 12\.5 of/).waitFor()
    const gap = () =>
      scroller.evaluate((e) => Math.round(e.scrollHeight - e.scrollTop - e.clientHeight))
    const top = () => scroller.evaluate((e) => Math.round(e.scrollTop))
    await expect.poll(gap).toBeLessThan(2)
    expect(await top()).toBeGreaterThan(200)

    await scroller.evaluate((e) => {
      e.scrollTop = 150
    })
    await expect.poll(top).toBe(150)
    await window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('button', { name: /Task Lead/ })
      .click()
    await window.getByRole('region', { name: 'Run chat' }).waitFor()
    await window.getByRole('tab', { name: 'Task Lead' }).click()
    await scroller.getByText(/Detail 12\.5 of/).waitFor()
    await expect.poll(top).toBe(150)

    await client.postComment('NB-1', 'The newest note')
    await scroller.getByText('The newest note').waitFor()
    expect(await top()).toBe(150)
    const jump = thread.getByRole('button', { name: 'New messages ↓' })
    await jump.click()
    await expect.poll(gap).toBeLessThan(2)
    await jump.waitFor({ state: 'detached' })

    await window.getByRole('tab', { name: /Task Lead/ }).click()
    await window.getByRole('tab', { name: 'Task Lead' }).click()
    await scroller.getByText('The newest note').waitFor()
    await expect.poll(gap).toBeLessThan(2)
  }, 90_000)
})
