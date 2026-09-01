/**
 * KS compliance-granskning av de publicerade userscripten.
 *
 * Separat config med flit: den här grinden är striktare än vad som är belagt
 * mot Torns officiella regeltext, och de publicerade skripten har i dag träffar
 * som var för sig kan vara helt legitima (en synlig nedräkning som använder
 * setInterval, ett dispatchEvent mot skriptets egen shadow-DOM).
 *
 * Därför gatear den INTE `npm run lint`. Kör den som en rapport:
 *
 *     npm run lint:compliance
 *
 * Arbetsgången: gå igenom träffarna en och en. Är den legitim, lägg ett
 * `// eslint-disable-next-line no-restricted-syntax` med motivering på raden
 * ovanför — då syns undantaget i diffen. Är den inte legitim, fixa koden.
 * När listan är tom kan blocket flyttas in i eslint.config.mjs och bli
 * blockerande.
 */

import globals from 'globals';
import { KS_FORBIDDEN_SYNTAX } from './tools/compliance-syntax.mjs';

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
      'no-restricted-syntax': ['error', ...KS_FORBIDDEN_SYNTAX],
    },
  },
];
