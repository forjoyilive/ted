import { describe, expect, test } from 'vitest'
import { redactSecrets } from '../src/redact.ts'

describe('redactSecrets', () => {
  test('removes the user and password from URLs', () => {
    expect(
      redactSecrets(
        "fatal: unable to access 'https://forjoy:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/k/n.git/'",
      ),
    ).toBe("fatal: unable to access 'https://[redacted]@github.com/k/n.git/'")
    expect(redactSecrets('https://x-access-token:abc@github.com/k/n')).toBe(
      'https://[redacted]@github.com/k/n',
    )
  })

  test('removes token-shaped strings', () => {
    for (const token of [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gho_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123',
      'lin_api_abcdefghijklmnopqrstuvwxyz0123456789',
      'glpat-abcdefghijklmnopqrst',
      'xoxb-1234567890-abcdefghijkl',
      'AKIAABCDEFGHIJKLMNOP',
    ]) {
      expect(redactSecrets(`key ${token} used`), token).toBe('key [redacted] used')
    }
    expect(redactSecrets('Authorization: Bearer abc.def-ghi')).toBe(
      'Authorization: Bearer [redacted]',
    )
  })

  test('leaves ordinary text, SSH remotes and paths alone', () => {
    const text = 'git@github.com:kriya/notebook.git · /Users/me/.ted/runs · sk-1 · task-runner'
    expect(redactSecrets(text)).toBe(text)
  })
})
