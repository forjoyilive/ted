import { expect, test } from 'vitest'
import { automationRunPrompt } from '../src/automations/automations.ts'
import { checkAgentPrompt } from '../src/automations/check-agent.ts'
import { coordinatorInstructions } from '../src/coordinators/coordinators.ts'
import { guidanceTexts, promptGuidance } from '../src/guidance.ts'
import { plannerInstructions } from '../src/plans/prompts.ts'
import { readDefaultLayer, resolveWorkflow } from '../src/workflow/index.ts'
import {
  fixedPromptTexts,
  preambleText,
  subAgentPreamble,
  subAgentPrompt,
  taskLeadPrompt,
  tedSubAgentPrompt,
} from '../src/workflow/workflow.ts'

async function everyPrompt(guidance: readonly string[]): Promise<Record<string, string>> {
  const workflow = resolveWorkflow([await readDefaultLayer()])
  const task = {
    displayId: 'NB-1',
    title: 'Fix login',
    description: '',
    clarifyDepth: 'auto',
    attachments: [],
  } as never
  return {
    taskLead: await taskLeadPrompt(task, workflow, 'work', guidance),
    subAgent: await subAgentPrompt('NB-1', 'Investigate.', guidance),
    tedSubAgent: await tedSubAgentPrompt('Review.', guidance),
    coordinator: coordinatorInstructions('Watch.', [], guidance),
    planner: plannerInstructions({
      role: 'Plan.',
      powers: [],
      guidance,
      factory: { id: 'f', name: 'Widgets', repo: 'acme/widgets' } as never,
      entries: [],
      folder: '/tmp/plan',
    }),
    automation: automationRunPrompt({
      name: 'Intake',
      factoryName: 'Widgets',
      repos: ['acme/widgets'],
      why: 'on its schedule',
      taskLines: [],
      intake: undefined,
      githubIntake: undefined,
      instructions: 'Bring in new issues.',
      guidance,
    }),
    scheduledCheck: checkAgentPrompt({
      name: 'Nightly',
      factoryName: 'Widgets',
      repos: ['widgets'],
      command: 'pnpm check',
      timeout: '2h',
      state: 'failed',
      duration: '3m',
      ranWhileBusy: false,
      skipped: [],
      failing: [],
      tail: '',
      log: '/tmp/a.log',
      startTasks: false,
      openTasks: [],
      instructions: '',
      guidance,
    }),
  }
}

test('every kind of Run’s prompt carries each shared guidance text', async () => {
  const madeUp = '## A made-up rule for every Run'
  const prompts = await everyPrompt([...promptGuidance({ aiDisclosure: true }), madeUp])
  for (const [kind, prompt] of Object.entries(prompts)) {
    for (const text of [...guidanceTexts, madeUp]) expect(prompt, kind).toContain(text)
  }
})

test('the disclosure line follows the setting and comes after the texts every Run gets', async () => {
  const off = await everyPrompt(promptGuidance({ aiDisclosure: false }))
  for (const [kind, prompt] of Object.entries(off)) expect(prompt, kind).not.toContain('via Ted:')
  const on = await everyPrompt(promptGuidance({ aiDisclosure: true }))
  expect(on.taskLead).toContain(await preambleText())
  expect(on.subAgent).toContain(await subAgentPreamble())
  expect(on.tedSubAgent).toContain(await subAgentPreamble())
  expect(promptGuidance({ aiDisclosure: true }).at(-1)).toContain('via Ted:')
})

test('the fixed prompt texts hold every shared guidance text', async () => {
  expect(await fixedPromptTexts()).toEqual(expect.arrayContaining([...guidanceTexts]))
})

test('the skills line is written once, in the shared guidance', async () => {
  const skills = 'Skip skills that require another host tool'
  const prompts = await everyPrompt(promptGuidance({ aiDisclosure: false }))
  for (const [kind, prompt] of Object.entries(prompts))
    expect(prompt.split(skills), kind).toHaveLength(2)
})
