import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = path.join(repositoryRoot, 'tools', 'validate-suite.sh');

const windowsCandidates = [
  ...(process.env.BASH_PATH ? [process.env.BASH_PATH] : []),
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
];

const bash =
  process.platform === 'win32'
    ? windowsCandidates.find((candidate) => existsSync(candidate))
    : process.env.BASH_PATH || 'bash';

if (!bash) {
  console.error('Bash was not found. Install Git for Windows or set BASH_PATH.');
  process.exit(1);
}

const result = spawnSync(bash, [validator], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
