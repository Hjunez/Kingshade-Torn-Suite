import js from '@eslint/js';
import globals from 'globals';

const knownUnusedBindings =
  '^(extractEstimateFragment|findCommonContainer|formatRwRunway|tornTransportFailureStreak|tornUserBasicCapability)$';

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.vitest/**',
      '.tmp/**',
    ],
  },
  {
    files: ['*.user.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        GM_xmlhttpRequest: 'readonly',
        unsafeWindow: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^(?:_|row$|rwPhase$)',
          caughtErrors: 'none',
          varsIgnorePattern: knownUnusedBindings,
        },
      ],
    },
  },
  {
    files: ['worker.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.serviceworker,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off',
    },
  },
  {
    files: [
      'eslint.config.mjs',
      '*.config.js',
      'tools/**/*.mjs',
      'test-support/**/*.js',
      'tests/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['test-support/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
