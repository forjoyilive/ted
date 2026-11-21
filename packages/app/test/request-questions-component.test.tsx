// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { RequestCard } from '../src/renderer/components/RequestCard.tsx'
import { deferred, user } from './support/component.ts'
import { comment, task } from './support/fixtures.ts'
import { requestApi } from './support/requests.ts'

test('question choices wait for Send, keep one answer text when switching, and retain selection after errors', async () => {
  const { answer, handle } = requestApi()
  const pending = deferred<never>()
  handle(
    'answerRequest',
    answer.mockImplementation(() => pending.promise),
  )
  render(<RequestCard task={task()} request={comment({ choices: ['Compact', 'Comfortable'] })} />)
  const u = user()
  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  expect(screen.getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true)
  await u.click(screen.getByRole('radio', { name: 'Compact' }))
  await u.type(screen.getByLabelText('Your answer'), 'Keep it readable.')
  await u.click(screen.getByRole('radio', { name: 'Other answer' }))
  expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(
    'Keep it readable.',
  )
  await u.clear(screen.getByLabelText('Your answer'))
  expect(send.disabled).toBe(true)
  await u.type(screen.getByLabelText('Your answer'), 'Use a custom layout.')
  await u.click(screen.getByRole('radio', { name: 'Comfortable' }))
  expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(
    'Use a custom layout.',
  )
  expect(answer).not.toHaveBeenCalled()
  await u.click(send)
  expect(answer).toHaveBeenCalledExactlyOnceWith('c1', {
    action: 'answer',
    choice: 'Comfortable',
    text: 'Use a custom layout.',
  })
  expect(send.disabled).toBe(true)
  expect(screen.getByRole('radio', { name: 'Compact' }).matches(':disabled')).toBe(true)
  fireEvent.keyDown(screen.getByLabelText('Your answer'), { key: 'Enter' })
  expect(answer).toHaveBeenCalledOnce()
  await act(async () => pending.reject(new Error('Try again')))
  expect(screen.getByRole('alert').textContent).toBe('Try again')
  expect((screen.getByRole('radio', { name: 'Comfortable' }) as HTMLInputElement).checked).toBe(
    true,
  )
  await u.click(screen.getByRole('radio', { name: 'Other answer' }))
  expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(
    'Use a custom layout.',
  )
  handle(
    'answerRequest',
    answer.mockImplementation(() => comment()),
  )
  await u.click(screen.getByLabelText('Your answer'))
  await u.keyboard('{Enter}')
  expect(answer).toHaveBeenLastCalledWith('c1', { action: 'answer', text: 'Use a custom layout.' })
  await waitFor(() =>
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(''),
  )
  expect(send.disabled).toBe(true)
  await u.keyboard('{Enter}')
  expect(answer).toHaveBeenCalledTimes(2)
})

test('an unsent Other answer saved in the older separate field still shows and sends', async () => {
  const { answer, handle } = requestApi()
  handle('messageDraft', () => ({
    draft: {
      text: '',
      attachments: [],
      fields: JSON.stringify({ selection: { other: true }, otherText: 'Older text' }),
    },
  }))
  render(<RequestCard task={task()} request={comment({ choices: ['Compact', 'Comfortable'] })} />)
  const box = (await screen.findByDisplayValue('Older text')) as HTMLTextAreaElement
  await user().click(screen.getByRole('radio', { name: 'Compact' }))
  expect(box.value).toBe('Older text')
  await user().click(screen.getByRole('button', { name: 'Send' }))
  expect(answer).toHaveBeenCalledExactlyOnceWith('c1', {
    action: 'answer',
    choice: 'Compact',
    text: 'Older text',
  })
})

test('a saved Other answer doesn’t send on a question that takes only its buttons', async () => {
  const { answer, handle } = requestApi()
  handle('messageDraft', () => ({
    draft: {
      text: 'Older text',
      attachments: [],
      fields: JSON.stringify({ selection: { other: true } }),
    },
  }))
  render(
    <RequestCard
      task={task()}
      request={comment({
        choices: ['Add them as Tasks', 'Leave it open in Asana'],
        purpose: { kind: 'asana-unfinished' },
      })}
    />,
  )
  const u = user()
  const box = (await screen.findByDisplayValue('Older text')) as HTMLTextAreaElement
  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  await u.click(screen.getByRole('radio', { name: 'Leave it open in Asana' }))
  expect(send.disabled).toBe(true)
  await u.clear(box)
  expect(send.disabled).toBe(false)
  await u.click(send)
  expect(answer).toHaveBeenCalledExactlyOnceWith('c1', {
    action: 'answer',
    choice: 'Leave it open in Asana',
  })
})

test('Linear team questions select before Send and offer only supported answers', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard
      task={task()}
      request={comment({
        choices: ['Allow', 'Not now'],
        linearTeam: { name: 'Design', key: 'DES' },
      })}
    />,
  )
  const u = user()
  expect(screen.queryByRole('radio', { name: 'Other answer' })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  await u.click(screen.getByRole('radio', { name: 'Allow' }))
  await u.click(screen.getByRole('radio', { name: 'Not now' }))
  expect(answer).not.toHaveBeenCalled()
  await u.click(screen.getByRole('button', { name: 'Send' }))
  expect(answer).toHaveBeenCalledExactlyOnceWith('c1', { action: 'answer', choice: 'Not now' })
})

test('questions that take only their buttons offer no Other answer and send no text', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard
      task={task()}
      request={comment({
        choices: ['Add them as Tasks', 'Leave it open in Asana'],
        purpose: { kind: 'asana-unfinished' },
      })}
    />,
  )
  const u = user()
  expect(screen.queryByRole('radio', { name: 'Other answer' })).toBeNull()
  await u.click(screen.getByRole('radio', { name: 'Leave it open in Asana' }))
  await u.type(screen.getByRole('textbox'), 'A note')
  expect(screen.getByText(/This question takes only its buttons/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  await u.clear(screen.getByRole('textbox'))
  await u.click(screen.getByRole('button', { name: 'Send' }))
  expect(answer).toHaveBeenCalledExactlyOnceWith('c1', {
    action: 'answer',
    choice: 'Leave it open in Asana',
  })
  cleanup()

  render(
    <RequestCard
      task={task()}
      request={comment({
        choices: ['Try again', 'Finish anyway'],
        purpose: { kind: 'cleanup-failure' },
      })}
    />,
  )
  expect(screen.queryByRole('radio', { name: 'Other answer' })).toBeNull()
  await u.click(screen.getByRole('radio', { name: 'Try again' }))
  await u.type(screen.getByRole('textbox'), 'Try once more')
  await u.click(screen.getByRole('button', { name: 'Send' }))
  expect(answer).toHaveBeenLastCalledWith('c1', {
    action: 'answer',
    choice: 'Try again',
    text: 'Try once more',
  })
  cleanup()

  render(
    <RequestCard
      task={task()}
      request={comment({
        title: 'An instruction check didn’t report: Docs drift',
        choices: ['Try again', 'Count it as failed'],
        purpose: { kind: 'check-report' },
      })}
    />,
  )
  expect(screen.queryByRole('radio', { name: 'Other answer' })).toBeNull()
  await u.click(screen.getByRole('radio', { name: 'Count it as failed' }))
  await u.click(screen.getByRole('button', { name: 'Send' }))
  expect(answer).toHaveBeenLastCalledWith('c1', {
    action: 'answer',
    choice: 'Count it as failed',
  })
})

test('a one-off question that allows several answers sends the ticked choices', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard
      task={task()}
      request={comment({ choices: ['Board', 'List', 'Map'], multiple: true })}
    />,
  )
  const u = user()
  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
  expect(screen.getByText('Pick any that apply')).toBeTruthy()
  expect(screen.queryAllByRole('radio')).toHaveLength(0)
  expect(send.disabled).toBe(false)
  await u.click(screen.getByRole('checkbox', { name: /^Other/ }))
  expect(send.disabled).toBe(true)
  await u.click(screen.getByRole('checkbox', { name: /^Other/ }))
  await u.click(screen.getByRole('checkbox', { name: 'Map' }))
  await u.click(screen.getByRole('checkbox', { name: 'Board' }))
  await u.click(screen.getByRole('checkbox', { name: 'Map' }))
  expect(send.disabled).toBe(false)
  await u.click(screen.getByRole('checkbox', { name: 'List' }))
  await u.click(send)
  expect(answer).toHaveBeenCalledExactlyOnceWith('c1', {
    action: 'answer',
    choices: ['Board', 'List'],
  })
})
