import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses safe default models and state path', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'test-key' });

    expect(config).toEqual({
      openAiModel: 'gpt-5.6-sol',
      specialistModel: 'gpt-5.6-terra',
      stateDir: '.state',
      githubRepository: 'Hjunez/Kingshade-Torn-Suite',
    });
  });

  it('keeps an explicit GitHub repository override', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      KS_LESLIE_GITHUB_REPOSITORY: 'Kingshade/example-suite',
    });

    expect(config.githubRepository).toBe('Kingshade/example-suite');
  });

  it('keeps an optional vector store id', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      OPENAI_VECTOR_STORE_ID: 'vs_test',
    });

    expect(config.vectorStoreId).toBe('vs_test');
  });
});
