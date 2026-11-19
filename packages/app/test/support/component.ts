import type { NewTaskDraft } from '@ted/protocol'
import { agentKinds } from '@ted/protocol/run'
import { defaultMachineSettings } from '@ted/protocol/settings'
import { cleanup, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { showDetailsTab } from '../../src/renderer/details.ts'
import type { TedBridge, TedEvent } from '../../src/renderer/ted.ts'
import { coordinatorAgent, plannerAgent } from './fixtures.ts'

const verifications: (() => void)[] = []

type Handler = (...args: unknown[]) => unknown

export function bridge(given: Record<string, Handler>) {
  const handlers: Record<string, Handler> = {
    getSettings: () => defaultMachineSettings,
    agentAvailability: () => [],
    agentModels: () => ({ models: [] }),
    apiCost: () => ({ days: 30, since: '2026-10-12T00:00:00.000Z', agents: [] }),
    getSideChat: () => null,
    messageDraft: () => ({ draft: null }),
    saveMessageDraft: (_box, draft) => ({ draft }),
    taskGates: () => ({ overrides: {}, rows: [], revision: '' }),
    getAsana: () => ({ state: 'unconfigured', configured: false, redirectUri: '' }),
    tedStops: () => [],
    listTasks: () => [],
    listFactories: () => [],
    factoryLayout: () => ({ items: [] }),
    guides: () => [],
    memoryUse: () => ({
      daemon: { bytes: 900 * 1024 ** 2, heapBytes: 0, externalBytes: 0 },
      hosts: { count: 2, bytes: 150 * 1024 ** 2 },
      agents: { count: 2, bytes: 700 * 1024 ** 2 },
      agentTools: { count: 0, bytes: 0 },
      checks: { count: 0, bytes: 0 },
      apps: { count: 0, bytes: 0 },
      other: { count: 0, bytes: 0 },
      store: { eventLogBytes: 0, stateBytes: 0 },
      app: { count: 4, bytes: 590 * 1024 ** 2 },
    }),
    appProcesses: () => [],
    factoryAgents: () => [coordinatorAgent, plannerAgent],
    ...given,
  }
  const listeners = new Set<(event: TedEvent) => void>()
  const unexpected: string[] = []
  const request = vi.fn(async (name: string, ...args: unknown[]) => {
    const handler = handlers[name]
    if (!Object.hasOwn(handlers, name) || !handler) {
      unexpected.push(name)
      throw new Error(`Unexpected bridge request: ${name}`)
    }
    return handler(...args)
  })
  const api: TedBridge = {
    request,
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  window.ted = api
  verifications.push(() => {
    expect(unexpected, 'unhandled bridge requests').toEqual([])
    expect(listeners.size, 'component subscriptions cleaned up').toBe(0)
  })
  return {
    request,
    handle: (name: string, handler: Handler) => {
      handlers[name] = handler
    },
    emit: (event: TedEvent) =>
      listeners.forEach((listener) => {
        listener(event)
      }),
  }
}

export function deferred<T>() {
  return Promise.withResolvers<T>()
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = () => {}
  if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = () => {}
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute('open')
  })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  const checks = verifications.splice(0)
  try {
    cleanup()
    showDetailsTab('details')
    for (const verify of checks) verify()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
    sessionStorage.clear()
    document.documentElement.removeAttribute('style')
    Reflect.deleteProperty(window, 'ted')
  }
})

export const user = () => userEvent.setup()

export function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required test element is missing')
  return value
}

export function draftHandlers() {
  const drafts = new Map<unknown, NewTaskDraft>()
  return {
    taskDraft: (factory: unknown) => ({ draft: drafts.get(factory) ?? null }),
    saveTaskDraft: (factory: unknown, draft: unknown) => {
      drafts.set(factory, draft as NewTaskDraft)
      return { draft }
    },
    checkAgentHealth: () =>
      agentKinds.map((agent) => ({ agent, state: 'ready', version: '2.0.0' })),
  }
}

export async function expandFactory(name = 'widgets') {
  const views = within(await screen.findByRole('article', { name })).getByRole('button', {
    name: 'Views',
  })
  if (views.getAttribute('aria-expanded') !== 'true') await user().click(views)
}
