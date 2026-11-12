import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
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

test('chat images close on surrounding space and backdrop clicks, keeping image clicks and keyboard dismissal', async () => {
  const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
  await addFactory(origin, 'NB')
  const client = await daemonClient()
  const wide = await client.uploadAttachment(
    { name: 'wide.svg', mediaType: 'image/svg+xml' },
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="120"><rect width="100%" height="100%" fill="steelblue"/></svg>',
    ),
  )
  await client.createTask({
    factory: 'NB',
    title: 'View attachments',
    attachments: [wide],
    start: false,
  })
  const shapes = [
    { name: 'portrait.svg', width: 400, height: 1200 },
    { name: 'landscape.svg', width: 1200, height: 400 },
  ]
  const attachments = []
  for (const shape of shapes) {
    attachments.push(
      await client.uploadAttachment(
        { name: shape.name, mediaType: 'image/svg+xml' },
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${shape.width}" height="${shape.height}"><rect width="100%" height="100%" fill="steelblue"/></svg>`,
        ),
      ),
    )
  }
  await client.postComment('NB-1', { body: 'Image previews', attachments })
  const page = await launchApp()
  await page.emulateMedia({ colorScheme: 'light' })
  await openAllTasks(page)
  await taskRow(page, 'NB-1').click()
  const thread = page.getByRole('region', { name: 'Task thread' })
  const thumbnail = page
    .getByRole('region', { name: 'Original request' })
    .getByRole('button', { name: 'View wide.svg', exact: true })
  await thumbnail.click()
  const described = page.getByRole('dialog', { name: 'wide.svg', exact: true })
  const large = described.getByRole('img', { name: 'wide.svg' })
  await expect
    .poll(async () => {
      const panel = await described.boundingBox()
      const shown = await large.boundingBox()
      return panel && shown ? shown.width / panel.width : 0
    })
    .toBeGreaterThan(0.9)
  expect((await thumbnail.locator('img').boundingBox())?.width).toBeLessThanOrEqual(302)
  await described.press('Escape')
  await described.waitFor({ state: 'detached' })
  for (const shape of shapes) {
    const opener = thread.getByRole('button', { name: `View ${shape.name}`, exact: true })
    const viewer = page.getByRole('dialog', { name: shape.name, exact: true })
    await opener.click()
    const image = viewer.getByRole('img', { name: shape.name })
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(shape.width)
    if (shape.name === 'portrait.svg') {
      await viewer.getByRole('button', { name: 'Next image', exact: true }).click()
      const landscape = page.getByRole('dialog', { name: 'landscape.svg', exact: true })
      await landscape.getByRole('img', { name: 'landscape.svg' }).waitFor()
      expect(await landscape.getByRole('status').textContent()).toBe('2 of 2')
      await page.keyboard.press('ArrowRight')
      await image.waitFor()
      expect(await viewer.getByRole('status').textContent()).toBe('1 of 2')
      await page.keyboard.press('ArrowLeft')
      await landscape.waitFor()
      await landscape.getByRole('button', { name: 'Previous image', exact: true }).click()
      await expect
        .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBe(shape.width)
    }
    await image.click()
    expect(await viewer.isVisible()).toBe(true)
    const box = await viewer.boundingBox()
    if (!box) throw new Error('Image viewer is missing')
    await page.mouse.click(
      shape.width < shape.height ? box.x + 40 : box.x + box.width / 2,
      shape.width < shape.height ? box.y + box.height / 2 : box.y + box.height - 40,
    )
    await viewer.waitFor({ state: 'detached', timeout: 3000 })
    await expect.poll(() => opener.evaluate((el) => el === document.activeElement)).toBe(true)
    await opener.click()
    await viewer.waitFor()
    await page.mouse.click(5, 5)
    await viewer.waitFor({ state: 'detached', timeout: 3000 })
    await expect.poll(() => opener.evaluate((el) => el === document.activeElement)).toBe(true)
    for (const key of ['Enter', 'Space']) {
      await opener.press(key)
      await viewer.waitFor()
      if (shape.name === 'portrait.svg' && key === 'Enter') {
        const folder = path.resolve('node_modules/.cache/image-viewer-evidence')
        await mkdir(folder, { recursive: true })
        await page.screenshot({ path: path.join(folder, 'portrait.png') })
      }
      if (key === 'Enter') await viewer.press('Escape')
      else await viewer.getByRole('button', { name: 'Close', exact: true }).click()
      await viewer.waitFor({ state: 'detached' })
      await expect.poll(() => opener.evaluate((el) => el === document.activeElement)).toBe(true)
    }
  }
})
