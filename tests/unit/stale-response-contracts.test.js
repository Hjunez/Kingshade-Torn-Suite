import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from '../../test-support/repository.js';

describe('stale-response defense contracts', () => {
  it('retains Bootlegging stale-capture protection', async () => {
    const source = await readRepositoryFile('Kingshades_Bootlegging_Advisor_v5.2.14.user.js');

    // Advisor 5.2.14 reads the rendered stats panel instead of observing Torn's
    // own crimesData responses, so the serial guard that ordered intercepted
    // fetch replies (Bootlegging Clean 4.1.1) was replaced by a capture
    // generation. The contract is unchanged: work started under an older
    // generation must never apply on top of newer work.
    expect(source).toContain('statsCaptureGeneration: 0,');
    expect(source).toContain('const generation = ++state.statsCaptureGeneration;');
    expect(source).toContain('generation !== state.statsCaptureGeneration');

    // The guard has to be read before any capture is applied, not after.
    expect(source.indexOf('generation !== state.statsCaptureGeneration')).toBeLessThan(
      source.indexOf('const generation = ++state.statsCaptureGeneration;'),
    );
  });

  it('no longer wraps the page fetch implementation', async () => {
    const source = await readRepositoryFile('Kingshades_Bootlegging_Advisor_v5.2.14.user.js');

    // Bootlegging Clean 4.1.1 monkey-patched window.fetch to inspect Torn's
    // crimesData traffic. Advisor drops that entirely — it must stay dropped.
    expect(source).not.toMatch(/\bfetch\b/);
    expect(source).not.toContain('XMLHttpRequest');
    expect(source).not.toContain('crimesData');
  });

  it('retains lifecycle and abort guards in both DIBS clients', async () => {
    const [warDibs, callGuard] = await Promise.all([
      readRepositoryFile('KS_Torn_War_Dibs.user.js'),
      readRepositoryFile('KS_FFScouter_Call_Guard.user.js'),
    ]);

    // War Dibs 1.5.145 and Call Guard 1.1.3 rewrote these guards from a negative
    // early-return ("generation !== runtimeGeneration || !runtimeActive") into a
    // positive isCurrentRequest() predicate. The contract is unchanged and in
    // fact stricter: both now also pin the request serial / authority epoch and
    // the credential in use, so a reply that outlives its generation, its key or
    // its route is discarded rather than applied.
    expect(warDibs).toContain('const generation = runtimeGeneration;');
    expect(warDibs).toContain('const isCurrentRequest = () => (');
    expect(warDibs).toContain('generation === runtimeGeneration');
    expect(warDibs).toContain('runtimeActive');
    expect(warDibs).toContain('isRuntimeEligible()');

    expect(callGuard).toContain('const controller = new AbortController();');
    expect(callGuard).toContain('const isCurrentRequest = () => (');
    expect(callGuard).toContain('sharedReadAbortController === controller');
    expect(callGuard).toContain('runtimeForeground');
    expect(callGuard).toContain('sharedReadAbortController.abort();');
  });
});
