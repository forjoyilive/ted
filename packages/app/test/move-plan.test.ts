import type { TaskMovePlan, TaskMovePlanTask } from '@ted/protocol'
import { expect, test } from 'vitest'
import { movePlanView } from '../src/renderer/move-plan.ts'

const stageName = (stage: string) =>
  stage === 'backlog' ? 'Backlog' : stage === 'intake' ? 'Intake' : stage

function planned(fields: Partial<TaskMovePlanTask> = {}): TaskMovePlanTask {
  return {
    id: 'NB-12',
    displayId: 'NB-12',
    title: 'Tag notes from the share sheet',
    newDisplayId: 'WEB-41',
    stage: 'backlog',
    lands: 'backlog',
    startsLead: false,
    worktrees: 0,
    branches: [],
    pullRequests: [],
    openRequests: 0,
    unlinked: [],
    ...fields,
  }
}

function plan(fields: Partial<TaskMovePlan> = {}): TaskMovePlan {
  return {
    factoryId: 'web',
    factoryName: 'Website',
    repos: ['website'],
    tasks: [planned()],
    ...fields,
  }
}

test('a Backlog Task lands in Backlog and lists only what changes', () => {
  const view = movePlanView(plan({ tasks: [planned({ trackerSync: 'Linear' })] }), stageName)
  expect(view).toMatchObject({
    landing: {
      before: 'NB-12 becomes ',
      newDisplayId: 'WEB-41',
      after: ' in Backlog. Nothing starts until you start it.',
    },
    movesWith: [],
    unlinked: [],
    changesHeading: 'What changes',
    changes: [
      'Repos becomes Website’s: website',
      'Sync with Linear asks for your permission again',
    ],
    throwsAwayWork: false,
  })
  expect(view?.leavesParent).toBeUndefined()
})

test('a started Task with children lists what is lost, what moves with it and the links removed', () => {
  const view = movePlanView(
    plan({
      repos: ['api', 'api-docs'],
      leavesParent: { id: 'NB-2', displayId: 'NB-2', title: 'Notes' },
      tasks: [
        planned({
          id: 'NB-14',
          displayId: 'NB-14',
          stage: 'work',
          lands: 'intake',
          startsLead: true,
          worktrees: 1,
          branches: ['ted/nb-14-offline-editing'],
          pullRequests: [{ repo: 'notebook', number: 212 }],
          openRequests: 1,
          unlinked: [
            { id: 'NB-9', displayId: 'NB-9', title: 'Upgrade the sync library', blocks: true },
          ],
        }),
        planned({
          id: 'NB-15',
          displayId: 'NB-15',
          title: 'Local note cache',
          newDisplayId: 'WEB-42',
          stage: 'validate',
          lands: 'intake',
          startsLead: true,
          worktrees: 1,
        }),
        planned({
          id: 'NB-16',
          displayId: 'NB-16',
          title: 'Offline badge',
          newDisplayId: 'WEB-43',
        }),
      ],
    }),
    stageName,
  )
  expect(view).toMatchObject({
    landing: {
      before: 'NB-14 becomes ',
      after:
        ' in Intake. A new Task Lead starts there at once, with a copy of the conversation so far.',
    },
    movesWith: [
      { displayId: 'NB-15', note: 'to Intake' },
      { displayId: 'NB-16', note: 'stays in Backlog' },
    ],
    leavesParent:
      'NB-14 is a child of NB-2. It leaves NB-2, which stops waiting for it. TED notes this on both Tasks.',
    unlinked: [{ displayId: 'NB-9', note: 'blocks NB-14' }],
    changesHeading: 'What is lost',
    changes: [
      'The worktree and any uncommitted work in it',
      'The branch ted/nb-14-offline-editing and its commits, here and on GitHub',
      'The same for NB-15, which moves with it',
      'Pull request notebook #212, which TED closes on GitHub',
      'Its open request is withdrawn from your Inbox',
      'Repos becomes Website’s: api, api-docs',
    ],
    throwsAwayWork: true,
  })
})
