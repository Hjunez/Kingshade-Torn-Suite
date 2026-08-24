import { describe, expect, it } from 'vitest';

import { KINGSHADE_PROJECTS } from '../src/repository/registry.js';
import {
  KS_LESLIE_TEST_PROFILES,
  requireAvailableTestProfile,
  resolveTestProfile,
  validateTestProfileReferences,
} from '../src/worker/test-profiles.js';

describe('Worker test profiles', () => {
  it('resolves only reviewed commands from the current remote branch as available', () => {
    expect(requireAvailableTestProfile(KS_LESLIE_TEST_PROFILES, 'suite-layout').steps).toEqual([
      {
        executable: 'node',
        args: ['tools/run-suite-validator.mjs'],
        workingDirectory: '.',
        timeoutMs: 60_000,
      },
    ]);
    expect(requireAvailableTestProfile(KS_LESLIE_TEST_PROFILES, 'userscript-syntax').steps).toEqual(
      [
        {
          executable: 'node',
          args: ['tools/check-js-syntax.mjs'],
          workingDirectory: '.',
          timeoutMs: 120_000,
        },
      ],
    );
    expect(requireAvailableTestProfile(KS_LESLIE_TEST_PROFILES, 'leslie-verify').steps).toEqual([
      {
        executable: 'npm',
        args: ['ci', '--ignore-scripts'],
        workingDirectory: 'ks-torn-ai',
        timeoutMs: 300_000,
      },
      {
        executable: 'npm',
        args: ['run', 'verify'],
        workingDirectory: 'ks-torn-ai',
        timeoutMs: 300_000,
      },
    ]);
  });

  it('represents discovered local-only and currently broken profiles explicitly', () => {
    expect(resolveTestProfile(KS_LESLIE_TEST_PROFILES, 'war-dibs-desktop')).toMatchObject({
      availability: 'unavailable',
      source: 'local-only commit 32e57b2',
    });
    expect(
      resolveTestProfile(KS_LESLIE_TEST_PROFILES, 'kingshade-development-verify'),
    ).toMatchObject({
      availability: 'unavailable',
      source: 'local-only commits d8ed012 and b5dc756',
    });
  });

  it('covers every profile id referenced by the canonical project registry', () => {
    const referenced = KINGSHADE_PROJECTS.flatMap((project) => project.testProfiles);
    expect(validateTestProfileReferences(KS_LESLIE_TEST_PROFILES, referenced)).toEqual([]);
  });

  it('returns null for an unregistered command profile', () => {
    expect(resolveTestProfile(KS_LESLIE_TEST_PROFILES, 'arbitrary-shell-command')).toBeNull();
    expect(validateTestProfileReferences(KS_LESLIE_TEST_PROFILES, ['war-dibs-desktop'])).toEqual([
      'referenced test profile is unavailable: war-dibs-desktop',
    ]);
  });
});
