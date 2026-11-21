// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { QuestionCard } from '../src/renderer/views/Automations.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt } from './support/fixtures.ts'

test('Automation question choices and written answers wait for Send', async () => {
  const answer = vi.fn(() => ({}))
  bridge({ answerAutomationRequest: answer })
  render(
    <QuestionCard
      request={{
        id: 'aq',
        kind: 'question',
        automationId: 'a',
        automationName: 'Daily triage',
        runId: 'r',
        factoryId: 'f1',
        body: 'Keep this item?',
        createdAt,
        choices: ['Keep', 'Skip'],
      }}
    />,
  )
  const u = user()
  const send = screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  await u.click(screen.getByRole('radio', { name: 'Keep' }))
  await u.click(screen.getByRole('radio', { name: 'Skip' }))
  expect(answer).not.toHaveBeenCalled()
  await u.click(send)
  expect(answer).toHaveBeenCalledExactlyOnceWith('aq', { choice: 'Skip' })
  await u.type(screen.getByLabelText('Your answer'), 'Ask tomorrow.')
  await u.click(screen.getByRole('radio', { name: 'Other answer' }))
  expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('Ask tomorrow.')
  await u.click(screen.getByLabelText('Your answer'))
  answer.mockImplementationOnce(() => {
    throw new Error('Couldn’t answer')
  })
  await u.keyboard('{Enter}')
  expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t answer')
  expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('Ask tomorrow.')
  await u.keyboard('{Enter}')
  expect(answer).toHaveBeenLastCalledWith('aq', { text: 'Ask tomorrow.' })
  await waitFor(() =>
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(''),
  )
  expect(send.disabled).toBe(true)
  await u.keyboard('{Enter}')
  expect(answer).toHaveBeenCalledTimes(3)
})
