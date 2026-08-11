import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import prettier from 'eslint-config-prettier'
import reactPerf from 'eslint-plugin-react-perf'
import security from 'eslint-plugin-security'
import globals from 'globals'

const sourceFiles = ['**/*.{js,mjs,cjs,ts,tsx}']

export default defineConfig([
  globalIgnores([
    '**/.next/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/dist/**',
    '**/build/**',
    '**/.turbo/**',
    '**/.vercel/**',
    '**/tsconfig.tsbuildinfo',
    '**/*.min.js',
    '**/public/**',
  ]),
  js.configs.recommended,
  ...nextVitals,
  ...nextTs,
  reactPerf.configs.flat.recommended,
  {
    name: 'hexical/source-policy',
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      security,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
        node: {
          extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
        },
      },
      'import/extensions': ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-alert': 'error',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-unsafe-finally': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'import/export': 'error',
      'import/first': 'error',
      'import/no-absolute-path': 'error',
      'import/no-duplicates': 'error',
      'import/no-named-default': 'error',
      'import/no-relative-packages': 'error',
      'import/no-unresolved': 'error',
      'import/order': [
        'warn',
        {
          alphabetize: { order: 'asc', caseInsensitive: true },
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          'newlines-between': 'never',
          pathGroups: [{ pattern: '@/**', group: 'internal' }],
          pathGroupsExcludedImportTypes: ['builtin', 'external'],
        },
      ],
      'import/no-cycle': ['warn', { maxDepth: 2 }],
      'import/no-dynamic-require': 'error',
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-object-injection': 'off',
      'security/detect-unsafe-regex': 'error',
      'security/detect-child-process': 'warn',
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'react-perf/jsx-no-new-array-as-prop': ['warn', { nativeAllowList: 'all' }],
      'react-perf/jsx-no-new-function-as-prop': ['warn', { nativeAllowList: 'all' }],
      'react-perf/jsx-no-new-object-as-prop': ['warn', { nativeAllowList: 'all' }],
    },
  },
  {
    name: 'hexical/trusted-process-boundary',
    files: ['lib/tty/tty-process-runtime.ts'],
    rules: {
      'security/detect-child-process': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    name: 'hexical/optional-telemetry-loader',
    files: ['lib/hexical/telemetry.ts'],
    rules: {
      'no-new-func': 'off',
      'security/detect-eval-with-expression': 'off',
    },
  },
  // The repository predates the React Compiler rules now bundled with Next.
  // Keep the diagnostics visible while the remaining legacy call sites are
  // migrated; correctness and security rules introduced above remain errors.
  {
    name: 'hexical/legacy-debt-baseline',
    files: sourceFiles,
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'import/no-duplicates': 'warn',
      'no-control-regex': 'warn',
      'no-duplicate-imports': 'warn',
      'no-useless-escape': 'warn',
      'object-shorthand': 'warn',
      'prefer-const': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react/no-unescaped-entities': 'warn',
      'security/detect-unsafe-regex': 'warn',
    },
  },
  prettier,
])
