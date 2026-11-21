import { vi } from 'vitest'
import { bridge } from './component.ts'
import { comment } from './fixtures.ts'

export function requestApi() {
  const answer = vi.fn<() => ReturnType<typeof comment> | Promise<never>>(() => comment())
  const api = bridge({
    listThreadEvents: () => [],
    listCheckRuns: () => [],
    listFailures: () => [],
    validationObligations: () => ({
      satisfied: true,
      cases: [],
      checkRuns: [],
      blockers: [],
    }),
    listApps: () => [],
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
    answerRequest: answer,
  })
  return { ...api, answer }
}
