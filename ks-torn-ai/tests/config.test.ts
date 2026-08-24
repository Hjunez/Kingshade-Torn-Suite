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

  it('rejects traversal-like GitHub repository components', () => {
    expect(() =>
      loadConfig({
        OPENAI_API_KEY: 'test-key',
        KS_LESLIE_GITHUB_REPOSITORY: '../example-suite',
      }),
    ).toThrow('safe owner/name');
    expect(() =>
      loadConfig({
        OPENAI_API_KEY: 'test-key',
        KS_LESLIE_GITHUB_REPOSITORY: 'Kingshade/..',
      }),
    ).toThrow('safe owner/name');
  });

  it('keeps a trusted local repository root and ignores blank optional settings', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      OPENAI_VECTOR_STORE_ID: '',
      KS_LESLIE_GITHUB_TOKEN: '',
      KS_LESLIE_LOCAL_REPOSITORY_ROOT: 'C:\\repos\\Kingshade-Torn-Suite',
    });

    expect(config.localRepositoryRoot).toBe('C:\\repos\\Kingshade-Torn-Suite');
    expect(config.vectorStoreId).toBeUndefined();
    expect(config.githubToken).toBeUndefined();
  });

  it('keeps an optional vector store id', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      OPENAI_VECTOR_STORE_ID: 'vs_test',
    });

    expect(config.vectorStoreId).toBe('vs_test');
  });
});
