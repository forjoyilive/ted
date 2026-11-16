import { defineConfig } from 'oxlint'

export default defineConfig({
  ignorePatterns: ['**/*.js', '**/*.cjs', '**/*.mjs', 'tools/oxlint/anti-slop/**'],
  categories: {
    correctness: 'off',
    nursery: 'off',
    pedantic: 'off',
    perf: 'off',
    restriction: 'off',
    style: 'off',
    suspicious: 'off',
  },
  plugins: ['oxc'],
  jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }],
  options: {
    reportUnusedDisableDirectives: 'error',
    respectEslintDisableDirectives: false,
  },
  rules: {
    'oxc/no-accumulating-spread': 'error',
    'anti-slop/no-array-filter-map': 'error',
    'anti-slop/no-reduce-accumulator-copy': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-runtime-typeof': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    'anti-slop/require-readable-spacing': 'off',
    'anti-slop/no-shape-in-symbol-names': 'off',
  },
  overrides: [
    {
      files: ['**/test/**', '**/*.test.ts', '**/*.test.tsx', 'scripts/**/*.test.ts'],
      rules: {
        'anti-slop/require-safety-comment-for-type-assertion': 'off',
      },
    },
    {
      files: ['packages/protocol/src/parse.ts'],
      rules: {
        'anti-slop/no-runtime-typeof': 'off',
        'anti-slop/no-unknown-parameters': 'off',
        'anti-slop/no-unknown-returns': 'off',
        'anti-slop/no-unknown-type-aliases': 'off',
        'anti-slop/no-unsafe-dictionary-type': 'off',
      },
    },
  ],
})
