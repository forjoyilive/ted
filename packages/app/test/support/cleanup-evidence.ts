interface CleanupStep {
  name: string
  run: () => Promise<unknown>
}

export interface CleanupEvidence {
  outcome: 'running' | 'passed' | 'failed'
  elapsedMs: number
  steps: { name: string; state: 'running' | 'passed' | 'failed'; elapsedMs: number }[]
}

interface CleanupProgress {
  name: string
  state: 'running' | 'passed' | 'failed'
  started: number
  end?: number
}

export async function cleanupWithEvidence(
  steps: readonly CleanupStep[],
  report: (evidence: CleanupEvidence) => void,
): Promise<void> {
  const started = Date.now()
  const progress: CleanupProgress[] = []
  let outcome: CleanupEvidence['outcome'] = 'running'
  const snapshot = () => {
    try {
      report({
        outcome,
        elapsedMs: Date.now() - started,
        steps: progress.map((step) => ({
          name: step.name,
          state: step.state,
          elapsedMs: (step.end ?? Date.now()) - step.started,
        })),
      })
    } catch {}
  }
  const warning = setTimeout(() => {
    snapshot()
  }, 8000)
  warning.unref()
  try {
    for (const step of steps) {
      const current: CleanupProgress = { name: step.name, state: 'running', started: Date.now() }
      progress.push(current)
      try {
        await step.run()
        current.state = 'passed'
      } catch (error) {
        current.state = 'failed'
        throw error
      } finally {
        current.end = Date.now()
      }
    }
    outcome = 'passed'
  } catch (error) {
    outcome = 'failed'
    throw error
  } finally {
    clearTimeout(warning)
    snapshot()
  }
}
