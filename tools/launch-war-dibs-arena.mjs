import { chromium } from '@playwright/test';

import { launchWarDibsArena } from '../test-support/war-dibs-arena.js';
import { repositoryPath } from '../test-support/repository.js';

const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const unknownArgs = args.filter((argument) => argument !== '--smoke');

if (unknownArgs.length > 0) {
  console.error(
    `Unknown arena argument${unknownArgs.length === 1 ? '' : 's'}: ${unknownArgs.join(' ')}`,
  );
  console.error('Usage: node tools/launch-war-dibs-arena.mjs [--smoke]');
  process.exitCode = 2;
} else {
  await runArena();
}

async function runArena() {
  /** @type {import('@playwright/test').Browser | undefined} */
  let browser;
  /** @type {Awaited<ReturnType<typeof launchWarDibsArena>> | undefined} */
  let arena;
  /** @type {Promise<void> | undefined} */
  let closePromise;

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        if (arena) await arena.close();
      } finally {
        if (browser?.isConnected()) await browser.close();
      }
    })();
    return closePromise;
  };

  /** @param {NodeJS.Signals} signal */
  const requestClose = (signal) => {
    console.log(`\nReceived ${signal}; closing the War Dibs arena...`);
    void close().catch((error) => {
      console.error('Arena shutdown failed.');
      console.error(formatError(error));
      process.exitCode = 1;
    });
  };

  /** @param {unknown} error */
  const failAndClose = (error) => {
    console.error('\nWar Dibs arena stopped unexpectedly.');
    console.error(formatError(error));
    process.exitCode = 1;
    void close().catch((closeError) => {
      console.error('Arena shutdown failed.');
      console.error(formatError(closeError));
    });
  };

  process.once('SIGINT', () => requestClose('SIGINT'));
  process.once('SIGTERM', () => requestClose('SIGTERM'));
  process.once('SIGHUP', () => requestClose('SIGHUP'));
  process.once('uncaughtException', failAndClose);
  process.once('unhandledRejection', failAndClose);

  try {
    browser = await chromium.launch({
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--no-default-browser-check',
        '--no-first-run',
        ...(smoke ? [] : ['--start-maximized']),
      ],
      channel: 'chrome',
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      headless: smoke,
    });

    arena = await launchWarDibsArena(browser, {
      smoke,
      viewport: smoke ? { height: 720, width: 1280 } : null,
    });
    const startup = await arena.snapshot();
    const safetyEvents = Object.values(startup.safety).reduce(
      (count, events) => count + events.length,
      0,
    );
    if (safetyEvents !== 0)
      throw new Error(`Arena startup recorded ${safetyEvents} safety events.`);

    if (smoke) {
      await arena.page.locator('#ks-war-dibs-test-arena').waitFor({
        state: 'attached',
        timeout: 10_000,
      });
      await arena.page.locator('#ks-twd-v1517-panel').waitFor({
        state: 'visible',
        timeout: 10_000,
      });
      const rowCount = await arena.page.locator('#faction_war_list_id li.enemy').count();
      if (rowCount === 0) throw new Error('The offline arena mounted without any player rows.');
      console.log(`War Dibs arena smoke check passed in Google Chrome (${rowCount} rows).`);
      return;
    }

    console.log(`War Dibs offline arena opened in Google Chrome ${browser.version()}.`);
    console.log(`Loaded ${startup.production.version} from:`);
    console.log(repositoryPath('KS_Torn_War_Dibs.user.js'));
    console.log(
      'OFFLINE: Torn and FFScouter transports are deterministic mocks; live requests are blocked.',
    );
    console.log('Close the Chrome window or press Ctrl+C in this terminal to stop it.');
    await arena.waitUntilClosed();
  } catch (error) {
    console.error('Unable to launch the War Dibs arena with installed Google Chrome.');
    console.error(formatError(error));
    process.exitCode = 1;
  } finally {
    await close().catch((error) => {
      console.error('Arena cleanup failed.');
      console.error(formatError(error));
      process.exitCode = 1;
    });
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
