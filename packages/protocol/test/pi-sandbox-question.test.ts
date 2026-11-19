import { expect, test } from 'vitest'
import { piSandboxQuestion } from '../src/index.ts'

test('the Pi sandbox question drops the reason’s trailing dots and whitespace', () => {
  expect(piSandboxQuestion('bwrap isn’t installed. Install bubblewrap. \n\t')).toBe(
    'Ted can’t sandbox Pi here (bwrap isn’t installed. Install bubblewrap). Pi will run every command without asking. Run it anyway?',
  )
  expect(piSandboxQuestion(' . ')).toBe(
    'Ted can’t sandbox Pi here (). Pi will run every command without asking. Run it anyway?',
  )
})

test('the Pi sandbox question stays fast on a long run of whitespace inside the reason', () => {
  const reason = `a${'\t'.repeat(100_000)}b`
  const started = performance.now()
  expect(piSandboxQuestion(reason)).toContain(reason)
  expect(performance.now() - started).toBeLessThan(1_000)
})
