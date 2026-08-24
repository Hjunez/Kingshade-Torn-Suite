import { describe, expect, it } from 'vitest';

import { KS_TORN_AI_SYSTEM_PROMPT } from '../src/prompt.js';

describe('KS Torn AI system prompt', () => {
  it('contains core scope and safety invariants', () => {
    expect(KS_TORN_AI_SYSTEM_PROMPT).toContain('Work only on Torn City');
    expect(KS_TORN_AI_SYSTEM_PROMPT).toContain('Never expose secrets or API keys');
    expect(KS_TORN_AI_SYSTEM_PROMPT).toContain('Torn API access is read-only');
    expect(KS_TORN_AI_SYSTEM_PROMPT).toContain('avoid patch stacking');
    expect(KS_TORN_AI_SYSTEM_PROMPT).toContain('Torn PDA');
  });
});
