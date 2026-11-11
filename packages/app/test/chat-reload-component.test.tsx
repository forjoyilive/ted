// @vitest-environment jsdom
import type { ChatItem, RunChat, RunSummary } from '@ted/protocol'
import { act, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RunChat as Conversation } from '../src/renderer/components/RunChat.tsx'
import { bridge } from './support/component.ts'
import { createdAt } from './support/fixtures.ts'

const avatars = vi.hoisted(() => ({ drawn: 0 }))

vi.mock('../src/renderer/components/Avatar.tsx', async (original) => {
  const real = await original<typeof import('../src/renderer/components/Avatar.tsx')>()
  return {
    ...real,
    AgentAvatar: (props: Parameters<typeof real.AgentAvatar>[0]) => {
      avatars.drawn += 1
      return real.AgentAvatar(props)
    },
  }
})

const lead: RunSummary = {
  id: 'r1',
  taskId: 'NB-1',
  name: 'Task Lead',
  agent: 'claude',
  role: 'lead',
  state: 'working',
  current: true,
  startedAt: createdAt,
}

const says = (id: string, text: string): ChatItem => ({ kind: 'agent', id, text, at: createdAt })

test('Run chat reloads at once for the first output lines, then once a second, and at once for anything else', async () => {
  let loads = 0
  const api = bridge({
    getRunChat: (): RunChat => {
      loads += 1
      return { run: lead, items: [says('a1', `Load ${loads}`)] }
    },
  })
  const lines = () => act(() => api.emit({ type: 'run-output', runId: 'r1', lines: true }))
  render(<Conversation runId="r1" />)
  await screen.findByText('Load 1')

  lines()
  await screen.findByText('Load 2')
  lines()
  lines()
  lines()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(loads).toBe(2)
  await screen.findByText('Load 3', undefined, { timeout: 3000 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(loads).toBe(3)

  act(() => api.emit({ type: 'run-output', runId: 'r1' }))
  await screen.findByText('Load 4')
  lines()
  act(() => api.emit({ type: 'run-updated', run: { ...lead, state: 'idle' } as never }))
  await screen.findByText('Load 5')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  expect(loads).toBe(5)
})

test('a reload or a running tool’s clock redraws only the rows that changed', async () => {
  const startedAt = new Date(Date.now() - 5000).toISOString()
  const items = (): ChatItem[] => [
    says('a1', 'One'),
    { kind: 'tool', id: 't1', tool: 'Bash', title: 'pnpm test', status: 'running', at: startedAt },
  ]
  let chat: RunChat = { run: lead, items: items() }
  const api = bridge({ getRunChat: () => chat })
  render(<Conversation runId="r1" bar={false} />)
  await screen.findByText('One')
  expect(screen.getByText(/running · 5s/)).toBeTruthy()
  const drawn = avatars.drawn

  chat = { run: { ...lead }, items: [...items(), says('a2', 'Two')] }
  act(() => api.emit({ type: 'run-output', runId: 'r1' }))
  await screen.findByText('Two')
  expect(avatars.drawn).toBe(drawn + 1)

  await waitFor(() => expect(screen.getByText(/running · [67]s/)).toBeTruthy(), { timeout: 3000 })
  expect(avatars.drawn).toBe(drawn + 1)

  chat = { run: { ...lead }, items: [says('a1', 'One, edited'), ...items().slice(1)] }
  act(() => api.emit({ type: 'run-output', runId: 'r1' }))
  await screen.findByText('One, edited')
  expect(avatars.drawn).toBe(drawn + 2)
})
