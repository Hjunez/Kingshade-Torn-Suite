import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  readJsonFixture,
  readRepositoryFile,
  repositoryRoot,
} from '../../test-support/repository.js';

/**
 * @typedef {{ file: string, name: string, sha256: string, version: string }} UserscriptFixture
 */

/** @type {UserscriptFixture[]} */
const userscripts = await readJsonFixture('userscripts.json');

describe('published userscript integrity', () => {
  it('keeps the deterministic userscript inventory complete', async () => {
    const actualFiles = (await readdir(repositoryRoot))
      .filter((file) => file.endsWith('.user.js'))
      .sort();
    const expectedFiles = userscripts.map(({ file }) => file).sort();

    expect(actualFiles).toEqual(expectedFiles);
  });

  it.each(userscripts)(
    'preserves $file byte-for-byte and retains its metadata',
    async (fixture) => {
      const source = await readRepositoryFile(fixture.file);
      const digest = createHash('sha256').update(source).digest('hex').toUpperCase();

      expect(digest).toBe(fixture.sha256);
      expect(readMetadata(source, 'name')).toBe(fixture.name);
      expect(readMetadata(source, 'version')).toBe(fixture.version);
    },
  );
});

/**
 * @param {string} source
 * @param {'name' | 'version'} field
 * @returns {string}
 */
function readMetadata(source, field) {
  const match = source.match(new RegExp(`^// @${field}\\s+(.+)$`, 'm'));
  if (!match?.[1]) throw new Error(`Missing @${field} userscript metadata.`);
  return match[1].trim();
}
