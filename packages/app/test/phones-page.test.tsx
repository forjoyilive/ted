// @vitest-environment jsdom
import type { PairedPhone, PhonePairingState } from '@ted/protocol'
import { render, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { PhonesPage } from '../src/renderer/settings/PhonesPage.tsx'
import { bridge, user } from './support/component.ts'

const pairing = 'AAECAwQFBgcICQoLDA0ODw'
const link = 'ted-pair:eyJ2IjoxfQ'

test('empty page, pair dialog with QR code and countdown, Copy code in Ted Dev, then approve', async () => {
  let current: PhonePairingState = { state: 'none' }
  let phones: PairedPhone[] = []
  const expiresAt = Date.now() + 272_000
  const a = bridge({
    pairedPhones: () => ({ phones, pairAgain: false }),
    createPhonePairing: () => {
      current = { state: 'live', pairing, link, expiresAt, edition: 'dev' }
      return { pairing, link, expiresAt, edition: 'dev' }
    },
    currentPhonePairing: () => current,
    cancelPhonePairing: () => {
      current = { state: 'none' }
      return current
    },
    copyText: () => undefined,
    approvePhonePairing: () => {
      current = { state: 'approved', pairing, phoneName: 'iPhone 16' }
      phones = [{ id: 'phone-1', name: 'iPhone 16', pairedAt: '2026-11-12T09:00:00.000Z' }]
      return current
    },
  })
  render(<PhonesPage />)
  await screen.findByText('No phones paired yet')
  expect(
    screen.getByText('Choose Pair a phone, then scan the code with Ted on your iPhone.'),
  ).toBeTruthy()

  await user().click(screen.getByRole('button', { name: 'Pair a phone…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Pair a phone' })
  expect(within(dialog).getByText('Open Ted on your iPhone and scan this code.')).toBeTruthy()
  expect(within(dialog).getByRole('img', { name: 'Pairing QR code' })).toBeTruthy()
  expect(within(dialog).getByText(/Works once · 4:3\d left/)).toBeTruthy()
  await user().click(within(dialog).getByRole('button', { name: 'Copy code' }))
  expect(a.request).toHaveBeenCalledWith('copyText', link)

  current = { state: 'waiting', pairing, link, expiresAt, phoneName: 'iPhone 16', code: '482913' }
  const approve = await screen.findByRole(
    'dialog',
    { name: 'Approve “iPhone 16”?' },
    { timeout: 3000 },
  )
  expect(within(approve).getByText('482 913')).toBeTruthy()
  expect(
    within(approve).getByText(
      'A phone named “iPhone 16” scanned the code. Approve it only if it’s your phone and it shows the same code.',
    ),
  ).toBeTruthy()
  await user().click(within(approve).getByRole('button', { name: 'Approve' }))
  await waitFor(() => expect(a.request).toHaveBeenCalledWith('approvePhonePairing', { pairing }))
  a.emit({ type: 'phones-changed' })
  await screen.findByText('iPhone 16')
  expect(screen.getByText(/^Paired 12 November$/)).toBeTruthy()
  expect(
    screen.getByText(
      'Each phone pairs with one Mac. Removing a phone stops its requests and notifications at once.',
    ),
  ).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText('Pair your phones again.')).toBeNull()
})

test('after a relay reset the page asks to pair again; an expired code offers Make a new code, and Ted shows no Copy code outside Ted Dev', async () => {
  let current: PhonePairingState = { state: 'expired', pairing }
  let made = 0
  bridge({
    pairedPhones: () => ({ phones: [], pairAgain: true }),
    createPhonePairing: () => {
      made += 1
      const expiresAt = Date.now() + 300_000
      current = { state: 'live', pairing, link, expiresAt, edition: 'release' }
      return { pairing, link, expiresAt, edition: 'release' }
    },
    currentPhonePairing: () => current,
    cancelPhonePairing: () => ({ state: 'none' }),
  })
  render(<PhonesPage />)
  expect(await screen.findByText('Pair your phones again.')).toBeTruthy()
  await user().click(await screen.findByRole('button', { name: 'Pair a phone…' }))
  expect(
    within(await screen.findByRole('dialog')).queryByRole('button', { name: 'Copy code' }),
  ).toBeNull()
  current = { state: 'expired', pairing }
  const dialog = await screen.findByText(
    'This code has expired. Make a new one to pair a phone.',
    undefined,
    {
      timeout: 3000,
    },
  )
  const expired = dialog.closest('dialog')
  if (!expired) throw new Error('no dialog')
  expect(within(expired).getByText('Expired')).toBeTruthy()
  await user().click(within(expired).getByRole('button', { name: 'Make a new code' }))
  await waitFor(() => expect(made).toBe(2))
  await user().click(within(expired).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test('paired phones list when they were last reached, and Remove… asks first', async () => {
  let phones: PairedPhone[] = [
    {
      id: 'phone-1',
      name: 'iPhone 16',
      pairedAt: '2026-11-12T09:00:00.000Z',
      lastReachedAt: new Date().toISOString(),
    },
    {
      id: 'phone-2',
      name: 'iPhone 13 mini',
      pairedAt: '2026-10-02T09:00:00.000Z',
      lastReachedAt: new Date(Date.now() - 21 * 24 * 60 * 60_000).toISOString(),
    },
  ]
  const a = bridge({
    pairedPhones: () => ({ phones, pairAgain: false }),
    removePhone: (id) => {
      phones = phones.filter((phone) => phone.id !== id)
      return { phones }
    },
  })
  render(<PhonesPage />)
  await screen.findByText('iPhone 13 mini')
  expect(screen.getByText(/^Paired 12 November · last reached \d{1,2}[:.]\d\d/)).toBeTruthy()
  expect(screen.getByText('Paired 2 October · last reached 3 weeks ago')).toBeTruthy()
  const [first] = screen.getAllByRole('button', { name: 'Remove…' })
  if (!first) throw new Error('no Remove button')
  await user().click(first)
  const confirm = await screen.findByRole('dialog', { name: 'Remove “iPhone 16”?' })
  expect(
    within(confirm).getByText(
      'It stops getting requests and notifications at once. To use it again, pair it again.',
    ),
  ).toBeTruthy()
  await user().click(within(confirm).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(a.request).toHaveBeenCalledWith('removePhone', 'phone-1'))
  await waitFor(() => expect(screen.queryByText('iPhone 16')).toBeNull())
})
