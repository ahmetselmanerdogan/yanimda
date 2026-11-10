// @ts-check
// T-001b: tek lint standardı (flat config). Biçim Prettier'dadır; ESLint yalnız kod kalitesi + import sırası.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  {
    files: ['**/*.js'],
    ignores: ['eslint.config.js', 'commitlint.config.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['packages/simulator/**', 'packages/rules/validate.mjs', '**/src/db/cli.ts', '**/*.spec.ts', '**/test/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // k6 betikleri (Go içinde çalışan JS): k6 globalleri, ES modülü
    files: ['infra/k6/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', open: 'readonly' },
    },
    rules: { 'no-console': 'off', '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
