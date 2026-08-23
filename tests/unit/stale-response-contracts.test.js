import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from '../../test-support/repository.js';

describe('stale-response defense contracts', () => {
  it('retains Bootlegging response ordering protection', async () => {
    const source = await readRepositoryFile('Kingshades_Bootlegging_Clean_v4.1.1.user.js');

    expect(source).toContain('const requestSerial = ++state.requestSerial;');
    expect(source).toContain('if (requestSerial < state.latestAppliedSerial)');
    expect(source.indexOf('if (requestSerial < state.latestAppliedSerial)')).toBeLessThan(
      source.indexOf('state.latestAppliedSerial = requestSerial;'),
    );
  });

  it('retains lifecycle and abort guards in both DIBS clients', async () => {
    const [warDibs, callGuard] = await Promise.all([
      readRepositoryFile('KS_Torn_War_Dibs.user.js'),
      readRepositoryFile('KS_FFScouter_Call_Guard.user.js'),
    ]);

    expect(warDibs).toContain('const generation = runtimeGeneration;');
    expect(warDibs).toContain('generation !== runtimeGeneration || !runtimeActive');
    expect(callGuard).toContain('const controller = new AbortController();');
    expect(callGuard).toContain('if (controller.signal.aborted || !runtimeForeground');
  });
});
