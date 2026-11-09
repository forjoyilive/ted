import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    env: {
      TED_GH_BIN: fileURLToPath(
        new URL('./packages/daemon/test/fixtures/stub-gh.ts', import.meta.url),
      ),
      TED_LOGIN_SHELL: 'off',
    },
  },
})
