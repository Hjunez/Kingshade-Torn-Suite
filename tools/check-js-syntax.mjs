import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const ignoredDirectories = new Set([
  '.git',
  '.tmp',
  '.vitest',
  'coverage',
  'node_modules',
  'playwright-report',
  'test-results',
]);

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function collectJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScript(absolutePath)));
    } else if (entry.isFile() && ['.cjs', '.js', '.mjs'].includes(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }

  return files;
}

const files = (await collectJavaScript(repositoryRoot)).sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status ?? 1);
  }
}

console.log(`JavaScript syntax validation passed for ${files.length} files.`);
