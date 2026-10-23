/**
 * capture/stills.mjs — reviewable frames, one per thing worth judging.
 *
 * The full-page width shots answer "does it fit". These answer "does it look right",
 * which is the question nobody in this harness has been able to ask until now.
 *
 * Run:  pnpm dev:mock   then   pnpm stills
 */

import { chromium } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'http://127.0.0.1:5173';
const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const FILM_DONE = () =>
  ['.shortlist', '.block', '.dial', '.readings'].every((c) => {
    const e = document.querySelector(c);
    return e && !e.classList.contains('hidden');
  });

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const say = (...a) => console.log(...a);

async function shot(page, sel, name, note) {
  const dest = join(OUT, name);
  if (sel === '@viewport') await page.screenshot({ path: dest });
  else await page.locator(sel).first().screenshot({ path: dest });
  say(`  ${name.padEnd(26)} ${kb(statSync(dest).size).padStart(8)}   ${note}`);
}

const browser = await chromium.launch();

/* ---- the film, at rest, 1440 wide ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/shell.html`, { waitUntil: 'load' });
  await page.waitForFunction(FILM_DONE, null, { timeout: 60000 });
  await page.waitForTimeout(600);

  say('FILM');
  await shot(page, '@viewport', 'still-01-top.png', 'the opening screen: title, deck, three panels');
  await shot(page, '.frames', 'still-02-frames.png', 'the three panels and their faces');
  await shot(page, '.shortlist', 'still-03-shortlist.png', 'the two shortlists');
  await shot(page, '.block', 'still-04-block.png', 'the 128-dot block with its bracket');
  await shot(page, '.dial', 'still-05-dial.png', 'the nine-stop dial at k=7');
  await shot(page, '.readings', 'still-06-readings.png', 'the four readings, measured over model');
  await ctx.close();
}

/* ---- the argument and the footnotes ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/shell.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  say('\nTEXT');
  await shot(page, '.card:nth-of-type(1)', 'still-07-card1.png', 'beat one: the envelope is public');
  await shot(page, '.card:nth-of-type(4)', 'still-08-card4.png', 'beat four: the Librarian has a directory');
  await shot(page, '.card:nth-of-type(6)', 'still-09-card6.png', 'beat six: the third face never moved');
  await shot(page, '.footnotes', 'still-10-footnotes.png', 'real / stand-in / the spread / measured table');
  await ctx.close();
}

/* ---- the same text at phone width ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/shell.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  say('\nTEXT AT 390px');
  await shot(page, '.card:nth-of-type(4)', 'still-11-card4-390.png', 'beat four, narrow');
  await shot(page, '.footnotes', 'still-12-footnotes-390.png', 'the measured table, narrow');
  await ctx.close();
}

/* ---- the demonstration, at rest ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/demo/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => !(document.querySelector('#k')).disabled,
    null,
    { timeout: 60000 }
  );
  await page.waitForTimeout(500);
  say('\nDEMO');
  await shot(page, '@viewport', 'still-13-demo-top.png', 'the demo opening: honesty note, first beat');
  await shot(page, '#b-observers', 'still-14-demo-observers.png', 'the three observer readings');
  await shot(page, '#log', 'still-16-demo-log.png', 'the notebook: every line the run printed');
  await page.screenshot({ path: join(OUT, 'still-15-demo-full.png'), fullPage: true });
  say(`  ${'still-15-demo-full.png'.padEnd(26)} ${kb(statSync(join(OUT, 'still-15-demo-full.png')).size).padStart(8)}   the whole run, top to bottom`);
  await ctx.close();
}

await browser.close();
say('\ndone');
