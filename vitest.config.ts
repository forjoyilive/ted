import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url))

export function tedTestConfig(include: string[]) {
  return defineConfig({
    test: {
      include,
      testTimeout: 30_000,
      globalSetup: [here('./packages/daemon/test/support/global-setup.ts')],
      setupFiles: [here('./packages/daemon/test/support/setup.ts')],
      env: {
        TED_GH_BIN: here('./packages/daemon/test/fixtures/stub-gh.ts'),
        TED_LOGIN_SHELL: 'off',
        TED_FREE_BYTES_FILE: here('./packages/daemon/test/fixtures/free-bytes.txt'),
        TED_KEYRING_MODULE: here('./packages/daemon/test/fixtures/stub-keyring.ts'),
        TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
        TED_STAY_AWAKE: 'off',
        TED_APP_TOKEN: 'test-app-token',
      },
    },
  })
}

export default tedTestConfig(['packages/*/test/**/*.test.ts'])
