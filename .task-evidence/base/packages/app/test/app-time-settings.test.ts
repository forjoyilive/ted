import { expect, test } from 'vitest'
import { daemonClient, launchApp, openSettings, setUpAppTests, sidebar } from './app-harness.ts'

setUpAppTests()

test('General time preferences apply immediately and survive reloading the app', async () => {
  const window = await launchApp()
  await openSettings(window)
  const format = window.getByRole('radiogroup', { name: 'Time format' })
  expect(await format.getByRole('radio', { name: 'System', exact: true }).isChecked()).toBe(true)
  expect(await window.getByRole('combobox', { name: 'Time zone', exact: true }).inputValue()).toBe(
    'system',
  )
  await format.getByText('12-hour', { exact: true }).click()
  await window.getByRole('combobox', { name: 'Time zone', exact: true }).selectOption('Asia/Tokyo')
  await expect
    .poll(() => window.locator('output', { hasText: ':' }).textContent())
    .toMatch(/\d{2}:\d{2} [ap]m/i)
  await window.getByText('Fixed zone · Asia/Tokyo', { exact: true }).waitFor()
  const ted = await daemonClient()
  await expect
    .poll(() => ted.getSettings())
    .toMatchObject({ timeFormat: '12-hour', timeZone: 'Asia/Tokyo' })
  await format.getByText('24-hour', { exact: true }).click()
  await expect
    .poll(() => window.locator('output', { hasText: ':' }).textContent())
    .toMatch(/^\d{2}:\d{2}$/)
  await window.reload()
  await sidebar(window).waitFor()
  await openSettings(window)
  expect(await window.getByRole('radio', { name: '24-hour', exact: true }).isChecked()).toBe(true)
  expect(await window.getByRole('combobox', { name: 'Time zone', exact: true }).inputValue()).toBe(
    'Asia/Tokyo',
  )
  await window.getByRole('combobox', { name: 'Time zone', exact: true }).selectOption('system')
  await window.getByText(/^Following system · /).waitFor()
})
