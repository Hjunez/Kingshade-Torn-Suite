import { describe, expect, it } from 'vitest';

import { KS_LESLIE_SYSTEM_PROMPT } from '../src/prompt.js';

describe('KS Leslie system prompt', () => {
  it('contains core scope and safety invariants', () => {
    expect(KS_LESLIE_SYSTEM_PROMPT).toContain('Work only on Torn City');
    expect(KS_LESLIE_SYSTEM_PROMPT).toContain('Never expose secrets or API keys');
    expect(KS_LESLIE_SYSTEM_PROMPT).toContain('Torn API access is read-only');
    expect(KS_LESLIE_SYSTEM_PROMPT).toContain('avoid patch stacking');
    expect(KS_LESLIE_SYSTEM_PROMPT).toContain('Torn PDA');
  });
});
