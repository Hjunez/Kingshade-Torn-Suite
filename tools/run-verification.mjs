import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
const stages = [
  'validate:suite',
  'syntax',
  'lint',
  'format:check',
  'typecheck',
  'test',
  'test:browser',
];

if (!npmCli) {
  console.error('Run this verification pipeline through npm: npm run verify');
  process.exit(1);
}

const npmCliPath = npmCli;

/** @param {string} stage */
function runStage(stage) {
  console.log(`\n=== npm run ${stage} ===`);
  const result = spawnSync(process.execPath, [npmCliPath, 'run', stage], {
    env: { ...process.env, TZ: 'UTC' },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const stage of stages) runStage(stage);

console.log('\nAll repository verification stages passed.');
