const typescriptEslintPlugin = require('@typescript-eslint/eslint-plugin');

// Flat config (ESLint 9+). Composes typescript-eslint's non-type-checked
// "recommended" rules, scoped to the TypeScript sources. Kept dependency-free:
// it reuses the already-installed @typescript-eslint/eslint-plugin flat presets
// rather than pulling in the typescript-eslint meta package or @eslint/js.
module.exports = [
  {
    ignores: ['out/**', 'dist/**', '.vscode-test/**', 'node_modules/**'],
  },
  ...typescriptEslintPlugin.configs['flat/recommended'].map((config) => ({
    ...config,
    files: ['src/**/*.ts'],
  })),
  {
    // Underscore-prefixed identifiers are an intentional "deliberately unused"
    // convention used across the codebase (e.g. `_options`, `_handler`).
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Test files legitimately need `any` (typed mocks/casts) and `require()`
    // (jest.mock hoisting), so relax those two rules here. Everything else —
    // unused vars, unsafe Function types, etc. — stays enforced.
    files: ['src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
