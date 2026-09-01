#!/usr/bin/env node
/**
 * KS metadata-grind.
 *
 * Kontrollerar varje byggd .user.js mot KS-projektreglerna:
 *   1. Filen börjar DIREKT med "// ==UserScript==" (ingen banner, ingen "use strict").
 *   2. Metadatablocket är komplett och kommer före all kod.
 *   3. @match är begränsat till torn.com.
 *   4. @connect tillåter endast api.torn.com.
 *   5. @version finns, är semver och matchar package.json.
 *   6. @grant är explicit (ingen tyst standard).
 *   7. Inga API-nycklar eller sourcemap-referenser läcker med i bygget.
 *
 * Användning:
 *   node tools/check-metadata.mjs dist
 *   node tools/check-metadata.mjs dist/ks-market-advisor.user.js
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import process from 'node:process';

const ALLOWED_CONNECT = new Set(['api.torn.com']);
const MATCH_PATTERN = /^https:\/\/(www\.)?torn\.com\//;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const APIKEY_LEAK = /(api[_-]?key|tornkey)\s*[:=]\s*['"][A-Za-z0-9]{16}['"]/i;

/** @type {string[]} */
const problems = [];
/** @type {string[]} */
const checked = [];

/**
 * @param {string} file
 * @param {string} msg
 */
function fail(file, msg) {
  problems.push(`${file}: ${msg}`);
}

/**
 * @param {string} target
 * @returns {Promise<string[]>}
 */
async function collect(target) {
  const info = await stat(target);
  if (info.isFile()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];
  for (const e of entries) {
    const p = join(target, e.name);
    if (e.isDirectory()) files.push(...(await collect(p)));
    else if (e.name.endsWith('.user.js')) files.push(p);
    else if (extname(e.name) === '.js' && !e.name.endsWith('.user.js')) {
      fail(p, 'Byggutdata innehåller en fristående .js — userscript ska vara EN fil.');
    }
  }
  return files;
}

/**
 * @param {string} src
 * @returns {{ keys: Map<string, string[]>, bodyStart: number } | null}
 */
function parseMeta(src) {
  const startTag = '// ==UserScript==';
  const endTag = '// ==/UserScript==';
  const end = src.indexOf(endTag);
  if (end < 0) return null;
  const block = src.slice(startTag.length, end);
  /** @type {Map<string, string[]>} */
  const keys = new Map();
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*\/\/\s*@(\S+)\s*(.*)$/);
    const key = m?.[1];
    if (!key) continue;
    const bucket = keys.get(key) ?? [];
    bucket.push((m?.[2] ?? '').trim());
    keys.set(key, bucket);
  }
  return { keys, bodyStart: end + endTag.length };
}

async function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('Användning: node tools/check-metadata.mjs <fil|katalog> [...]');
    process.exit(2);
  }

  let pkgVersion = null;
  try {
    pkgVersion = JSON.parse(await readFile('package.json', 'utf8')).version ?? null;
  } catch {
    // package.json är valfri — versionsjämförelsen hoppas då över.
  }

  const files = [];
  for (const t of targets) files.push(...(await collect(t)));

  if (files.length === 0) {
    console.error('Inga .user.js hittades — byggde du innan grinden kördes?');
    process.exit(2);
  }

  for (const file of files) {
    checked.push(file);
    const src = await readFile(file, 'utf8');

    // 1. Måste börja direkt med metadatablocket.
    if (!src.startsWith('// ==UserScript==')) {
      const firstLine = (src.split('\n', 1)[0] ?? '').slice(0, 60);
      fail(
        file,
        `Filen börjar inte med "// ==UserScript==" utan med: ${JSON.stringify(firstLine)}`,
      );
      continue;
    }

    const meta = parseMeta(src);
    if (!meta) {
      fail(file, 'Metadatablocket saknar "// ==/UserScript==".');
      continue;
    }
    const { keys } = meta;

    // 3. @match
    const matches = keys.get('match') ?? [];
    if (matches.length === 0) fail(file, '@match saknas — skriptet skulle köra överallt.');
    for (const m of matches) {
      if (!MATCH_PATTERN.test(m)) fail(file, `@match utanför torn.com: ${m}`);
    }
    if (keys.has('include')) {
      fail(file, '@include är för löst — använd @match.');
    }

    // 4. @connect
    for (const c of keys.get('connect') ?? []) {
      if (!ALLOWED_CONNECT.has(c)) fail(file, `Otillåten @connect: ${c} (endast api.torn.com).`);
    }

    // 5. @version
    const versions = keys.get('version') ?? [];
    if (versions.length !== 1) fail(file, '@version ska finnas exakt en gång.');
    else {
      const v = versions[0] ?? '';
      if (!SEMVER.test(v)) fail(file, `@version är inte semver: ${v}`);
      else if (pkgVersion && v !== pkgVersion) {
        fail(
          file,
          `@version ${v} matchar inte package.json ${pkgVersion} (en huvudändring per version).`,
        );
      }
    }

    // 6. @grant
    if (!keys.has('grant')) fail(file, '@grant saknas — deklarera explicit, även "@grant none".');

    // Obligatoriska fält för spårbarhet.
    for (const required of ['name', 'namespace', 'description']) {
      if (!keys.has(required)) fail(file, `@${required} saknas.`);
    }

    // 7. Läckage.
    if (APIKEY_LEAK.test(src)) fail(file, 'Möjlig hårdkodad API-nyckel i bygget.');
    if (/\/\/# sourceMappingURL=/.test(src)) {
      fail(file, 'sourceMappingURL i userscript — stäng av sourcemaps i produktionsbygget.');
    }
    if (src.includes('###PDA-APIKEY###') && !file.includes('pda')) {
      fail(file, 'PDA-nyckelplatshållare i ett icke-PDA-bygge.');
    }
  }

  console.log(`Metadata-grind: kontrollerade ${checked.length} fil(er).`);
  for (const f of checked) console.log(`  · ${f}`);

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem:`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('\n✓ Alla metadata-krav uppfyllda.');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
