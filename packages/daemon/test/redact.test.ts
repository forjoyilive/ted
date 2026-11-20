import { randomBytes } from 'node:crypto'
import { encodePairingLink } from '@ted/protocol'
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

  test('removes pairing links and 32-byte keys and secrets in base64url', () => {
    const key = () => randomBytes(32).toString('base64url')
    const link = encodePairingLink({
      v: 1,
      edition: 'dev',
      relay: 'http://127.0.0.1:8787',
      channel: key(),
      macKey: key(),
      pairing: randomBytes(16).toString('base64url'),
      secret: key(),
      expiresAt: 1795135669031,
    })
    expect(redactSecrets(`made ${link} for the phone`)).toBe(
      'made ted-pair:[redacted] for the phone',
    )
    const secret = 'Ab3_' + 'x'.repeat(35) + '9-Zq'
    expect(secret).toHaveLength(43)
    expect(redactSecrets(`secret ${secret}.`)).toBe('secret [redacted].')
    expect(redactSecrets(`{"secret":"${secret}"}`)).toBe('{"secret":"[redacted]"}')
    for (let i = 0; i < 20; i++) {
      const value = key()
      if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) continue
      expect(redactSecrets(`key=${value}`)).toBe('key=[redacted]')
    }
    const signing = randomBytes(64).toString('base64url')
    if (/[0-9]/.test(signing)) expect(redactSecrets(`k ${signing}`)).toBe('k [redacted]')
  })

  test('leaves 16- and 24-byte IDs, longer words and other lengths alone', () => {
    const id = 'AAECAwQFBgcICQoLDA0ODw'
    const nonce = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX'
    const letters = 'a'.repeat(43)
    const longer = `${'b1'.repeat(22)}`
    for (const text of [id, nonce, letters, longer]) expect(redactSecrets(text)).toBe(text)
  })

  test('leaves ordinary text, SSH remotes and paths alone', () => {
    const text = 'git@github.com:kriya/notebook.git · /Users/me/.ted/runs · sk-1 · task-runner'
    expect(redactSecrets(text)).toBe(text)
  })
})
