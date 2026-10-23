/**
 * capture/record.mjs — the review pass, scripted.
 *
 * Three jobs the harness browser cannot do (its window is invisible, so it takes no
 * screenshots and no key presses):
 *
 *   1. record   film + demo, 1440x900, from load to rest      -> capture/*.webm
 *   2. widths   full-page frames at 360 / 768 / 1280 / 1600    -> capture/shell-*.png
 *   3. keys     tab order, focus rings, dial, stops, replay    -> printed report (RD-35)
 *
 * Run:  pnpm dev:mock        (or pnpm dev — shell.html imports nothing)
 *       pnpm capture         all three
 *       pnpm capture keys    one of: record | widths | keys
 *
 * Headless on purpose: visibility of a window is exactly what was missing.
 */

import { chromium } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'http://127.0.0.1:5173';
const FILM = `${ORIGIN}/shell.html`;
const DEMO = `${ORIGIN}/demo/index.html`;
const OUT = dirname(fileURLToPath(import.meta.url));
const ONLY = process.argv[2] || 'all';

mkdirSync(OUT, { recursive: true });

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const say = (...a) => console.log(...a);
const failures = [];

/** The film is finished when every late section has lost its .hidden. */
const FILM_DONE = () =>
  ['.shortlist', '.block', '.dial', '.readings'].every((c) => {
    const e = document.querySelector(c);
    return e && !e.classList.contains('hidden');
  });

/** What has focus, as a short label, or 'none'. */
const FOCUSED = () => {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return 'none';
  return (
    a.tagName.toLowerCase() +
    (a.id ? '#' + a.id : '') +
    (a.className ? '.' + String(a.className).trim().split(/\s+/)[0] : '')
  );
};

async function fontReport(page) {
  return page.evaluate(() => ({
    status: document.fonts.status,
    display: document.fonts.check('500 16px "Space Grotesk"'),
  }));
}

/* ── 1. recordings ─────────────────────────────────────────────────────────── */
async function record(url, dest, holdMs, label) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  const fonts = await fontReport(page);
  await page.waitForTimeout(holdMs);
  const video = page.video();
  await ctx.close();
  await video.saveAs(dest);
  await browser.close();
  const s = statSync(dest);
  say(
    `  ${label.padEnd(10)} ${dest.split(/[\\/]/).pop().padEnd(18)} ${mb(s.size).padStart(8)}` +
      `  ${((Date.now() - t0) / 1000).toFixed(1)}s  fonts ${fonts.display ? 'webfonts' : 'FALLBACK'}`
  );
  if (!fonts.display) failures.push(`${label}: webfonts did not load`);
}

/* ── 2. widths ─────────────────────────────────────────────────────────────── */
async function widths() {
  for (const w of [360, 768, 1280, 1600]) {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(FILM, { waitUntil: 'load' });
    await page.waitForFunction(FILM_DONE, null, { timeout: 60000 });
    await page.waitForTimeout(900);
    const dest = join(OUT, `shell-${w}.png`);
    await page.screenshot({ path: dest, fullPage: true });
    const m = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pageH: document.body.scrollHeight,
      frames: getComputedStyle(document.querySelector('.frames')).gridTemplateColumns.split(' ').length,
      reads: getComputedStyle(document.querySelector('.reads')).gridTemplateColumns.split(' ').length,
      tableScrolls: (() => {
        const t = document.querySelector('.measured');
        const wrap = document.querySelector('.measured-wrap');
        return t.scrollWidth > wrap.clientWidth + 1;
      })(),
      widest: Math.round(
        Math.max(...[...document.querySelectorAll('.wrap *')].map((e) => e.getBoundingClientRect().right))
      ),
    }));
    say(
      `  ${String(w).padStart(4)}px  page ${String(m.pageH).padStart(5)}px  overflowX ${m.overflowX}` +
        `  frames ${m.frames}c  reads ${m.reads}c  table scrolls ${m.tableScrolls ? 'YES' : 'no'}` +
        `  widest ${m.widest}  -> ${dest.split(/[\\/]/).pop()} ${kb(statSync(dest).size)}`
    );
    if (m.overflowX > 0) failures.push(`${w}px overflows horizontally by ${m.overflowX}px`);
    await browser.close();
  }
}

/* ── 3. keyboard pass (RD-35) ──────────────────────────────────────────────── */
async function keyboard() {
  const browser = await chromium.launch();

  /* (a) while the film plays, nothing invisible may be reachable by Tab. */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(FILM, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    const reached = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      reached.push(await page.evaluate(FOCUSED));
    }
    say(`  during the film, six tabs reach: ${reached.join(', ')}`);
    const leaked = reached.filter((r) => r !== 'none');
    if (leaked.length)
      failures.push(`focusable while invisible during the film: ${leaked.join(', ')}`);
    await ctx.close();
  }

  /* (b) at rest: real Tab presses, checking order and the focus ring on each. */
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(FILM, { waitUntil: 'load' });
  await page.waitForFunction(FILM_DONE, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.replay').hidden, null, {
    timeout: 30000,
  });

  say('  tab order at rest:');
  const order = [];
  for (let i = 1; i <= 5; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const cs = getComputedStyle(a);
      return {
        who:
          a.tagName.toLowerCase() +
          (a.id ? '#' + a.id : '') +
          (a.className ? '.' + String(a.className).trim().split(/\s+/)[0] : ''),
        label: a.tagName === 'BUTTON' ? a.textContent.trim() : String(a.value ?? ''),
        fv: a.matches(':focus-visible'),
        outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
        bg: cs.backgroundColor,
      };
    });
    if (!r) {
      order.push('none');
      say(`    Tab ${i} -> nothing`);
      failures.push(`Tab ${i} reached nothing; a control was expected`);
      continue;
    }
    order.push(r.who);
    const outlined = !r.outline.startsWith('none') && parseFloat(r.outline.split(' ')[1]) > 0;
    const inverted = r.bg !== 'rgba(0, 0, 0, 0)';
    say(
      `    Tab ${i} -> ${r.who.padEnd(14)} ${r.label ? '"' + r.label + '"' : ''}`.padEnd(52) +
        ` :focus-visible=${r.fv}  ${outlined ? r.outline : inverted ? 'inverted ' + r.bg : 'NO RING'}`
    );
    if (!r.fv) failures.push(`${r.who} took focus but :focus-visible did not match`);
    if (!outlined && !inverted) failures.push(`no visible focus indicator on ${r.who}`);
  }
  const expected = ['button.replay', 'button.stop', 'button.stop', 'button.stop', 'input#kDial.dial-input'];
  if (JSON.stringify(order) !== JSON.stringify(expected))
    failures.push(`tab order is ${order.join(' -> ')}; expected ${expected.join(' -> ')}`);

  /* (c) the dial, by arrow key alone. */
  say('  dial under arrow keys:');
  const dialState = () =>
    page.evaluate(() => ({
      v: document.getElementById('kDial').value,
      read: document.querySelector('.dial-read').textContent.trim(),
      vals: [...document.querySelectorAll('.r-value')].map((e) => e.textContent.trim()).join(' / '),
      note: document.querySelectorAll('.r-note')[1].textContent.trim(),
    }));
  const start = await dialState();
  say(`    ${'focus'.padEnd(11)} stop ${start.v} :: ${start.read} :: ${start.vals}`);
  for (const key of ['ArrowRight', 'ArrowRight', 'End', 'Home', 'ArrowLeft']) {
    await page.keyboard.press(key);
    const s = await dialState();
    const moved = s.v !== start.v || s.read !== start.read;
    say(`    ${key.padEnd(11)} stop ${s.v} :: ${s.read} :: ${s.vals}`);
    if (key === 'End' && s.v !== '8') failures.push(`End did not reach the last stop (got ${s.v})`);
    if (key === 'Home' && s.v !== '0') failures.push(`Home did not reach legacy (got ${s.v})`);
    if (key === 'ArrowRight' && !moved) failures.push('ArrowRight did not move the dial');
    if (key === 'ArrowLeft' && s.v !== '0') failures.push('ArrowLeft moved off the legacy stop');
  }
  const unmeasured = await dialState();
  say(`    legacy note reads: "${unmeasured.note}"`);
  await page.keyboard.press('Home');
  await page.evaluate(() => {
    const d = document.getElementById('kDial');
    d.value = '3';
    d.dispatchEvent(new Event('input'));
  });
  const gap = await dialState();
  say(`    k=9 (unmeasured link) reads: ${gap.vals} :: "${gap.note}"`);
  if (!gap.vals.includes('—')) failures.push('the unmeasured width does not render an em dash');

  /* (d) the block stops, by Enter and by Space. */
  say('  block stops under Enter / Space:');
  for (const [i, key] of [
    [1, 'Enter'],
    [2, 'Space'],
    [0, 'Enter'],
  ]) {
    await page.locator('.stop').nth(i).focus();
    await page.keyboard.press(key);
    const s = await page.evaluate(() => ({
      pressed: [...document.querySelectorAll('.stop')].map((b) => b.getAttribute('aria-pressed')),
      read: document.querySelector('.block-read').textContent.trim(),
    }));
    const ok = s.pressed[i] === 'true' && s.pressed.filter((p) => p === 'true').length === 1;
    say(`    ${key.padEnd(6)} on stop ${i + 1} -> [${s.pressed.join(',')}] :: ${s.read}`);
    if (!ok) failures.push(`${key} on stop ${i + 1} did not select it`);
  }

  /* (e) replay, by Enter. */
  await page.locator('.replay').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const restarted = await page.evaluate(
    () =>
      document.body.classList.contains('playing') &&
      document.querySelector('.shortlist').classList.contains('hidden')
  );
  say(`  Enter on replay -> film restarted: ${restarted ? 'yes' : 'NO'}`);
  if (!restarted) failures.push('Enter on the replay button did not restart the film');

  await browser.close();
}

/* ── run ───────────────────────────────────────────────────────────────────── */
const t0 = Date.now();
if (ONLY === 'all' || ONLY === 'record') {
  say('RECORDINGS (1440x900)');
  await record(FILM, join(OUT, 'film-1440.webm'), 33000, 'film k=7');
  await record(DEMO, join(OUT, 'demo-1440.webm'), 30000, 'demo k=7');
  say('');
}
if (ONLY === 'all' || ONLY === 'widths') {
  say('WIDTHS (full page, film at rest)');
  await widths();
  say('');
}
if (ONLY === 'all' || ONLY === 'keys') {
  say('KEYBOARD PASS (RD-35)');
  await keyboard();
  say('');
}

say(failures.length === 0 ? 'PASS — no failures.' : `FAILURES (${failures.length}):`);
for (const f of failures) say('  - ' + f);
say(`total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exitCode = failures.length ? 1 : 0;
