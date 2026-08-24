import { z } from 'zod';

import { isValidGitHubRepository } from './repository/validation.js';

const optionalEnvironmentString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.6-sol'),
  OPENAI_SPECIALIST_MODEL: z.string().min(1).default('gpt-5.6-terra'),
  OPENAI_VECTOR_STORE_ID: optionalEnvironmentString,
  KS_LESLIE_STATE_DIR: z.string().min(1).default('.state'),
  KS_LESLIE_GITHUB_REPOSITORY: z
    .string()
    .refine(isValidGitHubRepository, 'GitHub repository must be a safe owner/name identifier')
    .default('Hjunez/Kingshade-Torn-Suite'),
  KS_LESLIE_GITHUB_TOKEN: optionalEnvironmentString,
  KS_LESLIE_LOCAL_REPOSITORY_ROOT: optionalEnvironmentString,
});

export interface KsLeslieConfig {
  openAiModel: string;
  specialistModel: string;
  vectorStoreId?: string;
  stateDir: string;
  githubRepository: string;
  githubToken?: string;
  localRepositoryRoot?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KsLeslieConfig {
  const parsed = envSchema.parse(env);

  return {
    openAiModel: parsed.OPENAI_MODEL,
    specialistModel: parsed.OPENAI_SPECIALIST_MODEL,
    ...(parsed.OPENAI_VECTOR_STORE_ID === undefined
      ? {}
      : { vectorStoreId: parsed.OPENAI_VECTOR_STORE_ID }),
    stateDir: parsed.KS_LESLIE_STATE_DIR,
    githubRepository: parsed.KS_LESLIE_GITHUB_REPOSITORY,
    ...(parsed.KS_LESLIE_GITHUB_TOKEN === undefined
      ? {}
      : { githubToken: parsed.KS_LESLIE_GITHUB_TOKEN }),
    ...(parsed.KS_LESLIE_LOCAL_REPOSITORY_ROOT === undefined
      ? {}
      : { localRepositoryRoot: parsed.KS_LESLIE_LOCAL_REPOSITORY_ROOT }),
  };
}
