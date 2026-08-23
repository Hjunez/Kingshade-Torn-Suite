import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const repositoryRoot = path.resolve(process.cwd());

/**
 * @param {...string} segments
 * @returns {string}
 */
export function repositoryPath(...segments) {
  return path.join(repositoryRoot, ...segments);
}

/**
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
export function readRepositoryFile(relativePath) {
  return readFile(repositoryPath(relativePath), 'utf8');
}

/**
 * @template T
 * @param {string} fixtureName
 * @returns {Promise<T>}
 */
export async function readJsonFixture(fixtureName) {
  const text = await readRepositoryFile(path.join('tests', 'fixtures', fixtureName));
  return /** @type {T} */ (JSON.parse(text));
}
