import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OpenAIConversationsSession } from '@openai/agents';
import { z } from 'zod';

const stateSchema = z.object({
  conversationId: z.string().min(1),
});

export async function createPersistentSession(
  stateDir: string,
): Promise<OpenAIConversationsSession> {
  const stateFile = join(stateDir, 'conversation.json');

  try {
    const raw = await readFile(stateFile, 'utf8');
    const saved = stateSchema.parse(JSON.parse(raw));
    return new OpenAIConversationsSession({ conversationId: saved.conversationId });
  } catch (error: unknown) {
    const isMissingFile =
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT';

    if (!isMissingFile) {
      throw error;
    }
  }

  const session = new OpenAIConversationsSession();
  const conversationId = await session.getSessionId();

  await mkdir(stateDir, { recursive: true });
  await writeFile(stateFile, `${JSON.stringify({ conversationId }, null, 2)}\n`, 'utf8');

  return session;
}
