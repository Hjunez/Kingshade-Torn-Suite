/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installBootleggingUserscript,
  removeBootleggingTestGlobals,
} from '../../test-support/bootlegging.js';
import { readRepositoryFile } from '../../test-support/repository.js';

/**
 * Coverage note — read before extending this file.
 *
 * Bootlegging Clean 4.1.1 derived its recommendation from Torn's own crimesData
 * responses, which it intercepted by wrapping window.fetch. A fixture holding
 * only the copy buttons was therefore enough to drive the full "highlight the
 * lowest-stock genre" behaviour, and the previous version of this file asserted
 * exactly that.
 *
 * Advisor 5.2.14 removed the fetch wrapper entirely and reads the rendered stats
 * panel instead. Reproducing that path needs a capture of the real Bootlegging
 * stats DOM, and no such capture exists in `Torn Captures/` yet — the ones on
 * hand are Crimes and Hustling. Rather than invent a stats-panel fixture from
 * guesswork, which would produce a green test that proves nothing, the
 * behavioural assertion is deliberately not carried over here.
 *
 * What remains below is the part that is genuinely verifiable without that
 * capture: the script boots, identifies itself, owns exactly its own DOM, keeps
 * its hands off the page when it has no data, and removes everything it added on
 * destroy. Restore the recommendation assertions once a real stats-panel capture
 * lands in tests/fixtures/.
 */
describe('Bootlegging Advisor DOM behavior', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    removeBootleggingTestGlobals();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('boots on the crimes route and exposes its lifecycle controller', async () => {
    document.body.innerHTML = await readRepositoryFile('tests/fixtures/bootlegging-page.html');

    const controller = await installBootleggingUserscript();

    expect(controller.version).toBe('5.2.14');
    expect(typeof controller.destroy).toBe('function');
  });

  it('injects exactly one owned style element and nothing else', async () => {
    document.body.innerHTML = await readRepositoryFile('tests/fixtures/bootlegging-page.html');

    await installBootleggingUserscript();

    expect(document.getElementById('ksba-v5211-global-styles')).not.toBeNull();
    expect([...document.querySelectorAll('[id^="ks"]')].map((node) => node.id)).toEqual([
      'ksba-v5211-global-styles',
    ]);
  });

  it('leaves the native buttons untouched while it has no stats data', async () => {
    document.body.innerHTML = await readRepositoryFile('tests/fixtures/bootlegging-page.html');
    const before = document.querySelector('main')?.innerHTML;

    await installBootleggingUserscript();

    // No stats panel is present, so there is nothing to recommend. The script
    // must not guess, and must not mark a genre on no evidence.
    expect(document.querySelectorAll('.ks-boot-copy-target')).toHaveLength(0);
    expect(document.querySelectorAll('.ks-boot-sell-target')).toHaveLength(0);
    expect(document.querySelector('main')?.innerHTML).toBe(before);
  });

  it('removes everything it added when destroyed', async () => {
    document.body.innerHTML = await readRepositoryFile('tests/fixtures/bootlegging-page.html');
    const before = document.body.innerHTML;

    const controller = await installBootleggingUserscript();
    controller.destroy();

    expect(document.getElementById('ksba-v5211-global-styles')).toBeNull();
    expect(document.querySelectorAll('[id^="ks"]')).toHaveLength(0);
    expect(document.body.innerHTML).toBe(before);
    expect(Reflect.get(window, '__ksBootleggingAssistantClean')).toBeUndefined();
  });
});
