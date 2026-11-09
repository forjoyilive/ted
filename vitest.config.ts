import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    globalSetup: ['packages/daemon/test/support/global-setup.ts'],
    setupFiles: ['packages/daemon/test/support/setup.ts'],
    env: {
      TED_GH_BIN: fileURLToPath(
        new URL('./packages/daemon/test/fixtures/stub-gh.ts', import.meta.url),
      ),
      TED_LOGIN_SHELL: 'off',
      TED_FREE_BYTES_FILE: fileURLToPath(
        new URL('./packages/daemon/test/fixtures/free-bytes.txt', import.meta.url),
      ),
      TED_ONLINE_FILE: fileURLToPath(
        new URL('./packages/daemon/test/fixtures/online.txt', import.meta.url),
      ),
      TED_KEYRING_MODULE: fileURLToPath(
        new URL('./packages/daemon/test/fixtures/stub-keyring.ts', import.meta.url),
      ),
      TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
      TED_STAY_AWAKE: 'off',
      TED_APP_TOKEN: 'test-app-token',
    },
  },
})
