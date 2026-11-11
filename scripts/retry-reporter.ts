import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Reporter, TestCase, TestModule } from 'vitest/node'

const root = path.resolve(import.meta.dirname, '..')

function testName(test: TestCase): string {
  const names = [test.name]
  for (let parent = test.parent; parent.type === 'suite'; parent = parent.parent) {
    names.unshift(parent.name)
  }
  return `${path.relative(root, test.module.moduleId)} > ${names.join(' ')}`
}

export function passedOnRetry(modules: readonly TestModule[]): string[] {
  const names: string[] = []
  for (const module of modules) {
    for (const test of module.children.allTests()) {
      if (test.diagnostic()?.flaky) names.push(testName(test))
    }
  }
  return names
}

export default class RetryReporter implements Reporter {
  onTestRunEnd(modules: readonly TestModule[]): void {
    const file = process.env.TED_RETRY_REPORT
    if (!file) return
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ passedOnRetry: passedOnRetry(modules) })}\n`)
  }
}
