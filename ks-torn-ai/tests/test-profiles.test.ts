import { describe, expect, it } from 'vitest';

import { KS_LESLIE_TEST_PROFILES, resolveTestProfile } from '../src/worker/test-profiles.js';

describe('Worker test profiles', () => {
  it('resolves allowlisted profiles by id', () => {
    expect(resolveTestProfile(KS_LESLIE_TEST_PROFILES, 'suite-layout')?.id).toBe('suite-layout');
  });

  it('returns null for an unregistered command profile', () => {
    expect(resolveTestProfile(KS_LESLIE_TEST_PROFILES, 'arbitrary-shell-command')).toBeNull();
  });
});
