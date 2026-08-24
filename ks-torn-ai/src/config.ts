import { z } from 'zod';

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.6-sol'),
  OPENAI_SPECIALIST_MODEL: z.string().min(1).default('gpt-5.6-terra'),
  OPENAI_VECTOR_STORE_ID: z.string().min(1).optional(),
  KS_LESLIE_STATE_DIR: z.string().min(1).default('.state'),
});

export type KsLeslieConfig = {
  openAiModel: string;
  specialistModel: string;
  vectorStoreId?: string;
  stateDir: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KsLeslieConfig {
  const parsed = envSchema.parse(env);

  return {
    openAiModel: parsed.OPENAI_MODEL,
    specialistModel: parsed.OPENAI_SPECIALIST_MODEL,
    ...(parsed.OPENAI_VECTOR_STORE_ID === undefined
      ? {}
      : { vectorStoreId: parsed.OPENAI_VECTOR_STORE_ID }),
    stateDir: parsed.KS_LESLIE_STATE_DIR,
  };
}
