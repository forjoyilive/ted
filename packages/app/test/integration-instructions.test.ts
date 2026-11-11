import { integrationInstallPages } from '@ted/protocol'
import { expect, test, vi } from 'vitest'
import { openIntegrationInstructions } from '../src/integration-instructions.ts'

test.each(Object.values(integrationInstallPages))(
  'opens official instructions: %s',
  async (url) => {
    const open = vi.fn(async () => {})
    await openIntegrationInstructions(url, open)
    expect(open).toHaveBeenCalledExactlyOnceWith(url)
  },
)

test.each([
  'https://example.com/',
  'https://git-scm.com/install/linux?redirect=evil',
  'https://git-scm.com.evil.test/install/linux',
  'file:///etc/passwd',
  'javascript:alert(1)',
])('refuses an unrecognized destination: %s', async (url) => {
  const open = vi.fn(async () => {})
  await expect(openIntegrationInstructions(url, open)).rejects.toThrow(
    'Unknown integration instructions page',
  )
  expect(open).not.toHaveBeenCalled()
})
