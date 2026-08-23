/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installBootleggingUserscript,
  removeBootleggingTestGlobals,
} from '../../test-support/bootlegging.js';
import { readRepositoryFile } from '../../test-support/repository.js';

describe('Bootlegging userscript DOM behavior', () => {
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

  it('highlights the deterministic lowest-stock genre and cleans up', async () => {
    document.body.innerHTML = await readRepositoryFile('tests/fixtures/bootlegging-page.html');
    const controller = await installBootleggingUserscript();

    await vi.advanceTimersByTimeAsync(501);

    const action = document.querySelector('[aria-label^="Copying Action"]');
    expect(controller.version).toBe('4.1.1');
    expect(action?.classList.contains('ks-boot-copy-target')).toBe(true);
    expect(document.querySelectorAll('.ks-boot-copy-target')).toHaveLength(1);
    expect(document.getElementById('ks-boot-clean-v411-styles')).not.toBeNull();

    controller.destroy();

    expect(document.querySelector('.ks-boot-copy-target')).toBeNull();
    expect(document.getElementById('ks-boot-clean-v411-styles')).toBeNull();
    expect(Reflect.get(window, '__ksBootleggingAssistantClean')).toBeUndefined();
  });
});
