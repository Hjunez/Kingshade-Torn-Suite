/** @vitest-environment jsdom */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  detachedHustlingRoot,
  installHustlingUserscript,
  removeHustlingTestGlobals,
} from '../../test-support/hustling.js';

/**
 * Parser and decision-engine coverage for KS Torn Hustling Advisor PC.
 *
 * The fixtures under tests/fixtures/hustling/ are the hustling-root subtrees of
 * real PC captures (Chrome 151, 1168x738, route #/hustling), reduced to structure:
 * Torn's narrative prose was replaced with a placeholder and decorative SVG
 * scaffolding was dropped. Every class name, aria-label and amount below is what
 * Torn actually rendered.
 *
 * The engine under test is the one inside the published userscript. Nothing is
 * re-implemented here, so a green run says something about the shipped file.
 */

/** @type {import('../../test-support/hustling.js').HustlingInternals} */
let internals;

beforeAll(async () => {
  const controller = await installHustlingUserscript();
  internals = controller.internals;
});

afterEach(() => {
  removeHustlingTestGlobals();
  document.body.innerHTML = '';
});

/**
 * @param {string} fixture
 * @param {{ attentionThreshold?: number }} [options]
 */
async function adviseOn(fixture, options) {
  const root = await detachedHustlingRoot(fixture);
  const state = internals.readState(root);
  return { root, state, result: internals.decide(state, options) };
}

describe('audience label parsing', () => {
  it('reads the short member label exactly as Torn writes it', () => {
    expect(
      internals.parseAudienceMemberLabel('Member 2 betting, attention 6 suspicion 0 wealth 6'),
    ).toMatchObject({
      index: 2,
      betting: true,
      attention: 6,
      suspicion: 0,
      wealth: 6,
      parsed: true,
    });
  });

  it('reads the long percentage member label into the same shape', () => {
    expect(
      internals.parseAudienceMemberLabel(
        'Audience member 1 of 4, betting, attention 88% suspicion 0% wealth 5 out of 12',
      ),
    ).toMatchObject({
      index: 1,
      total: 4,
      betting: true,
      attention: 88,
      suspicion: 0,
      wealth: 5,
      wealthMax: 12,
      parsed: true,
    });
  });

  it('marks a non-betting member as not betting', () => {
    expect(
      internals.parseAudienceMemberLabel('Member 3 attention 53 suspicion 0 wealth 5'),
    ).toMatchObject({
      betting: false,
      attention: 53,
    });
  });

  it('parses every verified audience summary shape', () => {
    expect(internals.parseAudienceSummary('No audience')).toMatchObject({
      parsed: true,
      people: 0,
      bets: 0,
    });
    expect(internals.parseAudienceSummary('1 person, no bets')).toMatchObject({
      parsed: true,
      people: 1,
      bets: 0,
    });
    expect(internals.parseAudienceSummary('4 people, no bets')).toMatchObject({
      parsed: true,
      people: 4,
      bets: 0,
    });
    expect(internals.parseAudienceSummary('4 people, 1 bet, $177 in total')).toMatchObject({
      parsed: true,
      people: 4,
      bets: 1,
      totalBet: 177,
    });
    expect(internals.parseAudienceSummary('4 people, 2 bets, $2,159 in total')).toMatchObject({
      parsed: true,
      people: 4,
      bets: 2,
      totalBet: 2159,
    });
  });

  it('reports an unknown summary wording as unparsed instead of guessing', () => {
    const summary = internals.parseAudienceSummary('a modest crowd has assembled');
    expect(summary.parsed).toBe(false);
    expect(summary.people).toBeNull();
  });
});

describe('action label parsing', () => {
  it('takes the nerve cost from the aria-label, not from the icon digit', () => {
    expect(internals.parseActionLabel('Gather, 4 nerve')).toEqual({
      name: 'Gather',
      kind: 'GATHER',
      nerve: 4,
    });
    expect(internals.parseActionLabel('Demo, 2 nerve')).toEqual({
      name: 'Demo',
      kind: 'DEMO',
      nerve: 2,
    });
    expect(internals.parseActionLabel('Hype, 2 nerve')).toEqual({
      name: 'Hype',
      kind: 'HYPE',
      nerve: 2,
    });
  });

  it('tells Win and Lose apart on the word alone', () => {
    expect(internals.parseActionLabel('Lose, 2 nerve')).toMatchObject({ kind: 'LOSE' });
    expect(internals.parseActionLabel('Win, 2 nerve')).toMatchObject({ kind: 'WIN' });
  });

  it('does not read a block reason as an action', () => {
    expect(internals.parseActionLabel("You don't have enough nerve")).toBeNull();
    expect(internals.parseActionLabel("There's no audience")).toBeNull();
    expect(internals.parseActionLabel('Requires crime level 60')).toBeNull();
  });

  it('classifies an unknown but well-shaped action as OTHER, never as recommendable', () => {
    expect(internals.parseActionLabel('Collect, 2 nerve')).toMatchObject({
      name: 'Collect',
      kind: 'OTHER',
    });
  });

  it('parses money the way Torn prints it', () => {
    expect(internals.parseMoney('$0')).toBe(0);
    expect(internals.parseMoney('$177')).toBe(177);
    expect(internals.parseMoney('$2,159')).toBe(2159);
    expect(internals.parseMoney('$4,328')).toBe(4328);
    expect(internals.parseMoney('soon')).toBeNull();
  });
});

describe('outcome classification', () => {
  it('classifies an intentional loss as SUCCESS, despite the word "lost" in the text', async () => {
    const { state } = await adviseOn('audience-no-bets-hype.html');
    const expanded = state.rows.filter((/** @type {any} */ row) => row.outcome !== null);

    expect(expanded).toHaveLength(1);
    expect(expanded[0].outcome.result).toBe('SUCCESS');
    expect(expanded[0].outcome.classes).toEqual(['crimes-outcome-success']);

    const rewardText = (await detachedHustlingRoot('audience-no-bets-hype.html')).textContent ?? '';
    expect(rewardText).toContain('Intentionally lost $1,848');
  });

  it('classifies crimes-outcome-failure as FAILURE and warns about the chain', async () => {
    const { state, result } = await adviseOn('failure-outcome-no-nerve.html');
    const expanded = state.rows.filter((/** @type {any} */ row) => row.outcome !== null);

    expect(expanded).toHaveLength(1);
    expect(expanded[0].outcome.result).toBe('FAILURE');
    expect(result.warnings.join(' ')).toMatch(/FAILURE — crime chain at risk/);
  });

  it('treats an invented third outcome class as unknown, never as a critical failure', async () => {
    const root = await detachedHustlingRoot('failure-outcome-no-nerve.html');
    const content = root.querySelector('.outcome-content');
    expect(content).not.toBeNull();
    content?.classList.remove('crimes-outcome-failure');
    content?.classList.add('crimes-outcome-critical-failure');

    const state = internals.readState(root);
    const expanded = state.rows.filter((/** @type {any} */ row) => row.outcome !== null);

    expect(expanded[0].outcome.result).toBe('UNKNOWN');
    expect(internals.decide(state).warnings.join(' ')).toMatch(/unrecognised class/);
    expect(internals.decide(state).warnings.join(' ')).not.toMatch(/critical/i);
  });

  it('classifies outcome classes purely from Torn’s own class list', () => {
    expect(internals.classifyOutcomeClasses(['outcome-content', 'crimes-outcome-success'])).toBe(
      'SUCCESS',
    );
    expect(internals.classifyOutcomeClasses(['outcome-content', 'crimes-outcome-failure'])).toBe(
      'FAILURE',
    );
    expect(internals.classifyOutcomeClasses(['outcome-content'])).toBe('UNKNOWN');
    expect(
      internals.classifyOutcomeClasses(['crimes-outcome-success', 'crimes-outcome-failure']),
    ).toBe('UNKNOWN');
  });
});

describe('row state', () => {
  it('reads a Hype row as having no active bet', async () => {
    const { state } = await adviseOn('audience-no-bets-hype.html');
    const snail = state.rows.find((/** @type {any} */ row) => row.name === 'Snail Racing');

    expect(snail.hasActiveBet).toBe(false);
    expect(snail.actions.map((/** @type {any} */ action) => action.kind)).toEqual(['HYPE']);
  });

  it('reads a Lose/Win row as having an active bet and reads the stake from betAmount', async () => {
    const one = await adviseOn('active-bet-one-bet.html');
    const oneSnail = one.state.rows.find((/** @type {any} */ row) => row.name === 'Snail Racing');
    expect(oneSnail.hasActiveBet).toBe(true);
    expect(oneSnail.bet).toBe(177);

    const two = await adviseOn('active-bet-two-bets-no-nerve.html');
    const twoSnail = two.state.rows.find((/** @type {any} */ row) => row.name === 'Snail Racing');
    expect(twoSnail.hasActiveBet).toBe(true);
    expect(twoSnail.bet).toBe(2159);
  });

  it('keeps a nerve-blocked bet in the state instead of losing it', async () => {
    // A blocked button loses its action word: Torn replaced BOTH "Lose, 2 nerve"
    // and "Win, 2 nerve" with "You don't have enough nerve" while a $4,328 stake
    // was still on the table. Until 0.1.2 that made the bet vanish from the state.
    const { state, result } = await adviseOn('failure-outcome-no-nerve.html');
    const snail = state.rows.find((/** @type {any} */ row) => row.name === 'Snail Racing');

    expect(snail.bet).toBe(4328);
    expect(snail.hasActiveBet).toBe(true);
    expect(snail.betBlocked).toBe(true);
    expect(snail.betBlockedReason).toBe("You don't have enough nerve");
    expect(snail.actions.map((/** @type {any} */ action) => action.kind)).toEqual([
      'UNKNOWN',
      'UNKNOWN',
    ]);
    expect(result.warnings[0]).toBe(
      'Snail Racing has an active $4,328 bet you cannot act on: "You don\'t have enough nerve"',
    );
    // Everything else on this board is blocked too, so BLOCKED mode still applies.
    expect(result.action).toBe('HOLD');
  });

  it('lets a stale outcome box sit open without overwriting the current bet', async () => {
    // This capture has a SUCCESS box still expanded on Snail Racing from the
    // previous action while a fresh $177 bet is already live on the same row.
    // The advice has to come from the buttons and betAmount that are on screen
    // now, never from the older outcome box's text.
    const { state, result } = await adviseOn('active-bet-one-bet.html');
    const snail = state.rows.find((/** @type {any} */ row) => row.name === 'Snail Racing');

    expect(snail.outcome.result).toBe('SUCCESS');
    expect(snail.bet).toBe(177);
    expect(snail.hasActiveBet).toBe(true);
    expect(result.target).toBe('Snail Racing');
    expect(['WIN', 'LOSE']).toContain(result.action);
  });

  it('reads the audience summary and members out of the audience row', async () => {
    const { state } = await adviseOn('active-bet-two-bets-no-nerve.html');

    expect(state.audience.summary).toMatchObject({
      parsed: true,
      people: 4,
      bets: 2,
      totalBet: 2159,
    });
    expect(state.audience.members).toHaveLength(4);
    expect(state.audience.members.filter((/** @type {any} */ m) => m.betting)).toHaveLength(2);
  });

  it('ignores the decorative banner audience nodes that carry no aria-label', async () => {
    const root = await detachedHustlingRoot('active-bet-two-bets-no-nerve.html');
    const everythingNamedAudienceMember = root.querySelectorAll('[class*="audienceMember"]');
    const state = internals.readState(root);

    expect(everythingNamedAudienceMember.length).toBeGreaterThan(state.audience.members.length);
    expect(state.audience.members).toHaveLength(4);
  });

  it('reads Torn’s own result counters', async () => {
    const { state } = await adviseOn('active-bet-two-bets-no-nerve.html');
    expect(state.counters).toEqual({ successes: 108, fails: 7, criticalFails: 1 });
  });
});

describe('recommendation', () => {
  it('recommends Gather when there is no audience and Gather is enabled', async () => {
    const { state, result } = await adviseOn('no-audience.html');

    expect(state.audience.summary).toMatchObject({ parsed: true, people: 0 });
    expect(result.action).toBe('GATHER');
    expect(result.nerve).toBe(4);
    expect(result.confidence).toBe('high');
  });

  it("holds with Torn's own reason when every action is blocked by “There's no audience”", async () => {
    const root = await detachedHustlingRoot('no-audience.html');
    const gather = root.querySelector('button.commit-button[aria-label="Gather, 4 nerve"]');
    expect(gather).not.toBeNull();
    gather?.classList.add('disabled');
    gather?.setAttribute('aria-disabled', 'true');
    gather?.setAttribute('aria-label', "There's no audience");

    const result = internals.decide(internals.readState(root));

    expect(result.action).toBe('HOLD');
    expect(result.blockedReason).toBe("There's no audience");
    expect(result.reason).toContain("There's no audience");
  });

  it("holds on “You don't have enough nerve” and never assumes a refill", async () => {
    const { result } = await adviseOn('failure-outcome-no-nerve.html');

    expect(result.action).toBe('HOLD');
    expect(result.blockedReason).toBe("You don't have enough nerve");
    expect(result.reason).not.toMatch(/refill|point/i);
  });

  it('recommends Hype on the row that offers it when there is no active bet', async () => {
    const { result } = await adviseOn('audience-no-bets-hype.html');

    expect(result.action).toBe('HYPE');
    expect(result.target).toBe('Snail Racing');
    expect(result.nerve).toBe(2);
  });

  it('recommends Lose when the betting audience is below the attention threshold', async () => {
    // Threshold passed explicitly: this case is about the comparison, not about
    // whatever the shipped default happens to be this version.
    const { result } = await adviseOn('active-bet-one-bet.html', { attentionThreshold: 50 });

    // The single bettor sits at attention 6, far below the threshold under test.
    expect(result.action).toBe('LOSE');
    expect(result.target).toBe('Snail Racing');
    expect(result.nerve).toBe(2);
    expect(result.reason).toContain('below the 50 community threshold');
  });

  it('recommends Win once the betting audience is at or above the threshold', async () => {
    // Same real fixture, lower threshold: the bettors sit at attention 29 and 53.
    const { result } = await adviseOn('active-bet-two-bets-no-nerve.html', {
      attentionThreshold: 20,
    });

    expect(result.action).toBe('WIN');
    expect(result.target).toBe('Snail Racing');
    expect(result.nerve).toBe(2);
  });

  it('prefers the audience-preserving Lose when attention cannot be read at all', async () => {
    const root = await detachedHustlingRoot('active-bet-two-bets-no-nerve.html');
    for (const member of root.querySelectorAll('[class*="audienceMember"][aria-label]')) {
      member.setAttribute('aria-label', 'Member betting, mood unclear');
    }

    const result = internals.decide(internals.readState(root));

    expect(result.action).toBe('LOSE');
    expect(result.confidence).toBe('low');
    expect(result.reason).toContain('could not be read');
  });

  it('never suggests Shill or Pickpocket while Torn says they are level locked', async () => {
    for (const fixture of [
      'no-audience.html',
      'one-member-gather-success.html',
      'audience-no-bets-hype.html',
      'active-bet-one-bet.html',
      'active-bet-two-bets-no-nerve.html',
      'failure-outcome-no-nerve.html',
    ]) {
      const { state, result } = await adviseOn(fixture);

      const locked = state.rows.filter((/** @type {any} */ row) => row.locked);
      expect(locked.map((/** @type {any} */ row) => row.name)).toEqual(['Shill', 'Pickpocket']);
      expect(
        locked.flatMap((/** @type {any} */ row) =>
          row.actions.map((/** @type {any} */ action) => action.label),
        ),
      ).toEqual(['Requires crime level 60', 'Requires crime level 80']);
      expect(result.target).not.toBe('Shill');
      expect(result.target).not.toBe('Pickpocket');
    }
  });

  it('reports low confidence when several actions are genuinely equivalent', async () => {
    const { result } = await adviseOn('one-member-gather-success.html');

    // Four games all offer nothing but Demo, and nothing visible separates them.
    expect(result.action).toBe('DEMO');
    expect(result.confidence).toBe('low');
    expect(result.reason).toMatch(/equivalent Demo/);
  });

  it('waits instead of guessing when there is no readable view', () => {
    const result = internals.decide(internals.readState(null));

    expect(result.action).toBe('WAIT');
    expect(result.confidence).toBe('low');
  });

  it('never puts a numeric CE value in a recommendation', async () => {
    for (const fixture of [
      'no-audience.html',
      'one-member-gather-success.html',
      'audience-no-bets-hype.html',
      'active-bet-one-bet.html',
      'active-bet-two-bets-no-nerve.html',
      'failure-outcome-no-nerve.html',
    ]) {
      const { result } = await adviseOn(fixture);
      const text = [result.reason, ...result.warnings].join(' ');

      expect(text).not.toMatch(/\bCE\b/);
      expect(text).not.toMatch(/crime experience/i);
      // The community CS-per-nerve numbers stay out of the advice text entirely.
      expect(text).not.toMatch(/112[.,]5|37[.,]5|\bCS\b/);
    }
  });

  it('warns about suspicion above zero without claiming the scale is verified', async () => {
    const root = await detachedHustlingRoot('active-bet-two-bets-no-nerve.html');
    const first = root.querySelector('[class*="audienceMember"][aria-label]');
    first?.setAttribute('aria-label', 'Member 1 attention 53 suspicion 40 wealth 5');

    const warnings = internals.decide(internals.readState(root)).warnings.join(' ');

    expect(warnings).toMatch(/Suspicion is above 0/);
    expect(warnings).toMatch(/assumption, not verified/);
  });

  it('surfaces demoralization straight from Torn’s own skill label', async () => {
    const { state, result } = await adviseOn('active-bet-two-bets-no-nerve.html');

    expect(state.skill).toEqual({
      level: 12,
      progressPercent: 46,
      demoralization: 'Low demoralization',
    });
    expect(result.warnings.join(' ')).toContain('Low demoralization');
  });

  it('refuses to recommend an action whose label it does not recognise', async () => {
    const root = await detachedHustlingRoot('audience-no-bets-hype.html');
    const hype = root.querySelector('button.commit-button[aria-label="Hype, 2 nerve"]');
    hype?.setAttribute('aria-label', 'Bamboozle, 2 nerve');

    const result = internals.decide(internals.readState(root));

    expect(result.action).not.toBe('HYPE');
    expect(result.target).not.toBe('Snail Racing');
    expect(['DEMO', 'GATHER', 'HOLD']).toContain(result.action);
  });
});

/**
 * The 0.1.2 change: a bet the player cannot act on must stay in the state.
 *
 * Torn overwrites a blocked button's aria-label with the block reason, so once
 * both bet buttons are blocked there is no action word left to read the row's
 * state from. 0.1.1 concluded "no bet" and advised Demo while a $5,190 stake sat
 * on screen.
 *
 * The DOM shape below is the real capture: both commit buttons carrying `disabled`
 * and `aria-disabled="true"` with the reason as their label, next to a non-zero
 * betAmount. The money wording and the $5,190 amount are the owner's runtime
 * record of 2026-09-08 09:27:34 (balance $248). The nerve variant of the same
 * shape is covered above against the unmodified failure capture.
 */
describe('a blocked bet', () => {
  const MONEY_REASON = "You're not carrying enough money";

  /**
   * Blocks Snail Racing's Lose/Win pair the way Torn does, at a chosen stake.
   *
   * @param {Element} root
   * @param {string} amountText
   * @param {string} reason
   */
  function blockSnailRacingBet(root, amountText, reason) {
    const snail = [...root.querySelectorAll('.crime-option')].find((option) =>
      /Snail Racing/.test(option.textContent ?? ''),
    );
    if (!snail) throw new Error('Fixture has no Snail Racing row.');

    const amount = snail.querySelector('[class*="betAmount"]');
    if (amount) amount.textContent = amountText;

    for (const button of snail.querySelectorAll('button.commit-button')) {
      button.classList.add('disabled');
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-label', reason);
    }
    return snail;
  }

  /**
   * @param {string} fixture
   * @param {string} [amountText]
   * @param {string} [reason]
   */
  async function blockedBoard(fixture, amountText = '$5,190', reason = MONEY_REASON) {
    const root = await detachedHustlingRoot(fixture);
    blockSnailRacingBet(root, amountText, reason);
    return internals.readState(root);
  }

  it('keeps the bet, marks it blocked and quotes Torn word for word', async () => {
    const state = await blockedBoard('active-bet-two-bets-no-nerve.html');
    const snail = state.rows.find((/** @type {any} */ row) => row.name === 'Snail Racing');

    expect(snail.bet).toBe(5190);
    expect(snail.hasActiveBet).toBe(true);
    expect(snail.betBlocked).toBe(true);
    expect(snail.betBlockedReason).toBe(MONEY_REASON);
  });

  it('warns first, naming the game, the amount and the reason, apostrophe intact', async () => {
    const result = internals.decide(await blockedBoard('active-bet-two-bets-no-nerve.html'));

    expect(result.warnings[0]).toBe(
      'Snail Racing has an active $5,190 bet you cannot act on: "You\'re not carrying enough money"',
    );
    expect(result.warnings[0]).toContain("You're not");
  });

  it('still recommends the best feasible action rather than forcing HOLD', async () => {
    const result = internals.decide(await blockedBoard('active-bet-two-bets-no-nerve.html'));

    // Cornhole, Find the Lady and Shell Game still offer an enabled Demo.
    expect(result.action).toBe('DEMO');
    expect(result.target).toBe('Cornhole');
  });

  it('lowers confidence one step against the same board without the block', async () => {
    // A row that has been demoed shows Hype, which is an unambiguous 'medium'.
    const withoutBlock = await detachedHustlingRoot('active-bet-two-bets-no-nerve.html');
    const cornhole = [...withoutBlock.querySelectorAll('.crime-option')].find((option) =>
      /Cornhole/.test(option.textContent ?? ''),
    );
    cornhole?.querySelector('button.commit-button')?.setAttribute('aria-label', 'Hype, 2 nerve');
    // Snail Racing's bet stays actionable here, so remove it to isolate the Hype.
    for (const button of [...withoutBlock.querySelectorAll('button.commit-button')]) {
      if (/^(Lose|Win),/.test(button.getAttribute('aria-label') ?? '')) button.remove();
    }
    const baseline = internals.decide(internals.readState(withoutBlock));
    expect(baseline.action).toBe('HYPE');
    expect(baseline.confidence).toBe('medium');

    const blocked = await detachedHustlingRoot('active-bet-two-bets-no-nerve.html');
    const blockedCornhole = [...blocked.querySelectorAll('.crime-option')].find((option) =>
      /Cornhole/.test(option.textContent ?? ''),
    );
    blockedCornhole
      ?.querySelector('button.commit-button')
      ?.setAttribute('aria-label', 'Hype, 2 nerve');
    blockSnailRacingBet(blocked, '$5,190', MONEY_REASON);
    const result = internals.decide(internals.readState(blocked));

    expect(result.action).toBe('HYPE');
    expect(result.confidence).toBe('low');
  });

  it('leaves an empty $0 row alone and raises no false warning', async () => {
    const { state, result } = await adviseOn('audience-no-bets-hype.html');
    const cornhole = state.rows.find((/** @type {any} */ row) => row.name === 'Cornhole');

    expect(cornhole.bet).toBe(0);
    expect(cornhole.betBlocked).toBe(false);
    expect(cornhole.hasActiveBet).toBe(false);
    expect(result.warnings.join(' ')).not.toContain('you cannot act on');
  });

  it('treats an unreadable bet amount as unknown, not as "no bet"', async () => {
    const root = await detachedHustlingRoot('audience-no-bets-hype.html');
    const snail = [...root.querySelectorAll('.crime-option')].find((option) =>
      /Snail Racing/.test(option.textContent ?? ''),
    );
    const amount = snail?.querySelector('[class*="betAmount"]');
    if (amount) amount.textContent = 'pending…';

    const state = internals.readState(root);
    const row = state.rows.find(
      (/** @type {any} */ candidate) => candidate.name === 'Snail Racing',
    );
    const result = internals.decide(state);

    expect(row.bet).toBeNull();
    expect(row.betUnreadable).toBe(true);
    expect(row.betBlocked).toBe(false);
    // The Hype that row was offering is no longer recommended — the row is unknown.
    expect(result.target).not.toBe('Snail Racing');
    expect(result.warnings.join(' ')).toContain('bet amount that could not be read ("pending…")');
  });

  it('leaves an actionable Lose/Win row completely unchanged', async () => {
    const { state, result } = await adviseOn('active-bet-two-bets-no-nerve.html');
    const snail = state.rows.find((/** @type {any} */ row) => row.name === 'Snail Racing');

    expect(snail.hasActiveBet).toBe(true);
    expect(snail.betBlocked).toBe(false);
    expect(snail.betBlockedReason).toBeNull();
    expect(result.warnings.join(' ')).not.toContain('you cannot act on');
    expect(result.action).toBe('LOSE');
  });

  it('names both rows when two bets are blocked at once', async () => {
    const root = await detachedHustlingRoot('active-bet-two-bets-no-nerve.html');
    blockSnailRacingBet(root, '$5,190', MONEY_REASON);
    const cornhole = [...root.querySelectorAll('.crime-option')].find((option) =>
      /Cornhole/.test(option.textContent ?? ''),
    );
    const cornholeAmount = cornhole?.querySelector('[class*="betAmount"]');
    if (cornholeAmount) cornholeAmount.textContent = '$1,102';
    for (const button of cornhole?.querySelectorAll('button.commit-button') ?? []) {
      button.classList.add('disabled');
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-label', MONEY_REASON);
    }

    const warnings = internals.decide(internals.readState(root)).warnings;

    expect(warnings[0]).toContain('Cornhole has an active $1,102 bet');
    expect(warnings[1]).toContain('Snail Racing has an active $5,190 bet');
  });
});

/**
 * The 0.1.1 change: the attention threshold moved from 50 to 60.
 *
 * Two independent community sources describe a band (up over 60, back down to
 * around 40) rather than a single line. Only the upper bound is implemented, so
 * the boundary these cases pin is 60, inclusive: "at or above" reads WIN.
 *
 * The 53 and 65 cases are real measurements from the owner's 2026-09-08 session
 * (07:56:31 and 07:57:18). 53 is the point where this version's advice genuinely
 * differs from 0.1.0-alpha.1; 65 is a control that must NOT have changed.
 */
describe('the 60 attention boundary', () => {
  /**
   * Rewrites the audience so exactly one member is betting at a chosen attention.
   * Everything else about the fixture — the enabled Lose/Win pair on Snail Racing —
   * is the real capture.
   *
   * @param {number} attention
   */
  async function bettorAt(attention) {
    const root = await detachedHustlingRoot('active-bet-two-bets-no-nerve.html');
    const members = [...root.querySelectorAll('[class*="audienceMember"][aria-label]')];
    members.forEach((member, index) => {
      member.setAttribute(
        'aria-label',
        index === 0
          ? `Member 1 betting, attention ${attention} suspicion 0 wealth 5`
          : `Member ${index + 1} attention 20 suspicion 0 wealth 5`,
      );
    });
    return internals.readState(root);
  }

  it('ships 60 as the default threshold', () => {
    expect(internals.ATTENTION_THRESHOLD).toBe(60);
  });

  it('reads LOSE at attention 59, just under the boundary', async () => {
    const result = internals.decide(await bettorAt(59));

    expect(result.action).toBe('LOSE');
    expect(result.reason).toContain('below the 60 community threshold');
  });

  it('reads WIN at attention 60, exactly on the boundary', async () => {
    const result = internals.decide(await bettorAt(60));

    expect(result.action).toBe('WIN');
    expect(result.reason).toContain('at or above the 60 community threshold');
  });

  it('reads WIN at attention 61', async () => {
    expect(internals.decide(await bettorAt(61)).action).toBe('WIN');
  });

  it('reads LOSE at attention 53 — the behaviour that changed in 0.1.1', async () => {
    // 0.1.0-alpha.1 read WIN here, because 53 cleared its threshold of 50.
    expect(internals.decide(await bettorAt(53)).action).toBe('LOSE');
  });

  it('still reads WIN at attention 65 — a control that must not have changed', async () => {
    expect(internals.decide(await bettorAt(65)).action).toBe('WIN');
  });

  it('lets options.attentionThreshold override the default back to 50', async () => {
    const state = await bettorAt(53);

    expect(internals.decide(state, { attentionThreshold: 50 }).action).toBe('WIN');
    expect(internals.decide(state).action).toBe('LOSE');
  });
});

describe('the harness itself', () => {
  it('exposes the published version and the documented internals surface', async () => {
    const controller = await installHustlingUserscript();

    expect(controller.version).toBe('0.1.2');
    expect(controller.status).toBe('CANDIDATE');
    expect(controller.mode).toBe('MAX CE + CS');
    expect(controller.internals.ATTENTION_THRESHOLD).toBe(60);
  });
});
