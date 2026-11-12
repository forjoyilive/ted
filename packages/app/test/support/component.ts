import type { NewTaskDraft } from '@ted/protocol'
import { agentKinds } from '@ted/protocol/run'
import { cleanup } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { TedBridge, TedEvent } from '../../src/renderer/ted.ts'

const verifications: (() => void)[] = []

type Handler = (...args: unknown[]) => unknown

export function bridge(given: Record<string, Handler>) {
  const handlers: Record<string, Handler> = {
    getSideChat: () => null,
    taskGates: () => ({ overrides: {}, rows: [], revision: '' }),
    getAsana: () => ({ state: 'unconfigured', configured: false, redirectUri: '' }),
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
