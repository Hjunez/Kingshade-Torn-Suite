import 'dotenv/config';

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { run } from '@openai/agents';

import { createKsLeslieAgent } from './agents.js';
import { loadConfig } from './config.js';
import { createPersistentSession } from './session.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const agent = createKsLeslieAgent(config);
  const session = await createPersistentSession(config.stateDir);
  const terminal = createInterface({ input, output });

  output.write('KS Leslie v0.1.0\nType /exit to quit.\n\n');

  try {
    while (true) {
      const message = (await terminal.question('You> ')).trim();

      if (message.length === 0) {
        continue;
      }

      if (message === '/exit') {
        break;
      }

      const result = await run(agent, message, { session });
      output.write(`\nKS Leslie> ${String(result.finalOutput ?? '')}\n\n`);
    }
  } finally {
    terminal.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
