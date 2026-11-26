import { RuleTester } from '../shared/rule-tester.ts'

import { noModuleMockingRule } from './no-module-mocking.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
const error = { messageId: 'moduleMock' }

tester.run('anti-slop/no-module-mocking', noModuleMockingRule, {
  valid: [
    'const store = new InMemoryUserStore();',
    "vi.spyOn(store, 'save');",
    'const vi = { mock() {} }; vi.mock();',
    'function test(jest: { mock(): void }) { jest.mock(); }',
    "import { vi as localVi } from './helpers'; localVi.mock('./module');",
    "import * as helpers from './helpers'; helpers.vi.mock('./module');",
    "import * as vitest from 'vitest'; vitest.expect(1).toBe(1);",
    "const globalThis = { vi: { mock() {} } }; globalThis.vi.mock('./module');",
    "const { spyOn } = vi; spyOn(store, 'save');",
    'const mock = () => {}; mock();',
    "const { mock } = { mock() {} }; mock('./module');",
    "vi.importActual('./module');",
  ],
  invalid: [
    { code: "vi.mock('./user-store');", errors: [error] },
    { code: "jest.mock('./user-store');", errors: [error] },
    { code: "vi['doMock']('./user-store');", errors: [error] },
    { code: "jest.unstable_mockModule('./user-store');", errors: [error] },
    { code: "import { vi } from 'vitest'; vi.mock('./user-store');", errors: [error] },
    {
      code: "import { vi as testApi } from 'vitest'; testApi.mock('./user-store');",
      errors: [error],
    },
    {
      code: "import { jest } from '@jest/globals'; jest.mock('./user-store');",
      errors: [error],
    },
    {
      code: "import * as vitest from 'vitest'; vitest.vi.mock('./user-store');",
      errors: [error],
    },
    {
      code: "import * as globals from '@jest/globals'; globals.jest.mock('./user-store');",
      errors: [error],
    },
    { code: "globalThis.vi.mock('./user-store');", errors: [error] },
    { code: "globalThis['jest'].doMock('./user-store');", errors: [error] },
    { code: "const { mock } = vi; mock('./user-store');", errors: [error] },
    { code: "const { doMock: replace } = jest; replace('./user-store');", errors: [error] },
    { code: "const { mock } = globalThis.vi; mock('./user-store');", errors: [error] },
    { code: "const mock = vi.mock; mock('./user-store');", errors: [error] },
    { code: "vi.importMock('./user-store');", errors: [error] },
    { code: "jest.requireMock('./user-store');", errors: [error] },
    { code: "jest.createMockFromModule('./user-store');", errors: [error] },
    { code: "jest.setMock('./user-store', {});", errors: [error] },
  ],
})
