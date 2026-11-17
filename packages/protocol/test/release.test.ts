import { describe, expect, test } from 'vitest'
import { newIssueUrl } from '../src/release.ts'

describe('the new issue link', () => {
  const body = (url: string) => new URL(url).searchParams.get('body') ?? ''

  test('opens a new issue on the release repo', () => {
    expect(newIssueUrl(true)).toMatch(/^https:\/\/github\.com\/forjoyilive\/ted\/issues\/new\?/)
  })

  test('asks for the pasted report only when Ted copied one', () => {
    expect(body(newIssueUrl(true))).toContain('paste it here')
    expect(body(newIssueUrl(false))).not.toContain('clipboard')
    expect(body(newIssueUrl(false))).toContain('couldn’t make a diagnostic report')
  })
})
