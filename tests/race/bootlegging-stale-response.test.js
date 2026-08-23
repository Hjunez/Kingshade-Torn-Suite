/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installBootleggingUserscript,
  removeBootleggingTestGlobals,
} from '../../test-support/bootlegging.js';
import { deferred, flushMicrotasks } from '../../test-support/deferred.js';
import { readJsonFixture, readRepositoryFile } from '../../test-support/repository.js';

/** @typedef {{ DB: Record<string, unknown> }} CrimesPayload */
/** @typedef {{ newer: CrimesPayload, older: CrimesPayload }} ResponseFixtures */

describe('Bootlegging response ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    removeBootleggingTestGlobals();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('rejects an older response that resolves after the newest response', async () => {
    document.body.innerHTML = await readRepositoryFile('tests/fixtures/bootlegging-shell.html');
    const fixtures = /** @type {ResponseFixtures} */ (
      await readJsonFixture('bootlegging-responses.json')
    );
    const olderBody = deferred();
    const newerBody = deferred();
    const responseBodies = new Map([
      ['https://www.torn.com/page.php?sid=crimesData&request=older', olderBody.promise],
      ['https://www.torn.com/page.php?sid=crimesData&request=newer', newerBody.promise],
    ]);

    const fetchMock = vi.fn(
      /** @param {RequestInfo | URL} input */
      async (input) => {
        const body = responseBodies.get(String(input));
        if (!body) throw new Error(`Unexpected fetch URL: ${String(input)}`);
        return responseWithDeferredJson(body);
      },
    );
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      value: fetchMock,
      writable: true,
    });

    await installBootleggingUserscript();

    const olderRequest = window.fetch('https://www.torn.com/page.php?sid=crimesData&request=older');
    const newerRequest = window.fetch('https://www.torn.com/page.php?sid=crimesData&request=newer');
    await Promise.all([olderRequest, newerRequest]);

    newerBody.resolve(fixtures.newer);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(71);

    expect(document.querySelector('[aria-label="Copying Action"]')?.classList).toContain(
      'ks-boot-copy-target',
    );

    olderBody.resolve(fixtures.older);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    expect(document.querySelector('[aria-label="Copying Action"]')?.classList).toContain(
      'ks-boot-copy-target',
    );
    expect(document.querySelector('[aria-label="Copying Comedy"]')?.classList).not.toContain(
      'ks-boot-copy-target',
    );
  });
});

/**
 * @param {Promise<unknown>} body
 * @returns {Response}
 */
function responseWithDeferredJson(body) {
  const response = {
    clone: () => responseWithDeferredJson(body),
    json: () => body,
    ok: true,
  };
  return /** @type {Response} */ (/** @type {unknown} */ (response));
}
