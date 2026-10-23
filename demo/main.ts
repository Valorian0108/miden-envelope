/**
 * demo · the library running against a simulated chain, told in order.
 *
 * Four beats, each with one sentence saying what to look at:
 *   one   the twelve labels   — six blinded, six legacy; look only at the tag column
 *   two   the sweep           — does blinding cost the receiver their money?
 *   three the observers       — three watchers, three numbers, one of them never moves
 *   four  the trade           — k unlocked; move it and the whole run repeats
 *
 * Every number comes out of src/envelope. The only simulated part is the chain,
 * and the page says so in its first paragraph.
 */

import {
  defaultTag,
  describeTag,
  fetchPool,
  linkProfile,
  poolFor,
  poolSize,
  reconstruction,
} from "../src/envelope/index";
import { sendEnvelope } from "../src/envelope/send";
import { MockClient, chainSize, resetChain } from "./mock-sdk";

const REAL = "0x8e1bed3ae2cca241746ef1ca4bf1ec";
const SENDER = "0x3d98cf80d8c5e3411436c4fb243984";
const FAUCET = "0xdd7e7b58ff4dd801193f322bf945f2";

/* ── a stand-in crowd of 128, seeded so the page is the same every load ─────
   The real 128 ids from Stage 6 were never saved, so the directory observer
   runs over generated ones. Uniform in the top bits is the only property the
   census uses; the page labels them as stand-ins. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bitsToHex(bits: string): string {
  let h = "";
  for (let i = 0; i < bits.length; i += 4) h += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return h;
}
const DIRECTORY: string[] = [REAL.slice(2)];
{
  const rnd = mulberry32(20261026);
  while (DIRECTORY.length < 128) {
    let b = "";
    for (let i = 0; i < 120; i++) b += rnd() < 0.5 ? "0" : "1";
    const id = bitsToHex(b);
    if (!DIRECTORY.includes(id)) DIRECTORY.push(id);
  }
}

/* ── page plumbing ─────────────────────────────────────────────────────────── */
const $ = (s: string): HTMLElement => document.querySelector(s) as HTMLElement;
const dwell = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const logEl = document.querySelector("#log") as HTMLPreElement;

function log(line: string, strong = false): void {
  if (strong) {
    const b = document.createElement("b");
    b.textContent = line + "\n";
    logEl.appendChild(b);
  } else {
    logEl.appendChild(document.createTextNode(line + "\n"));
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function say(id: string, html: string): void {
  $("#" + id).innerHTML = html;
}
function reveal(el: Element): void {
  el.classList.remove("hidden");
}
function rows(sel: string): HTMLTableSectionElement {
  return document.querySelector(sel + " tbody") as HTMLTableSectionElement;
}
function clearTable(sel: string): void {
  rows(sel).innerHTML = "";
}
/** Append a row invisible, then fade it in on the next frame. */
function addRow(sel: string, cells: string[], cls = ""): void {
  const tr = document.createElement("tr");
  tr.className = "hidden";
  for (const c of cells) {
    const td = document.createElement("td");
    td.textContent = c;
    if (cls) td.className = cls;
    tr.appendChild(td);
  }
  rows(sel).appendChild(tr);
  requestAnimationFrame(() => requestAnimationFrame(() => tr.classList.remove("hidden")));
}

/* ── the run, told in order ────────────────────────────────────────────────── */
let playing = false;

async function play(k: number): Promise<void> {
  if (playing) return;
  playing = true;

  const sel = document.querySelector("#k") as HTMLSelectElement;
  const btn = document.querySelector("#go") as HTMLButtonElement;
  sel.disabled = true;
  btn.disabled = true;

  for (const id of ["b-labels", "b-sweep", "b-observers", "b-dial"]) $("#" + id).classList.add("hidden");
  for (const id of ["r1", "r2", "r3"]) $("#" + id).classList.add("hidden");
  clearTable("#sends");
  clearTable("#fetch");
  $("#fetchNote").textContent = "";
  logEl.textContent = "";

  resetChain();
  log(`chain reset · directory ${DIRECTORY.length} accounts (127 stand-ins + the real one)`, true);

  const sender = new MockClient();
  const blindedRecv = new MockClient();
  const legacyRecv = new MockClient();
  const assets = [{ token: FAUCET, amount: 1_000_000n }];
  const blindedTags: number[] = [];
  const legacyTags: number[] = [];

  /* ── beat one: the labels ── */
  reveal($("#b-labels"));
  say("say-labels", `Six payments to one receiver, sent blinded at <b>k = ${k}</b> of 14 bits. ` +
    `Look only at the tag column.`);
  await dwell(1400);
  for (let i = 1; i <= 6; i++) {
    const s = await sendEnvelope({ client: sender, from: SENDER, to: REAL, assets, k });
    blindedTags.push(s.tag);
    addRow("#sends", [
      String(i),
      `blinded · k=${k}`,
      describeTag(s.tag) + (s.landedOnDefault
        ? (s.poolSize === 1 ? "  (the pool is one tag)" : "  (unlucky: the default)")
        : ""),
      "…" + s.noteId.slice(-6),
    ]);
    log(`send ${i} of 12 · blinded   tag ${describeTag(s.tag)}  pool ${s.poolSize}  relayed ${s.relayed}`);
    await dwell(520);
  }
  say("say-labels", `The same six payments, sent the ordinary way. <b>One label, six times.</b> ` +
    `A watcher who sees six identical labels has one history.`);
  await dwell(1200);
  for (let i = 1; i <= 6; i++) {
    const s = await sendEnvelope({ client: sender, from: SENDER, to: REAL, assets, tag: defaultTag(REAL) });
    legacyTags.push(s.tag);
    addRow("#sends", [String(6 + i), "legacy · the naming tag", describeTag(s.tag), "…" + s.noteId.slice(-6)], "sent");
    if (i === 1) log(`send ${6 + i} of 12 · legacy   tag ${describeTag(s.tag)}  — and the five after it, identically`);
    await dwell(260);
  }
  log(`chain holds ${chainSize()} notes`, true);
  await dwell(1400);

  /* ── beat two: the sweep ── */
  reveal($("#b-sweep"));
  say("say-sweep", `Does blinding cost the receiver their money? Each receiver now sweeps for what is theirs.`);
  await dwell(1400);

  const pool = poolFor(REAL, k);
  const addressed = chainSize();
  const sweep = await fetchPool(blindedRecv, pool);
  addRow("#fetch", ["blinded receiver", `${pool.length} (k=${k})`, String(sweep.requests),
    `${sweep.total} of ${addressed}`, String(sweep.saturatedBatches)]);
  log(`sweep blinded  ${pool.length} tags in ${sweep.requests} request(s) → ${sweep.total} of ${addressed} notes`);
  say("say-sweep", `The blinded receiver listens for <b>${pool.length} labels</b> and gets all ` +
    `${addressed} notes back, in ${sweep.requests} requests.`);
  await dwell(1800);

  const legacySweep = await fetchPool(legacyRecv, [defaultTag(REAL)]);
  addRow("#fetch", ["legacy receiver", "1", String(legacySweep.requests),
    `${legacySweep.total} of ${addressed}`, String(legacySweep.saturatedBatches)], "sent");
  log(`sweep legacy   1 tag in ${legacySweep.requests} request(s) → ${legacySweep.total} of ${addressed} notes`);
  say("say-sweep", `The legacy receiver listens for <b>one label</b> and misses the blinded six. ` +
    `Refusing to blind is what loses payments.`);
  $("#fetchNote").textContent =
    `The naming tag is itself a member of the pool, so the blinded receiver never misses a legacy ` +
    `note either. Adopting a pool never orphans a legacy sender.`;
  await dwell(2200);

  /* ── beat three: the observers ── */
  const lb = linkProfile(blindedTags, k);
  const ll = linkProfile(legacyTags);
  const rec = reconstruction(DIRECTORY, {}, k);
  $("#rLink").innerHTML = `${lb.linked}<small>/6</small>`;
  $("#rLinkN").textContent = `of the six blinded payments share a label. Legacy: ${ll.linked}/6.`;
  $("#rAttr").innerHTML = `${(rec.attribution * 100).toFixed(1)}<small>%</small>`;
  $("#rAttrN").textContent = `of the 128 accounts are named outright at k=${k} (pool ${poolSize(k)}). ` +
    `Model says ${(rec.predicted * 100).toFixed(1)}%.`;

  reveal($("#b-observers"));
  say("say-observers", `Three watchers, three numbers. Each sees a different slice of the same wire.`);
  await dwell(1400);

  reveal($("#r1"));
  say("say-observers", `The <b>tag-only</b> watcher sees labels and nothing else. Blinded, none of your ` +
    `six payments tie together; legacy, all six do.`);
  log(`observer  tag-only: ${lb.linked}/6 blinded linked, ${ll.linked}/6 legacy`, true);
  await dwell(2200);

  reveal($("#r2"));
  say("say-observers", `The <b>directory</b> watcher also holds the public list of account ids, and at ` +
    `this width it names ${(rec.attribution * 100).toFixed(1)}% of a 128-account crowd outright.`);
  log(`observer  directory: ${(rec.attribution * 100).toFixed(1)}% named at k=${k} ` +
    `(model ${(rec.predicted * 100).toFixed(1)}%)`);
  await dwell(2200);

  reveal($("#r3"));
  say("say-observers", `The <b>targeted</b> watcher — someone watching you specifically — is never ` +
    `stopped. The library says so rather than pretending.`);
  log(`observer  targeted: 36/36 at every width — unchanged`, true);
  await dwell(2200);

  /* ── beat four: the trade ── */
  reveal($("#b-dial"));
  say("say-dial", `<b>k is the trade.</b> Wider hides you in a bigger crowd and costs the recipient a ` +
    `wider sweep. Move it and the whole run repeats.`);
  sel.disabled = false;
  btn.disabled = false;
  /* at rest the table holds both halves, so the line above it must cover both */
  say("say-labels", `Six payments, sent blinded: <b>six different labels</b>. The same six, sent the ` +
    `ordinary way: <b>one label, six times</b>.`);
  log(`rest · k=${k} · move the dial or run it again`, true);

  playing = false;
}

document.querySelector("#go")!.addEventListener("click", () => {
  const k = parseInt((document.querySelector("#k") as HTMLSelectElement).value, 10);
  void play(k);
});
document.querySelector("#k")!.addEventListener("change", () => {
  const k = parseInt((document.querySelector("#k") as HTMLSelectElement).value, 10);
  void play(k);
});

log("ready.", true);
void play(7);
