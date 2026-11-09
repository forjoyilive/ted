import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import root from '../../../../../vitest.config.ts'

const support = (file: string) => fileURLToPath(new URL(`../../support/${file}`, import.meta.url))

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['leaky.fixture.ts'],
    globalSetup: [support('global-setup.ts')],
    setupFiles: [support('setup.ts')],
    env: root.test?.env ?? {},
  },
})
