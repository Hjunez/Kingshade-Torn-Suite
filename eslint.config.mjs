import js from '@eslint/js';
import globals from 'globals';
import { KS_FORBIDDEN_SYNTAX } from './tools/compliance-syntax.mjs';

const knownUnusedBindings =
  '^(extractEstimateFragment|findCommonContainer|formatRwRunway|lastPublicBasicFetchAt|publicBasicRequestSerial|tornTransportFailureStreak|tornUserBasicCapability)$';

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
          // `const { button, ...row } = x` is the omit idiom: the named sibling
          // exists precisely so it is left out of the rest. Not dead code.
          ignoreRestSiblings: true,
          varsIgnorePattern: knownUnusedBindings,
        },
      ],
    },
  },
  {
    // War Dibs PDA 1.5.167 är en förseglad, runtime-verifierad build. Den bär
    // ett tomt `if (selfPlayerId) {}` — rester efter en borttagen väg, utan
    // körbar effekt. En enda ändrad byte i filen bryter bindningen till den
    // artefakt ägaren faktiskt kört i telefonen, så resten städas i nästa
    // PDA-version i stället för här.
    files: ['KS_Torn_War_Dibs.user.js', 'KS_Torn_War_Dibs_PDA_v1.5.167.user.js'],
    rules: {
      'no-empty': 'off',
    },
  },
  {
    // KS compliance-baseline för allt nytt delat källkodslager.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-restricted-syntax': ['error', ...KS_FORBIDDEN_SYNTAX],
      'no-restricted-globals': [
        'error',
        {
          name: 'unsafeWindow',
          message: 'KS: unsafeWindow kringgår sandlådan — motivera eller undvik.',
        },
      ],
    },
  },
  {
    // Compliance-lagret självt måste få använda de primitiver det vaktar.
    files: ['src/compliance/**/*.js'],
    rules: {
      'no-restricted-syntax': 'off',
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
