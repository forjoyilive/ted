import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { thirdPartyLicenses, thirdPartyPackages } from '../src/third-party.ts'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

describe('third-party code TED ships', () => {
  test('lists what the background process needs, and marks what only the window uses', async () => {
    const { packages, placements } = await thirdPartyPackages(repoRoot)
    const byName = new Map(packages.map((p) => [p.name, p]))

    expect(byName.get('yaml')).toMatchObject({ runtime: true })
    expect(byName.get('@livestore/wa-sqlite')).toMatchObject({ runtime: true })
    for (const name of ['react', 'react-markdown', 'remark-gfm', 'lucide-react']) {
      expect(byName.get(name), name).toMatchObject({ runtime: false })
    }
    expect(byName.get('@fontsource-variable/geist')).toMatchObject({ runtime: false })
    for (const left of ['electron', 'vitest', '@effect/vitest', '@ted/daemon']) {
      expect(byName.has(left), left).toBe(false)
    }
    expect(placements).toContainEqual({ dir: byName.get('yaml')?.dir, at: 'node_modules/yaml' })
    expect(placements.some((p) => p.at.includes('react'))).toBe(false)
  })

  test('the licenses start with TED’s agent-orchestrator attribution and cover every package', async () => {
    const text = await thirdPartyLicenses(repoRoot)

    expect(text.indexOf('agent-orchestrator')).toBeLessThan(text.indexOf('yaml'))
    expect(text).toContain('https://github.com/OrchestratorInc/agent-orchestrator')
    expect(text).toContain('Apache License')
    expect(text).toContain('Copyright 2026 Untrivial')
    expect(text).toContain('Attribution written by TED:')
    expect(text).toContain('packages/daemon/src/tasks/github-activity.ts')
    expect(text).toContain('APPENDIX: How to apply the Apache License to your work.')
    expect(text).not.toContain('this attribution stands in for it')
    expect(text).toMatch(/^react \d+\.\d+\.\d+ · MIT$/m)
    expect(text).toMatch(/^react-markdown \d+\.\d+\.\d+ · MIT$/m)
    expect(text).toMatch(/^remark-gfm \d+\.\d+\.\d+ · MIT$/m)
    expect(text).toMatch(/^@fontsource-variable\/geist \d+\.\d+\.\d+ · OFL-1\.1$/m)
    expect(text).toMatch(/^electron \d+\.\d+\.\d+ · MIT$/m)
    expect(text).toContain('SIL OPEN FONT LICENSE')
  })
})
