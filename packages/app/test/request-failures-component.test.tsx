// @vitest-environment jsdom
import type { AnswerRequest, FailureCase } from '@ted/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AnsweredCard, RequestCard } from '../src/renderer/components/RequestCard.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { comment, createdAt, task } from './support/fixtures.ts'
import { requestApi } from './support/requests.ts'

test('a failure decision asks for a reason before Fixed or No longer applicable and shows only the daemon’s refusal', async () => {
  const refusal =
    'The Task’s code or checks changed since this failure was assessed, so it can’t be accepted as it is. Ask the Task Lead to assess it again.'
  const answer = vi.fn((_id, request) => {
    const input = request as AnswerRequest
    if (input.action === 'answer' && input.choice === 'Accept this failure')
      throw new Error(`Error invoking remote method 'ted:request': Error: ${refusal}`)
    return comment()
  })
  bridge({
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
    answerRequest: answer,
    listFailures: () => [],
  })
  render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'question',
        author: { kind: 'ted' },
        choices: ['Accept this failure', 'Fixed', 'No longer applicable'],
      })}
    />,
  )
  const u = user()
  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
  expect(screen.getByRole('group', { name: 'Your decision' })).toBeTruthy()
  await u.type(screen.getByLabelText('Your answer'), 'fixed{Enter}')
  expect(answer).not.toHaveBeenCalled()
  await u.clear(screen.getByLabelText('Your answer'))
  await u.click(screen.getByRole('radio', { name: 'Fixed' }))
  expect(send.disabled).toBe(true)
  expect(send.textContent).toBe('Confirm Fixed')
  fireEvent.keyDown(screen.getByLabelText('Why is this failure fixed?'), { key: 'Enter' })
  expect(answer).not.toHaveBeenCalled()
  expect(screen.getByText('A reason is required. Confirming closes this failure.')).toBeTruthy()
  await u.click(screen.getByRole('radio', { name: 'No longer applicable' }))
  expect(send.disabled).toBe(true)
  expect(send.textContent).toBe('Confirm No longer applicable')
  expect(screen.getByLabelText('Why does this failure no longer apply?')).toBeTruthy()
  await u.click(screen.getByRole('radio', { name: 'Accept this failure' }))
  expect(answer).not.toHaveBeenCalled()
  expect(screen.queryByText('A reason is required. Confirming closes this failure.')).toBeNull()
  await u.click(send)
  expect((await screen.findByRole('alert')).textContent).toBe(refusal)
  await u.click(screen.getByRole('radio', { name: 'Send a message to the Task Lead' }))
  expect(screen.queryByRole('radio', { name: 'Other answer' })).toBeNull()
  expect(
    screen.getByText(
      'Sending a message leaves this failure open. Choose a decision to resolve it.',
    ),
  ).toBeTruthy()
  expect(send.textContent).toBe('Send message')
  await u.type(screen.getByLabelText('Message to the Task Lead'), 'Is this the TED-128 timeout?')
  await u.keyboard('{Enter}')
  expect(answer).toHaveBeenLastCalledWith('c1', {
    action: 'answer',
    text: 'Is this the TED-128 timeout?',
  })
  await u.click(screen.getByRole('radio', { name: 'Fixed' }))
  await u.type(screen.getByLabelText('Why is this failure fixed?'), 'A rerun passed.')
  expect(send.disabled).toBe(false)
  await u.keyboard('{Enter}')
  expect(answer).toHaveBeenLastCalledWith('c1', {
    action: 'answer',
    choice: 'Fixed',
    text: 'A rerun passed.',
  })
})

test('Validate failure decisions display evidence and send the selected action', async () => {
  const { answer, handle } = requestApi()
  handle('listFailures', () => [
    {
      id: 'failure-1',
      taskId: 'NB-1',
      validation: true,
      source: { kind: 'finding', runId: 'run-1', finding: 'Visual failure' },
      recordedBy: 'run-1',
      provenance: 'task-lead-reported',
      evidence: 'Reproduced before the changed code executes.',
      createdAt,
      contextId: 'context-1',
      additions: [],
      invalidations: [],
      resolutions: [],
      assessments: [
        {
          id: 'assessment-1',
          runId: 'run-1',
          at: createdAt,
          assessment: 'uncertain',
          recommendation: 'Retry the identified verification.',
          choice: 'retry',
        },
      ],
      decisions: [{ commentId: 'request-1', assessmentId: 'assessment-1' }],
    },
  ])
  render(
    <RequestCard
      request={comment({
        id: 'request-1',
        kind: 'question',
        choices: ['Retry', 'Fix in this Task', 'Accept this failure'],
      })}
      task={task()}
    />,
  )
  await screen.findByText('Reproduced before the changed code executes.')
  expect(screen.getByText('Visual failure')).toBeTruthy()
  expect(screen.getByText('The cause isn’t known')).toBeTruthy()
  expect(screen.getByText('Retry the identified verification.')).toBeTruthy()
  expect(screen.getByText(/Accepting covers only this failure/)).toBeTruthy()
  expect(screen.getByText('What failed')).toBeTruthy()
  expect(screen.getByText('Show history · 1 evidence entry')).toBeTruthy()
  expect((await screen.findByText('Recommended')).parentElement?.textContent).toBe(
    'Retry Recommended',
  )
  expect(screen.getAllByText('Recommended')).toHaveLength(1)
  await user().click(screen.getByRole('radio', { name: 'Accept this failure' }))
  expect(answer).not.toHaveBeenCalled()
  await user().click(screen.getByRole('button', { name: 'Confirm Accept this failure' }))
  expect(answer).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ action: 'answer', choice: 'Accept this failure' }),
  )
  cleanup()
  render(
    <RequestCard
      request={comment({
        id: 'request-1',
        kind: 'question',
        choices: ['Retry', 'Fix in this Task'],
      })}
      task={task()}
    />,
  )
  expect(await screen.findByText(/This failure can’t be accepted/)).toBeTruthy()
  expect(screen.queryByRole('radio', { name: 'Accept this failure' })).toBeNull()
})

test('a failure card without Accept says why and what the user can do instead', async () => {
  const { answer, handle } = requestApi()
  const failure = (
    source: FailureCase['source'],
    validation: boolean,
    acceptRefused?: 'changed' | 'unknown',
    rerun = false,
  ): FailureCase => ({
    id: 'failure-1',
    taskId: 'NB-1',
    validation,
    source,
    recordedBy: 'run-1',
    provenance: 'stored-check',
    evidence: 'The check failed.',
    createdAt,
    additions: [],
    invalidations: [],
    resolutions: [],
    assessments: [
      {
        id: 'assessment-1',
        runId: 'run-1',
        at: createdAt,
        assessment: 'unrelated',
        recommendation: 'It fails the same way on main.',
      },
    ],
    decisions: [
      {
        commentId: 'request-1',
        assessmentId: 'assessment-1',
        ...(acceptRefused && { acceptRefused }),
        ...(rerun && { rerun: true as const }),
      },
    ],
  })
  const check = { kind: 'factory-check', checkRunId: 'check-run-1', position: 0 } as const
  const finding = { kind: 'finding', runId: 'run-1', finding: 'Visual failure' } as const
  const cases: [FailureCase, string[], string][] = [
    [
      failure(check, true, 'changed'),
      ['Retry', 'Fix in this Task', 'Fixed', 'No longer applicable'],
      'This failure can’t be accepted: the Task’s code or checks changed since the check failed. Retry runs the check on the current code. Fixed and No longer applicable close it with a reason.',
    ],
    [
      failure(check, true, 'unknown'),
      ['Retry', 'Fix in this Task'],
      'This failure can’t be accepted: Ted has no record it can verify of what was tested when it failed. Retry runs the check on the current code.',
    ],
    [
      failure(finding, false, 'unknown'),
      ['Fixed', 'No longer applicable'],
      'This failure can’t be accepted: Ted has no record it can verify of what was tested when it failed. Close it as fixed or no longer applicable; if it still happens, write to the Task Lead.',
    ],
    [
      failure(check, true),
      ['Retry', 'Fix in this Task'],
      'This failure can’t be accepted: Ted can’t tie it to the Task’s code as it is now. Retry runs the check on the current code.',
    ],
  ]
  for (const [value, choices, caption] of cases) {
    handle('listFailures', () => [value])
    render(
      <RequestCard
        request={comment({ id: 'request-1', kind: 'question', choices })}
        task={task()}
      />,
    )
    expect(await screen.findByText(caption)).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'Accept this failure' })).toBeNull()
    cleanup()
  }
  handle('listFailures', () => [failure(check, true, 'changed', true)])
  render(
    <RequestCard
      request={comment({
        id: 'request-1',
        kind: 'question',
        purpose: { kind: 'failure' },
        choices: ['Run the checks again on the new code'],
      })}
      task={task()}
    />,
  )
  expect(
    await screen.findByText(
      'This failure can’t be accepted: the Task’s code changed after the Task Lead asked about it. Run the checks again on the new code moves the Task to Validate, where Ted runs the checks on the code as it is now.',
    ),
  ).toBeTruthy()
  expect(screen.queryByRole('radio', { name: 'Accept this failure' })).toBeNull()
  expect(screen.getByRole('radio', { name: 'Send a message to the Task Lead' })).toBeTruthy()
  await user().click(screen.getByRole('radio', { name: 'Run the checks again on the new code' }))
  await user().click(
    screen.getByRole('button', { name: 'Confirm Run the checks again on the new code' }),
  )
  expect(answer).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ action: 'answer', choice: 'Run the checks again on the new code' }),
  )
})

test('a repair Task the Task Lead named is its own decision choice, with its title and Stage, and shows on the card', async () => {
  const { answer, handle } = requestApi()
  const openTask = vi.fn<(id: string) => void>()
  handle('listTasks', () => [
    task(),
    task({
      id: 'repair-1',
      displayId: 'NB-2',
      number: 2,
      title: 'Fix the restart test',
      stage: 'work',
    }),
  ])
  handle('listFailures', () => [
    {
      id: 'failure-1',
      taskId: 'NB-1',
      validation: true,
      source: { kind: 'finding', runId: 'run-1', finding: 'Restart test' },
      recordedBy: 'run-1',
      provenance: 'task-lead-reported',
      evidence: 'Fails the same way on main.',
      createdAt,
      contextId: 'context-1',
      additions: [],
      invalidations: [],
      resolutions: [],
      assessments: [
        {
          id: 'assessment-1',
          runId: 'run-1',
          at: createdAt,
          assessment: 'unrelated',
          recommendation: 'Wait for NB-2, which fixes the restart test.',
          repairTask: 'repair-1',
        },
      ],
      decisions: [
        {
          commentId: 'request-1',
          assessmentId: 'assessment-1',
          repairTask: { id: 'repair-1', displayId: 'NB-2', title: 'Fix the restart test' },
        },
      ],
    },
  ])
  render(
    <RequestCard
      request={comment({
        id: 'request-1',
        kind: 'question',
        choices: ['Retry', 'Fix in this Task', 'Wait for NB-2', 'Wait for a repair Task'],
      })}
      task={task()}
      onOpenTask={openTask}
    />,
  )
  await user().click(await screen.findByRole('button', { name: 'NB-2 · Fix the restart test' }))
  expect(openTask).toHaveBeenCalledWith('repair-1')
  const named = await screen.findByRole('radio', { name: /^Wait for NB-2/ })
  await waitFor(() =>
    expect(named.closest('label')?.textContent).toBe('Wait for NB-2 · Fix the restart test · Work'),
  )
  await user().click(named)
  expect(await screen.findByText(/waits for NB-2 · Fix the restart test to merge/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Confirm Wait for NB-2' }))
  expect(answer).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ action: 'answer', choice: 'Wait for NB-2' }),
  )
})

test('historical failure request keeps its own assessment and decision', async () => {
  bridge({
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
    listFailures: () => [
      {
        id: 'failure-1',
        taskId: 'NB-1',
        validation: true,
        source: { kind: 'finding', runId: 'run-1', finding: 'Original Finding' },
        recordedBy: 'run-1',
        provenance: 'task-lead-reported',
        evidence: 'Original evidence',
        createdAt,
        additions: [],
        invalidations: [],
        assessments: [
          {
            id: 'assessment-1',
            runId: 'run-1',
            at: createdAt,
            assessment: 'uncertain',
            recommendation: 'Retry verification',
          },
          {
            id: 'assessment-2',
            runId: 'run-1',
            at: createdAt,
            assessment: 'unrelated',
            recommendation: 'Accept this execution',
          },
        ],
        decisions: [
          { commentId: 'request-1', assessmentId: 'assessment-1' },
          { commentId: 'request-2', assessmentId: 'assessment-2' },
        ],
        resolutions: [
          {
            requestId: 'request-1',
            assessmentId: 'assessment-1',
            resolution: 'retry',
            at: createdAt,
          },
          {
            requestId: 'request-2',
            assessmentId: 'assessment-2',
            resolution: 'accepted',
            at: createdAt,
          },
        ],
      },
    ],
  })
  render(
    <AnsweredCard
      task={task()}
      expanded
      request={comment({
        id: 'request-1',
        kind: 'question',
        choices: ['Retry', 'Fix in this Task', 'Accept this failure'],
        answer: { kind: 'answered', at: createdAt, choice: 'Retry' },
      })}
    />,
  )
  await screen.findByText('Original Finding')
  expect(screen.queryByText(/Human decision: accepted/)).toBeNull()
  expect(screen.getByText(/Human decision: retry/)).toBeTruthy()
  expect(screen.getByText('The cause isn’t known')).toBeTruthy()
})

test('repair drafts survive switching and keyboard submission uses the valid repair action', async () => {
  const { handle, answer } = requestApi()
  const pending = deferred<object>()
  const resolve = vi.fn(() => pending.promise)
  handle('resolveFailure', resolve)
  handle('listTasks', () => [task(), task({ id: 'NB-2', displayId: 'NB-2', number: 2 })])
  handle('listFailures', () => [
    {
      id: 'repair-failure',
      taskId: 'NB-1',
      recordedBy: 'run-1',
      provenance: 'task-lead-reported',
      source: { kind: 'finding', runId: 'run-1', finding: 'Export labels missing' },
      evidence: 'Reproduced on main',
      createdAt,
      additions: [],
      invalidations: [],
      resolutions: [],
      assessments: [
        {
          id: 'a1',
          runId: 'run-1',
          at: createdAt,
          assessment: 'unrelated',
          recommendation: 'Repair export labels',
        },
      ],
      decisions: [{ commentId: 'c1', assessmentId: 'a1' }],
    },
  ])
  render(
    <RequestCard
      request={comment({
        kind: 'question',
        choices: ['Retry', 'Wait for a repair Task', 'Accept this failure'],
      })}
      task={task()}
    />,
  )
  const u = user()
  await u.type(
    screen.getByRole('textbox', { name: 'Your answer' }),
    'Keep the filter change focused.',
  )
  await u.click(screen.getByRole('radio', { name: 'Wait for a repair Task' }))
  const answerBox = screen.getByRole('textbox', { name: 'Your answer' })
  const send = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
  expect(send().disabled).toBe(true)
  await u.click(answerBox)
  await u.keyboard('{Enter}')
  expect(resolve).not.toHaveBeenCalled()
  expect(answer).not.toHaveBeenCalled()
  await u.click(await screen.findByRole('button', { name: 'Choose repair…' }))
  await u.click(screen.getByRole('option', { name: /NB-2/ }))
  await u.click(screen.getByRole('radio', { name: 'Retry' }))
  expect(screen.queryByRole('region', { name: 'Wait for a repair Task' })).toBeNull()
  await u.click(screen.getByRole('radio', { name: 'Wait for a repair Task' }))
  expect(screen.getByRole('button', { name: 'Remove NB-2' })).toBeTruthy()
  expect(
    (screen.getByRole('radio', { name: 'Use an existing Task' }) as HTMLInputElement).checked,
  ).toBe(true)
  await u.click(screen.getByRole('radio', { name: 'Create a repair Task' }))
  const queue = () =>
    screen.getByRole('checkbox', {
      name: 'Queue the repair to start after approval',
    }) as HTMLInputElement
  expect(queue().checked).toBe(true)
  await u.clear(screen.getByRole('textbox', { name: 'Repair title' }))
  await u.type(screen.getByRole('textbox', { name: 'Repair title' }), 'Fix export labels')
  await u.clear(screen.getByRole('textbox', { name: 'Repair description' }))
  await u.type(
    screen.getByRole('textbox', { name: 'Repair description' }),
    'Restore export labels.',
  )
  await u.click(queue())
  await u.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(resolve).not.toHaveBeenCalled()
  await u.click(screen.getByRole('radio', { name: 'Wait for a repair Task' }))
  await u.click(screen.getByRole('radio', { name: 'Retry' }))
  expect(screen.queryByRole('region', { name: 'Wait for a repair Task' })).toBeNull()
  expect(resolve).not.toHaveBeenCalled()
  expect(answer).not.toHaveBeenCalled()
  await u.click(screen.getByRole('radio', { name: 'Wait for a repair Task' }))
  expect(
    (screen.getByRole('radio', { name: 'Create a repair Task' }) as HTMLInputElement).checked,
  ).toBe(true)
  expect((screen.getByRole('textbox', { name: 'Repair title' }) as HTMLInputElement).value).toBe(
    'Fix export labels',
  )
  expect(
    (screen.getByRole('textbox', { name: 'Repair description' }) as HTMLTextAreaElement).value,
  ).toBe('Restore export labels.')
  expect(queue().checked).toBe(false)
  await u.click(screen.getByRole('radio', { name: 'Use an existing Task' }))
  expect(screen.getByRole('button', { name: 'Remove NB-2' })).toBeTruthy()
  await u.click(screen.getByRole('radio', { name: 'Create a repair Task' }))
  await u.clear(screen.getByRole('textbox', { name: 'Repair title' }))
  expect(send().disabled).toBe(true)
  await u.click(answerBox)
  await u.keyboard('{Enter}')
  expect(resolve).not.toHaveBeenCalled()
  await u.type(screen.getByRole('textbox', { name: 'Repair title' }), 'Fix export labels')
  expect(send().disabled).toBe(false)
  await u.click(answerBox)
  await u.keyboard('{Enter}')
  fireEvent.keyDown(answerBox, { key: 'Enter' })
  expect(resolve).toHaveBeenCalledOnce()
  expect(screen.getByRole('radio', { name: 'Retry' }).matches(':disabled')).toBe(true)
  await waitFor(() =>
    expect(resolve).toHaveBeenCalledWith('NB-1', 'repair-failure', {
      requestId: 'c1',
      resolution: 'repair',
      reason: 'Keep the filter change focused.',
      repair: expect.objectContaining({
        kind: 'new',
        title: 'Fix export labels',
        start: false,
        description: 'Restore export labels.',
      }),
    }),
  )
  expect(answer).not.toHaveBeenCalled()
  await act(async () => pending.resolve({}))
})

test('Sending failure acceptance shows activity, blocks conflicting answers and recovers on rejection', async () => {
  const completion = deferred<never>()
  const answer = vi.fn(() => completion.promise)
  bridge({
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
    answerRequest: answer,
    listFailures: () => [],
  })
  render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'question',
        author: { kind: 'ted' },
        choices: ['Accept this failure', 'Retry'],
      })}
    />,
  )
  await user().click(screen.getByRole('radio', { name: 'Accept this failure' }))
  expect(answer).not.toHaveBeenCalled()
  const button = screen.getByRole('button', { name: 'Send' })
  await user().click(button)
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('button', { name: 'Send' })).toBe(button)
  const retry = screen.getByRole('radio', { name: 'Retry' })
  expect(retry.matches(':disabled')).toBe(true)
  fireEvent.click(button)
  expect(answer).toHaveBeenCalledTimes(1)
  await act(async () => completion.reject(new Error('Decision could not be saved')))
  expect(screen.getByRole('alert').textContent).toBe('Decision could not be saved')
  expect(button.getAttribute('aria-busy')).toBeNull()
  expect(retry.matches(':disabled')).toBe(false)
})
