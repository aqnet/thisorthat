#!/usr/bin/env node
/**
 * Three-player browser test: the lobby switches and a game without the
 * Computer (spec v0.8, §5, §9.1).
 *
 * Run it like the smoke test, against a running app:
 *   npm run dev · npm run dev:dispatch · npm run e2e:three
 *
 * The lobby switches are controlled inputs, and a bug once read their value
 * after an await -- by which time React had reset it -- so neither switch ever
 * changed anything. This test flips both and checks the server followed.
 */
import { chromium } from 'playwright-core';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined });
const phone = { viewport: { width: 390, height: 844 } };
const pages = await Promise.all([0, 1, 2].map(async () => (await browser.newContext(phone)).newPage()));
const [host, p2, p3] = pages;
const errors = [];
for (const p of pages) p.on('pageerror', (e) => errors.push(e.message));
let failed = false;
const check = (cond, msg) => { if (!cond) throw new Error(msg); console.log('ok  ', msg); };
let code;
try {
  await host.goto(BASE);
  await host.getByRole('button', { name: 'New Game' }).click();
  await host.getByPlaceholder('Up to 12 letters').fill('Ana');
  await host.getByRole('button', { name: 'Create room' }).click();
  await host.waitForURL(/\/room\/[A-Z]{4}$/);
  code = host.url().slice(-4);
  for (const [page, name] of [[p2, 'Ben'], [p3, 'Cy']]) {
    await page.goto(`${BASE}/join/${code}`);
    await page.getByPlaceholder('Up to 12 letters').fill(name);
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.waitForURL(/\/room\//);
    if (name === 'Ben') {
      await host.getByText('Players · 2 of 4').waitFor();
      check(await host.getByLabel('Computer player').isDisabled(), 'switch disabled with 2 humans');
      await host.getByText('Always plays with fewer than 3 players').waitFor();
    }
  }
  await host.getByText('Players · 3 of 4').waitFor();
  const relaxed = host.locator('input[type="checkbox"]').first();
  await relaxed.click();
  await host.waitForFunction(() => document.querySelector('input[type="checkbox"]')?.checked === true, null, { timeout: 5000 });
  check(true, 'relaxed timers switch turns on (server confirmed)');
  const toggle = host.getByLabel('Computer player');
  check(!(await toggle.isDisabled()), 'switch enabled with 3 humans');
  await toggle.click();
  await host.getByText('Sitting out: humans only this game.').waitFor({ timeout: 5000 });
  await p2.getByText('Sitting out').waitFor({ timeout: 5000 });
  check(true, "other players see the Computer 'Sitting out'");
  await host.getByRole('button', { name: 'Start', exact: true }).click();
  await host.getByRole('button', { name: /^Pick your fav/ }).click();
  await host.getByRole('button', { name: 'Sport', exact: true }).click();
  await host.getByRole('button', { name: '5', exact: true }).click();
  await host.getByRole('button', { name: 'Sport · 5 items' }).click();
  await host.getByRole('button', { name: 'Start', exact: true }).click();
  for (const page of pages) {
    await page.getByText("List 5 sports you'll defend").waitFor();
    for (let n = 1; n <= 5; n++) {
      await page.getByRole('button', { name: '🎲 Surprise me' }).click();
      await page.getByText(`${n} / 5`).waitFor();
    }
    await page.getByRole('button', { name: 'Submit' }).click();
  }
  await host.getByText('Round 1 of 5').waitFor();
  const cards = await host.locator('button[aria-label^="Vote for"], button[aria-label$="(yours)"]').count();
  check(cards === 3, `round 1 ballot has 3 cards (got ${cards})`);
  check((await host.getByText("The Computer's card is in there").count()) === 0, 'voting hint no longer mentions the Computer');
  for (let round = 1; round <= 5; round++) {
    await host.getByText(`Round ${round} of 5`).waitFor();
    for (const page of pages) {
      await page.getByText(`Round ${round} of 5`).waitFor();
      await page.locator('button[aria-label^="Vote for"]').first().click();
    }
    await host.getByRole('button', { name: round < 5 ? /^Next/ : /^See results/ }).click();
  }
  await host.getByRole('button', { name: 'Play again' }).waitFor();
  const results = await host.locator('main').innerText();
  check(!/Computer/.test(results), 'results show no Computer row, win, Top Human or badge');
  
} catch (e) {
  failed = true;
  console.log('FAILED:', e.message.split('\n')[0]);
} finally {
  if (code) {
    await host.goto(`${BASE}/room/${code}`);
    await host.getByRole('button', { name: 'Menu' }).click().catch(() => {});
    await host.getByRole('button', { name: /Cancel room|End game for everyone/ }).first().click().catch(() => {});
    await host.getByRole('button', { name: /^(Cancel room|End game)$/ }).last().click().catch(() => {});
  }
  if (errors.length) failed = true;
  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
  await browser.close();
  console.log(failed ? 'THREE-PLAYER TEST FAILED' : 'three-player test passed');
  process.exit(failed ? 1 : 0);
}
