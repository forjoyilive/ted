// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { MachinesPage } from '../src/renderer/settings/MachinesPage.tsx'
import { WorkerWindow } from '../src/renderer/WorkerWindow.tsx'
import { bridge, user } from './support/component.ts'

const readiness = {
  observedAt: new Date().toISOString(),
  platform: 'darwin',
  arch: 'arm64',
  version: '0.1',
  agents: [{ name: 'codex', detected: true, modelAccess: 'unknown', reason: 'Unverified' }],
  sandbox: { available: true, reason: 'Probe passed' },
  freeBytes: 2e11,
  loadPerCore: 0.2,
  capacity: 2,
}
const pending = {
  id: 'pending-1',
  name: 'Mini',
  publicKey: 'a'.repeat(64),
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  readiness,
}

test('pairing review starts with no repo grants, requires identity confirmation, and explains the same-network flow', async () => {
  let rows = [pending]
  const a = bridge({
    executionMachines: () => ({
      addresses: [{ name: 'Wi-Fi', address: '192.168.1.2' }],
      pending: rows,
      machines: [],
      repos: [{ factoryId: 'factory-1', factoryName: 'TED', repo: 'owner/repo' }],
    }),
    approveExecution: () => {
      rows = []
      return { id: 'pending-1' }
    },
  })
  render(<MachinesPage />)
  await screen.findByText('Mini · Waiting for approval')
  expect(screen.getByText(/both Macs must be on the same local network/)).toBeTruthy()
  const approve = screen.getByRole<HTMLButtonElement>('button', { name: 'Approve pairing' })
  expect(approve.disabled).toBe(true)
  await user().click(screen.getByRole('checkbox', { name: 'TED / owner/repo' }))
  expect(approve.disabled).toBe(true)
  await user().click(
    screen.getByRole('checkbox', { name: 'I checked the worker identity on the other Mac.' }),
  )
  expect(approve.disabled).toBe(false)
  await user().click(approve)
  await waitFor(() =>
    expect(a.request).toHaveBeenCalledWith('approveExecution', {
      id: 'pending-1',
      scopes: [{ factoryId: 'factory-1', repo: 'owner/repo' }],
    }),
  )
  const summary = screen.getByText('How connecting Macs works')
  summary.focus()
  await user().keyboard('{Enter}')
  expect(summary.closest('details')?.open).toBe(true)
})

test('worker connection errors open help and clear enrollment details; the worker has no approval controls', async () => {
  const a = bridge({
    workerStatus: () => ({ state: 'stopped', message: 'Stopped', scopes: [] }),
    workerPair: () => {
      throw new Error('Connection refused')
    },
  })
  render(<WorkerWindow />)
  await screen.findByText('Stopped')
  expect(screen.queryByRole('button', { name: 'Approve pairing' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Pairing details'), {
    target: { value: 'private details' },
  })
  await user().click(screen.getByRole('button', { name: 'Connect to controller' }))
  await screen.findByRole('alert')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Pairing details' }).value).toBe(
    '',
  )
  await user().click(
    within(screen.getByRole('alert')).getByRole('button', { name: 'Connection help' }),
  )
  expect(screen.getByText('Having trouble connecting?').closest('details')?.open).toBe(true)
  expect(a.request).toHaveBeenCalledWith('workerPair', { details: 'private details', capacity: 2 })
})

test('controller revocation needs confirmation and labels offline readiness as stale', async () => {
  const a = bridge({
    executionMachines: () => ({
      addresses: [],
      pending: [],
      repos: [],
      machines: [
        {
          id: 'grant-1',
          name: 'Mini',
          publicKey: 'a'.repeat(64),
          certificateId: 'b'.repeat(64),
          scopes: [{ factoryId: 'factory-1', repo: 'owner/repo' }],
          approvedAt: new Date().toISOString(),
          connected: false,
          readiness,
        },
      ],
    }),
    revokeExecution: () => ({}),
  })
  render(<MachinesPage />)
  await screen.findByText('Mini · Disconnected')
  expect(screen.getByText(/these readings are stale/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Revoke access' }))
  expect(a.request).not.toHaveBeenCalledWith('revokeExecution', expect.anything())
  await user().click(screen.getByRole('button', { name: 'Confirm revocation' }))
  await waitFor(() => expect(a.request).toHaveBeenCalledWith('revokeExecution', { id: 'grant-1' }))
})
