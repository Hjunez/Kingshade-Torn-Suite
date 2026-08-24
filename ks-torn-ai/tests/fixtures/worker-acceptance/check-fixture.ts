import { readFileSync } from 'node:fs';

if (process.env.OPENAI_API_KEY || process.env.GITHUB_TOKEN || process.env.NODE_OPTIONS) {
  console.error('sensitive environment reached the synthetic profile');
  process.exit(3);
}

const expected = 'beta\n';
const actual = readFileSync('fixture.txt', 'utf8');
if (actual !== expected) {
  console.error(JSON.stringify({ expected, actual }));
  process.exit(1);
}

console.log(JSON.stringify({ profile: 'suite-layout', status: 'passed' }));
