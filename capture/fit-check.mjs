/**
 * capture/fit-check.mjs — the one-screen guarantee, measured.
 *
 * Everything the take animates must sit inside the viewport — no scrolling —
 * both mid-play and at rest, at every common desktop size. The six-card essay
 * must begin below the fold, so scrolling away is what leaves the film.
 *
 * Run:  pnpm dev:mock   then   node capture/fit-check.mjs
 */

import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'http://127.0.0.1:5173';
const OUT = dirname(fileURLToPath(import.meta.url));

/** The film is finished when every late panel has lost its .hidden. */
const FILM_DONE = () =>
  ['.shortlist', '.block', '.dial', '.readings'].every((c) => {
    const e = document.querySelector(c);
    return e && !e.classList.contains('hidden');
  });

/** Everything the take animates, plus the strips that hold them. */
const PARTS = ['.film-head', '.frames', '.stage-foot', '.counter',
               '.shortlist', '.block', '.dial', '.readings', '.scroll-cue'];

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1600, height: 1000 },
];

const failures = [];
const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: vp });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/shell.html`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const tag = `${vp.width}x${vp.height}`;

  for (const phase of ['playing', 'rest']) {
    if (phase === 'playing') {
      await page.waitForTimeout(6500);          /* mid person-one's look */
    } else {
      await page.waitForFunction(FILM_DONE, null, { timeout: 60000 });
      await page.waitForTimeout(900);
    }

    const m = await page.evaluate((parts) => {
      const vh = window.innerHeight, vw = window.innerWidth;
      const film = document.querySelector('.film').getBoundingClientRect();
      const argument = document.querySelector('.argument').getBoundingClientRect();
      const out = { vh, vw, filmH: film.height, argumentTop: argument.top, parts: {} };
      for (const sel of parts) {
        const r = document.querySelector(sel).getBoundingClientRect();
        out.parts[sel] = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      }
      return out;
    }, PARTS);

    await page.screenshot({ path: join(OUT, `fit-${tag}-${phase}.png`) });

    const bad = [];
    if (m.filmH > m.vh + 2) bad.push(`film section ${m.filmH.toFixed(0)}px taller than viewport ${m.vh}px`);
    if (m.argumentTop < m.vh - 5) bad.push(`essay starts at ${m.argumentTop.toFixed(0)}px, above the fold (${m.vh}px)`);
    for (const [sel, r] of Object.entries(m.parts)) {
      if (r.top < -1 || r.bottom > m.vh + 1)
        bad.push(`${sel} escapes vertically: ${r.top.toFixed(0)}..${r.bottom.toFixed(0)} of ${m.vh}`);
      if (r.left < -1 || r.right > m.vw + 1)
        bad.push(`${sel} escapes horizontally: ${r.left.toFixed(0)}..${r.right.toFixed(0)} of ${m.vw}`);
    }

    console.log(`${bad.length ? 'FAIL' : 'fit '}  ${tag.padEnd(9)} ${phase.padEnd(8)} ` +
      `film ${m.filmH.toFixed(0)}px / ${m.vh}px, essay starts ${m.argumentTop.toFixed(0)}px`);
    for (const b of bad) { console.log(`        · ${b}`); failures.push(`${tag} ${phase}: ${b}`); }
  }

  await ctx.close();
}

await browser.close();
console.log(failures.length
  ? `\n${failures.length} failure(s).`
  : '\nEvery take fits one screen at every size tested.');
process.exit(failures.length ? 1 : 0);
