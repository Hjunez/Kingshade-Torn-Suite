import { expect, test } from '@playwright/test';
import { readRepositoryFile, repositoryPath } from '../../test-support/repository.js';

test('published Bootlegging userscript runs and cleans up in Chromium', async ({ page }) => {
  /** @type {Error[]} */
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.setContent(await readRepositoryFile('tests/fixtures/bootlegging-page.html'));
  await page.evaluate(() => {
    Object.defineProperty(window, 'unsafeWindow', {
      configurable: true,
      value: window,
      writable: true,
    });
  });
  await page.addScriptTag({
    path: repositoryPath('Kingshades_Bootlegging_Clean_v4.1.1.user.js'),
  });

  const action = page.locator('[aria-label^="Copying Action"]');
  await expect(action).toHaveClass(/ks-boot-copy-target/);
  await expect(page.locator('.ks-boot-copy-target')).toHaveCount(1);
  await expect(page.locator('#ks-boot-clean-v411-styles')).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__ksBootleggingAssistantClean')?.version))
    .toBe('4.1.1');

  await page.evaluate(() => Reflect.get(window, '__ksBootleggingAssistantClean')?.destroy());

  await expect(page.locator('.ks-boot-copy-target')).toHaveCount(0);
  await expect(page.locator('#ks-boot-clean-v411-styles')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
