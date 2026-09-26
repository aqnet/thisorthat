#!/usr/bin/env node
/**
 * Two-player browser smoke test: a whole game on two simulated phones.
 *
 * Runs against a running app (default http://localhost:3000) and the Supabase
 * project it is configured for -- real anonymous sign-in, real Realtime, real
 * database. Start the app and the local timer first:
 *
 *   npm run dev            (terminal 1)
 *   npm run dev:dispatch   (terminal 2)
 *   npm run e2e:smoke      (terminal 3)
 *
 * It creates one room and two anonymous users, and cancels the room at the
 * end. The anonymous users stay in Supabase Auth.
 *
 * Besides "does a game finish", it checks that each phone follows the other
 * within LAG_BUDGET_MS. Without Realtime a phone only catches up on its 10s
 * heartbeat; a game still finishes, so without this check a broken Realtime
 * setup would pass.
 *
 * Env: E2E_MODE=pick_and_fwd (default: Pick your fav), E2E_BASE_URL, E2E_CHROMIUM_PATH (optional; otherwise playwright-core's
 * installed browser: `npx playwright-core install chromium-headless-shell`),
 * E2E_HEADED=1 to watch it.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const OUT = new URL('./.output/', import.meta.url).pathname;
const LAG_BUDGET_MS = 3_000;
/** E2E_MODE=pick_and_fwd plays the Pick and fwd mode instead. */
const MODE = process.env.E2E_MODE === 'pick_and_fwd' ? 'Pick and fwd' : 'Pick your fav';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
  headless: !process.env.E2E_HEADED,
});
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
// Separate contexts = separate storage = two different anonymous users.
const host = await (await browser.newContext(phone)).newPage();
const guest = await (await browser.newContext(phone)).newPage();

const errors = [];
const lags = [];
for (const [who, page] of [['host', host], ['guest', guest]]) {
  page.on('console', (m) => (m.type() === 'error' || m.text().includes('[room] realtime')) && errors.push(`${who}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${who} pageerror: ${e.message}`));
}
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
const t0 = Date.now();
const log = (msg) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${msg}`);
/** How long `page` takes to show `locator` after `since`, recorded against the lag budget. */
async function lag(label, since, locator) {
  await locator.waitFor({ timeout: 20_000 });
  const ms = Date.now() - since;
  lags.push({ label, ms });
  log(`${label}: ${ms}ms`);
}

let code = null;
let failed = false;
let closed = false;
try {
  // 1. Create session. A fresh browser has no remembered name yet.
  await host.goto(BASE);
  await host.getByRole('button', { name: 'New Game' }).click();
  if ((await host.getByPlaceholder('Up to 12 letters').inputValue()) !== '') {
    throw new Error('a fresh browser should not pre-fill a name');
  }
  await host.getByPlaceholder('Up to 12 letters').fill('Ana');
  await host.getByRole('button', { name: 'Create room' }).click();
  await host.waitForURL(/\/room\/[A-Z]{4}$/, { timeout: 20_000 });
  code = host.url().slice(-4);
  await host.getByText('Players · 1 of 4').waitFor({ timeout: 15_000 });
  log(`room ${code} created (${MODE})`);
  await shot(host, '1-lobby');

  // 2. Lobby
  await guest.goto(`${BASE}/join/${code}`);
  await guest.getByPlaceholder('Up to 12 letters').fill('Ben');
  let since = Date.now();
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  await guest.waitForURL(/\/room\//);
  await lag('host sees the guest join', since, host.getByText('Players · 2 of 4'));

  // 3. Host setup
  since = Date.now();
  await host.getByRole('button', { name: 'Start', exact: true }).click();
  await lag('guest sees setup begin', since, guest.getByText('is choosing'));
  // Mode first (mode spec §3a), then the category.
  await host.getByRole('button', { name: new RegExp(`^${MODE}`) }).click();
  if (MODE === 'Pick and fwd') await guest.getByText('Mode so far: Pick and fwd').waitFor({ timeout: 10_000 });
  await host.getByRole('button', { name: 'Fruit', exact: true }).click();
  await host.getByRole('button', { name: '5', exact: true }).click();
  await host.getByRole('button', { name: 'Fruit · 5 items' }).click();
  await shot(host, '3-setup-confirm');
  since = Date.now();
  await host.getByRole('button', { name: 'Start', exact: true }).click();
  await lag('guest enters items after the host confirms', since, guest.getByText("List 5 fruits you'll defend"));

  // 4. Enter items: exact match, suggestion, duplicate, keep mine, Surprise me
  const input = host.getByLabel('Add an item');
  const add = async (text) => {
    await input.fill(text);
    await host.getByRole('button', { name: 'Add', exact: true }).click();
  };
  const listed = (text) => host.locator('li', { hasText: text }).waitFor({ timeout: 10_000 });
  await add('mango');
  await listed('Mango');
  await add('strawbery');
  await host.getByText('Did you mean').waitFor({ timeout: 10_000 });
  await shot(host, '4-suggestion');
  await host.getByRole('button', { name: 'Yes', exact: true }).click();
  await listed('Strawberry');
  await add('MANGO!!');
  await host.getByText('Already on your list').waitFor({ timeout: 10_000 });
  await add("grandma's plum");
  if (await host.getByText('Did you mean').isVisible().catch(() => false)) {
    await host.getByRole('button', { name: 'Keep mine' }).click();
  }
  await listed("Grandma's Plum");
  for (const n of [4, 5]) {
    await host.getByRole('button', { name: '🎲 Surprise me' }).click();
    await host.getByText(`${n} / 5`).waitFor({ timeout: 10_000 });
  }
  await shot(host, '4-entry');
  await host.getByRole('button', { name: 'Submit' }).click();
  await host.getByText('List locked in').waitFor();
  for (let n = 1; n <= 5; n++) {
    await guest.getByRole('button', { name: '🎲 Surprise me' }).click();
    await guest.getByText(`${n} / 5`).waitFor({ timeout: 10_000 });
  }
  await guest.getByRole('button', { name: 'Submit' }).click();
  log('both lists submitted');

  // 5. Match-ups: 5 rounds, the last a Final Showdown
  for (let round = 1; round <= 5; round++) {
    await host.getByText(`Round ${round} of 5`).waitFor({ timeout: 20_000 });
    await guest.getByText(`Round ${round} of 5`).waitFor({ timeout: 20_000 });
    if (round === 1) await shot(host, '5-voting');
    if (round === 5) await host.getByText('Final Showdown').waitFor();
    if (MODE === 'Pick and fwd' && round === 2) {
      // Round 1's winner is carried onto this ballot, pinned first.
      await guest.getByText(/👑 Champion/).first().waitFor({ timeout: 5_000 });
      await shot(guest, '5-champion');
    }
    await host.locator('button[aria-label^="Vote for"]').first().click();
    since = Date.now();
    await guest.locator('button[aria-label^="Vote for"]').first().click();
    // Resolves as soon as both have voted, not when the 15s timer ends.
    await lag(`round ${round}: host sees the reveal after the last vote`, since, host.getByText(/votes?$/).first());
    if (round === 5) await shot(host, '5-reveal-showdown');
    if (MODE === 'Pick and fwd' && round === 1) {
      await host.getByText(/crown|coin flip/).first().waitFor({ timeout: 5_000 });
    }
    await host.getByRole('button', { name: round < 5 ? /^Next/ : /^See results/ }).click();
  }

  // 6. Results
  await host.getByRole('button', { name: 'Play again' }).waitFor({ timeout: 20_000 });
  await guest.getByText('Waiting for Ana').waitFor({ timeout: 20_000 });
  await shot(host, '6-results');
  log('results shown');
  since = Date.now();
  await host.getByRole('button', { name: 'Play again' }).click();
  await lag('guest returns to the lobby on Play Again', since, guest.getByText('Waiting for Ana to start'));

  // 7. Having played a game through, each browser remembers its player's
  // name: the host's New Game sheet and the guest's Join screen pre-fill it.
  const hostHome = await host.context().newPage();
  await hostHome.goto(BASE);
  await hostHome.getByRole('button', { name: 'New Game' }).click();
  const hostName = await hostHome.getByPlaceholder('Up to 12 letters').inputValue();
  await hostHome.getByRole('button', { name: 'Create room' }).click();
  await hostHome.waitForURL(/\/room\/[A-Z]{4}$/, { timeout: 20_000 });
  const code2 = hostHome.url().slice(-4);
  const guestJoin = await guest.context().newPage();
  await guestJoin.goto(`${BASE}/join/${code2}`);
  const nameField = guestJoin.getByPlaceholder('Up to 12 letters');
  await nameField.waitFor();
  await guestJoin.getByText('From your last game').waitFor({ timeout: 10_000 });
  const guestName = await nameField.inputValue();
  if (hostName !== 'Ana' || guestName !== 'Ben') {
    throw new Error(`remembered names wrong: host "${hostName}", guest "${guestName}"`);
  }
  log('names remembered after a finished game: Ana (New Game), Ben (Join)');
  // Close the second room without joining it.
  await hostHome.getByRole('button', { name: 'Menu' }).click();
  await hostHome.getByRole('button', { name: 'Cancel room' }).first().click();
  await hostHome.getByRole('button', { name: 'Cancel room' }).last().click();
  await hostHome.waitForURL(`${BASE}/`, { timeout: 10_000 });
  await Promise.all([hostHome.close(), guestJoin.close()]);

  // 8. Exit from the lobby: confirm, then Home. The guest's seat opens; the
  // host, now alone, closes the room.
  await guest.getByRole('button', { name: 'Exit', exact: true }).click();
  await guest.getByText('Your seat opens up').waitFor();
  await guest.getByRole('button', { name: 'Yes, exit' }).click();
  await guest.waitForURL(`${BASE}/`, { timeout: 10_000 });
  await host.getByText('Players · 1 of 4').waitFor({ timeout: 10_000 });
  await host.getByRole('button', { name: 'Exit', exact: true }).click();
  await host.getByText(`room ${code} will close`).waitFor();
  await host.getByRole('button', { name: 'Yes, exit' }).click();
  await host.waitForURL(`${BASE}/`, { timeout: 10_000 });
  closed = true;
  log('lobby Exit: guest left, then the host closed the empty room');
} catch (error) {
  failed = true;
  console.error(`\nFAILED: ${error.message.split('\n')[0]}`);
  await shot(host, 'failure-host').catch(() => {});
  await shot(guest, 'failure-guest').catch(() => {});
} finally {
  // Cancel the room so it doesn't linger in the shared database.
  if (code && !closed) {
    try {
      await host.goto(`${BASE}/room/${code}`);
      await host.getByRole('button', { name: 'Menu' }).click({ timeout: 10_000 });
      const cancel = host.getByRole('button', { name: /Cancel room|End game for everyone/ });
      await cancel.first().click({ timeout: 5_000 });
      // The confirmation sheet opens on top of the menu, so its button is the last match.
      await host.getByRole('button', { name: /^(Cancel room|End game)$/ }).last().click({ timeout: 5_000 });
      await host.waitForURL(`${BASE}/`, { timeout: 10_000 });
      log(`room ${code} closed`);
    } catch {
      console.error(`could not close room ${code}; it will expire after 2h idle`);
    }
  }
  await browser.close();
}

const slow = lags.filter((l) => l.ms > LAG_BUDGET_MS);
if (slow.length) {
  failed = true;
  console.error(`\nToo slow (budget ${LAG_BUDGET_MS}ms) -- is Realtime delivering broadcasts?`);
  for (const l of slow) console.error(`  ${l.label}: ${l.ms}ms`);
}
if (errors.length) {
  failed = true;
  console.error('\nBrowser console errors:\n  ' + errors.slice(0, 15).join('\n  '));
}
console.log(failed ? `\nSMOKE TEST FAILED (screenshots in ${OUT})` : `\nsmoke test passed (screenshots in ${OUT})`);
process.exit(failed ? 1 : 0);
