// Stage 6 — the reconstruction metric.
//
// Stages 2–5 built the mechanism: a keyless observer can read the wire, tags
// are arithmetic on account ids, a send can be blinded into a pool, and a pool
// can be fetched in batches. None of that says how much privacy any of it buys.
// This page turns it into the number the demo exists to show.
//
// The question is not "can the observer see the note" — Stage 4 settled that,
// yes, always. It is: **having seen it, can the observer say who it was for?**
//
// Two observers are scored, because they hold different things:
//
//   the tag-only observer   has the wire. It can group notes only by identical
//                           labels. Blinding attacks this head-on.
//   the directory observer  also has the list of account ids, which Miden
//                           publishes — ids sit in block commitments and
//                           MIDEN-011 measured the transport handing over a
//                           note's sender id to anyone who names the tag. It can
//                           recompute any account's pool, so it does not need
//                           repeated labels.
//
// Phase A builds a directory of 128 real account ids and censuses it at every
// width. That is arithmetic, but it is arithmetic on ids the SDK generated, and
// it is checked against the closed form (1 − 2^−k)^(N−1) rather than trusted.
//
// Phase B puts real traffic on the wire: the target receiver paid at five
// widths, the same receiver paid the legacy way as a control, and twelve more
// directory members paid at k = 7 so the note-level rate has a distribution
// instead of a single receiver's 0-or-1.
//
// Phase C is the keyless observer. It sweeps every block its directory occupies
// at k = 7 — around ten thousand tags — through the Stage 5 batched fetch, with
// `removeAfterBatch` because Stage 5 found every sync re-fetches every
// registered tag and a growing set would make the sweep quadratic.
//
// Phase D scores it. Done when the metric moves when k moves, in the direction
// MIDEN-010 predicts: coarser tag, wider pool, fewer notes pinned on anyone.

import * as SDK from "@miden-sdk/miden-sdk";
import * as T from "./envelope/tags";
import * as S from "./envelope/send";
import * as F from "./envelope/fetch";
import * as M from "./envelope/metric";

const out = document.getElementById("out")!;
const lines: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const state = {
  status: "running" as "running" | "pass" | "fail",
  phase: "boot",
  lines,
  checks,
  meta: {} as Record<string, unknown>,
};
(window as any).__STAGE6__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  log((ok ? "   ok " : "  FAIL") + "  " + name + (detail ? "   " + detail : ""));
}
function mark(p: string) {
  state.phase = p;
  (state.meta as any).phaseAt = { ...((state.meta as any).phaseAt ?? {}), [p]: Math.round(performance.now()) };
}
const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240);
const hex8 = T.describeTag;
const pct = (x: number) => (x * 100).toFixed(1) + "%";

// ── the world ─────────────────────────────────────────────────────────────
/** Directory size. 128 real ids: big enough that k = 7 genuinely crowds. */
const DIR_N = 128;
/** Widths the curve is reported at. */
const KS = M.CURVE_KS;
/** Widths the target receiver is actually paid at. */
const SEND_KS = [7, 8, 10, 12, 14];
const NOTES_PER_K = 6;
/** Legacy control: the same receiver, paid the way a plain SDK client pays. */
const NAIVE_NOTES = 6;
/** Other directory members paid at k = 7, so the note-level rate has a spread. */
const CROWD = 12;
const CROWD_NOTES = 3;
/** An empty, default-shaped tag: registering it fetches nothing. MIDEN-014's fix. */
const EMPTY_TAG = 0x3e000000;

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noteIdHex(x: any): string {
  try {
    if (x && typeof x.id === "function") {
      const id = x.id();
      return typeof id.toHex === "function" ? id.toHex() : String(id);
    }
    if (x && typeof x.toHex === "function") return x.toHex();
  } catch { /* fall through */ }
  return String(x);
}

function noteTag(x: any): number {
  try {
    return x.metadata().tag().asU32() >>> 0;
  } catch {
    return -1;
  }
}

async function wipeStores(): Promise<void> {
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((resolve) => {
            if (!d.name) return resolve();
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
            setTimeout(resolve, 2000);
          }),
      ),
    );
  } catch { /* ignore */ }
}

/** One payment, as the harness knows it and as the observer will have to guess it. */
interface Sent {
  noteId: string;
  tag: number;
  /** Width the sender blinded at. `null` for the legacy default-tag control. */
  k: number | null;
  to: string;
  /** "target" · "naive" · "crowd" */
  group: string;
  serial: string;
  relayed: boolean;
}

async function main() {
  const t0 = performance.now();
  const { MidenClient, FaucetType } = SDK as any;
  for (const [name, v] of Object.entries({ MidenClient, FaucetType })) {
    if (!v) throw new Error(`@miden-sdk/miden-sdk does not export ${name}`);
  }

  log("stage 6 — the reconstruction metric");
  log("  how many notes can a keyless observer pin on one receiver?");
  log("");

  await wipeStores();
  const client = await MidenClient.createMock();
  mark("client");

  // ── Phase A · a directory of real ids ───────────────────────────────────
  log("── A · directory ──");
  const aStart = performance.now();
  const faucet = await client.accounts.create({
    type: FaucetType.FungibleFaucet, symbol: "TST", decimals: 6, maxSupply: 1_000_000_000n,
  });
  const alice = await client.accounts.create();
  const directory: string[] = [];
  for (let i = 0; i < DIR_N; i++) {
    const a = await client.accounts.create();
    directory.push(a.id().toString());
    if ((i + 1) % 32 === 0) {
      log("  " + (i + 1) + " / " + DIR_N + " ids   " + Math.round(performance.now() - aStart) + " ms");
    }
  }
  const ids = {
    faucet: faucet.id().toString(),
    alice: alice.id().toString(),
  };
  const target = directory[0];
  const crowd = directory.slice(1, 1 + CROWD);
  const createMs = Math.round(performance.now() - aStart);
  log("  faucet " + ids.faucet.slice(0, 14) + "… · sender " + ids.alice.slice(0, 14) + "…");
  log("  directory " + directory.length + " ids in " + createMs + " ms ("
    + Math.round(createMs / (DIR_N + 2)) + " ms each)");
  log("  target " + target.slice(0, 14) + "…  default tag " + hex8(T.defaultTag(target)));
  mark("directory");

  await client.transactions.mint({
    account: ids.faucet, to: ids.alice, amount: 100_000_000n, type: "public",
  });
  await client.proveBlock();
  await client.sync();
  await client.transactions.consumeAll({ account: ids.alice });
  await client.proveBlock();
  await client.sync();
  log("  sender funded · " + Math.round(performance.now() - t0) + " ms elapsed");

  // the census: pure arithmetic over the ids just generated
  const cens = M.census(directory, KS);
  log("");
  log("  k  pool   blocks  occupied  largest  alone  attribution   predicted   mean set   pairs (expected)");
  for (const r of cens) {
    log(
      "  " + String(r.k).padStart(2) +
      String(r.poolTags).padStart(6) +
      String(r.blocks).padStart(9) +
      String(r.occupiedBlocks).padStart(10) +
      String(r.largestBlock).padStart(9) +
      String(r.alone).padStart(7) +
      ("      " + pct(r.uniqueRate)).slice(-11) +
      ("      " + pct(r.predicted)).slice(-11) +
      ("      " + r.meanSet.toFixed(3)).slice(-11) +
      "   " + String(r.pairs).padStart(5) + " (" + r.expectedPairs.toFixed(1) + ")",
    );
  }
  state.meta.census = cens;
  state.meta.directory = directory;
  mark("census");

  const targetOccupancy = new Map<number, number>();
  for (const k of KS) targetOccupancy.set(k, M.occupancyOf(directory, target, k));
  log("");
  log("  the target's own block: " + KS.map((k) => "k=" + k + " → " + targetOccupancy.get(k)).join("  "));

  // ── Phase B · traffic ───────────────────────────────────────────────────
  log("");
  log("── B · traffic ──");
  const bStart = performance.now();
  const rng = mulberry32(0x5eed_0006);
  const sent: Sent[] = [];

  async function pay(to: string, k: number | null, group: string, i: number): Promise<void> {
    const r = await S.sendEnvelope({
      client,
      from: ids.alice,
      to,
      assets: [{ token: ids.faucet, amount: BigInt(1000 + i) }],
      ...(k === null ? { tag: T.defaultTag(to) } : { k, rng }),
      settle: false,
      relay: false,
    });
    sent.push({ noteId: r.noteId, tag: r.tag, k, to, group, serial: r.serial, relayed: false });
  }

  let n = 0;
  for (const k of SEND_KS) {
    for (let i = 0; i < NOTES_PER_K; i++) await pay(target, k, "target", n++);
    log("  " + NOTES_PER_K + " notes to the target at k = " + k + "   tags "
      + sent.slice(-NOTES_PER_K).map((s) => hex8(s.tag).slice(2, 7)).join(" "));
  }
  for (let i = 0; i < NAIVE_NOTES; i++) await pay(target, null, "naive", n++);
  log("  " + NAIVE_NOTES + " notes to the target the legacy way   tag "
    + hex8(T.defaultTag(target)));
  for (const c of crowd) {
    for (let i = 0; i < CROWD_NOTES; i++) await pay(c, 7, "crowd", n++);
  }
  log("  " + CROWD * CROWD_NOTES + " notes to " + CROWD + " other directory members at k = 7");

  await client.proveBlock();
  await client.sync();
  const relayStart = performance.now();
  for (const s of sent) {
    await client.notes.sendPrivateOutput({ noteId: s.noteId as any, to: s.to });
    s.relayed = true;
  }
  log("  " + sent.length + " notes settled and relayed in "
    + Math.round(performance.now() - bStart) + " ms (relay "
    + Math.round(performance.now() - relayStart) + " ms)");
  state.meta.sent = sent;
  mark("traffic");

  const chainBlob = await client.serializeMockChain();
  const transportBlob = await client.serializeMockNoteTransportNode();
  try { await (client as any)[Symbol.asyncDispose](); } catch { try { client.terminate(); } catch { /* ignore */ } }

  // ── Phase C · the keyless observer ──────────────────────────────────────
  log("");
  log("── C · the keyless observer ──");
  const sweep = M.sweepTags(directory, T.MIN_K_ONE_REQUEST);
  const blocks = cens[0].occupiedBlocks;
  log("  it holds the directory (" + directory.length + " public ids) and nothing else — no keys, no accounts");
  log("  sweep " + sweep.length + " tags = " + blocks + " occupied block(s) × "
    + T.poolSize(T.MIN_K_ONE_REQUEST) + " · " + pct(M.sweepCoverage(sweep)) + " of the tag space");
  log("  plan " + F.describePlan(sweep.length, F.MAX_TAGS_PER_REQUEST).seams);

  await wipeStores();
  const observer = await MidenClient.createMock({
    serializedMockChain: chainBlob,
    serializedNoteTransport: transportBlob,
  });
  // MIDEN-014: the first sync after a restore costs ~218 ms per note against
  // ~12 ms warm. One empty sync here is ~100 ms and saves minutes below.
  const warmStart = performance.now();
  await observer.tags.add(EMPTY_TAG);
  await observer.sync();
  await observer.tags.remove(EMPTY_TAG);
  log("  warm-up " + Math.round(performance.now() - warmStart) + " ms");

  const cStart = performance.now();
  let done = 0;
  const res = await F.fetchPool(observer, sweep, {
    tagsPerRequest: F.MAX_TAGS_PER_REQUEST,
    removeAfterBatch: true,
    onBatch: (b) => {
      done++;
      if (done % 10 === 0 || b.error) {
        log("    batch " + String(done).padStart(3) + " · " + b.tags + " tags · "
          + b.ms + " ms · " + b.found + " new · " + (b.error ?? "ok"));
      }
    },
  });
  const sweepMs = Math.round(performance.now() - cStart);

  const listed = await observer.notes.list();
  const fetched = listed.map((x: any) => ({ noteId: noteIdHex(x), tag: noteTag(x) }));
  log("  " + res.batches.length + " batches in " + sweepMs + " ms · " + res.total
    + " note ids · " + fetched.length + " records read · " + res.saturatedBatches + " saturated");
  try { await (observer as any)[Symbol.asyncDispose](); } catch { try { observer.terminate(); } catch { /* ignore */ } }
  mark("sweep");

  const byId = new Map(fetched.map((f: any) => [f.noteId, f.tag]));
  const sentIds = new Set(sent.map((s) => s.noteId));
  const strays = fetched.filter((f: any) => !sentIds.has(f.noteId));
  if (strays.length) {
    log("  also caught " + strays.length + " note(s) this harness did not send — "
      + "the funding trail, filed under tags that happen to sit in a swept block");
  }
  state.meta.fetch = {
    batches: res.batches.length,
    sweepMs,
    totalMs: res.totalMs,
    recovered: res.total,
    saturated: res.saturatedBatches,
    tagsSwept: sweep.length,
  };

  // ── Phase D · scoring ───────────────────────────────────────────────────
  log("");
  log("── D · what the observer can actually say ──");

  // Ground truth is the harness's, not the observer's: it is what we score against.
  const tagsByReceiver: Record<string, number[]> = {};
  for (const s of sent) {
    const got = byId.get(s.noteId);
    if (got === undefined) continue;
    (tagsByReceiver[s.to] ??= []).push(got);
  }

  // the tag-only observer, per width, on the target's traffic
  const targetTags = (k: number | null) =>
    sent.filter((s) => s.group === (k === null ? "naive" : "target") && (k === null || s.k === k))
      .map((s) => byId.get(s.noteId))
      .filter((t): t is number => t !== undefined);

  log("");
  log("  tag-only observer · the target's payments");
  log("  sent at     notes  distinct labels  clustered  link rate   expected");
  const linkRows: { label: string; k: number; p: M.LinkProfile }[] = [];
  for (const k of SEND_KS) {
    const tags = targetTags(k);
    const p = M.linkProfile(tags, k);
    linkRows.push({ label: "k = " + k, k, p });
    log("  k = " + String(k).padEnd(8) + String(p.notes).padStart(3)
      + String(p.distinctTags).padStart(13) + String(p.linked).padStart(11)
      + ("        " + pct(p.linkRate)).slice(-10)
      + ("     " + p.expectedLinked.toFixed(2)).slice(-9));
  }
  {
    const tags = targetTags(null);
    const p = M.linkProfile(tags, T.DEFAULT_TAG_LEN);
    linkRows.push({ label: "legacy", k: T.DEFAULT_TAG_LEN, p });
    log("  legacy   " + String(p.notes).padStart(5)
      + String(p.distinctTags).padStart(13) + String(p.linked).padStart(11)
      + ("        " + pct(p.linkRate)).slice(-10)
      + ("     " + p.expectedLinked.toFixed(2)).slice(-9));
  }
  state.meta.link = linkRows;

  // the directory observer, matched width, on everything it caught
  log("");
  log("  directory observer · matched width");
  log("  width   notes caught  named outright  rate    mean candidate set");
  const matched: { k: number; r: M.AttributionReport }[] = [];
  for (const k of KS) {
    const notes = sent
      .filter((s) => s.k === k || (s.k === null && k === T.DEFAULT_TAG_LEN))
      .map((s) => ({ noteId: s.noteId, tag: byId.get(s.noteId) ?? -1 }))
      .filter((x) => x.tag >= 0);
    if (!notes.length) continue;
    const r = M.attributeNotes(directory, notes, k);
    matched.push({ k, r });
    log("  k = " + String(k).padEnd(4) + String(r.notes).padStart(8)
      + String(r.unique).padStart(16) + ("        " + pct(r.rate)).slice(-8)
      + ("        " + r.meanSet.toFixed(2)).slice(-12));
  }
  state.meta.matched = matched.map((m) => ({ k: m.k, ...m.r, perNote: undefined }));

  // the conservative observer: assumes everybody blinds as wide as possible
  const conservative = M.attributeNotes(
    directory,
    fetched.filter((f: any) => f.tag >= 0),
    T.MIN_K_ONE_REQUEST,
  );
  log("");
  log("  directory observer assuming k = 7 for everything: " + conservative.notes
    + " notes → " + conservative.unique + " named outright (" + pct(conservative.rate)
    + "), mean candidate set " + conservative.meanSet.toFixed(2));
  state.meta.conservative = { ...conservative, perNote: undefined };

  // the curve the demo's dial reads
  const dial = M.curve(directory, tagsByReceiver, KS);
  log("");
  log("  the dial:");
  for (const d of dial) log("    " + d.reads);
  state.meta.dial = dial;

  // the targeted-observer control: a spy who already knows the receiver's id
  // registers that receiver's pool and loses nothing at any width. Blinding
  // de-attributes in a crowd; it does not hide you from someone who has you.
  let targetedHits = 0;
  let targetedTotal = 0;
  for (const s of sent) {
    if (s.to !== target) continue;
    const got = byId.get(s.noteId);
    if (got === undefined) continue;
    targetedTotal++;
    if (T.poolContains(target, s.k ?? T.DEFAULT_TAG_LEN, got)) targetedHits++;
  }

  // ── checks ──────────────────────────────────────────────────────────────
  log("");
  log("── checks ──");

  const rates = cens.map((r) => r.uniqueRate);
  const monotone = rates.every((v, i) => i === 0 || v >= rates[i - 1]);
  check("attribution rises monotonically with k", monotone,
    rates.map((r) => pct(r)).join(" → "));

  const direction = cens[0].uniqueRate < cens[cens.length - 1].uniqueRate;
  check("the metric moves in the direction MIDEN-010 predicts", direction,
    "k=7 " + pct(cens[0].uniqueRate) + " vs k=14 " + pct(cens[cens.length - 1].uniqueRate));

  // Goodness-of-fit against the closed form.
  //
  // The first version of this check compared `uniqueRate` with the prediction
  // using a binomial standard error, and it failed at k = 14: 96.9% measured
  // against 99.2% predicted, a 2.35% gap against a 2.32% tolerance. The
  // measurement was sound and the instrument was not. `alone` is not a sum of
  // independent Bernoulli trials — when two accounts share a block they are both
  // non-alone together — so the trials are correlated and the binomial SE
  // understates the spread precisely where the rate is closest to 1. The
  // sufficient statistic is the collision count, whose null is Poisson with mean
  // C(N,2)/2^k, and stage 6b confirmed that null directly by simulating 2,000
  // synthetic directories.
  const poissonTail = (obs: number, lambda: number): number => {
    let term = Math.exp(-lambda);
    let below = 0;
    for (let x = 0; x < obs; x++) {
      below += term;
      term *= lambda / (x + 1);
    }
    return 1 - below; // P(X ≥ obs)
  };
  const tails = cens.map((r) => ({ k: r.k, p: poissonTail(r.pairs, r.expectedPairs) }));
  const alpha = 0.01 / tails.length; // Bonferroni across the eight widths
  const minTail = Math.min(...tails.map((t) => t.p));
  check("the closed form survives a goodness-of-fit at every width",
    minTail >= alpha,
    tails.map((t) => "k=" + t.k + " p=" + (t.p * 100).toFixed(1) + "%").join(" · ")
    + " · reject below " + (alpha * 100).toFixed(2) + "%");

  // The census recomputed straight from the ids, without going through
  // metric.ts — an arithmetic bug there would otherwise look like a finding.
  let consistent = true;
  const incons: string[] = [];
  for (const r of cens) {
    const occ = new Map<number, number>();
    for (const id of directory) {
      const p = T.accountIdPrefix(id, r.k);
      occ.set(p, (occ.get(p) ?? 0) + 1);
    }
    let alone = 0;
    let shared = 0;
    let prs = 0;
    for (const c of occ.values()) {
      if (c === 1) alone++;
      else shared += c;
      prs += (c * (c - 1)) / 2;
    }
    if (alone !== r.alone || alone + shared !== r.accounts || prs !== r.pairs
      || occ.size !== r.occupiedBlocks) {
      consistent = false;
      incons.push("k=" + r.k);
    }
  }
  check("the census is internally consistent, recomputed from the ids", consistent,
    incons.length ? incons.join(", ") : "all 8 widths: alone + shared = N, pairs and blocks agree");

  let pairsOk = true;
  const pairBad: string[] = [];
  for (const r of cens) {
    const tol = 3 * Math.sqrt(Math.max(r.expectedPairs, 1));
    if (Math.abs(r.pairs - r.expectedPairs) > tol) {
      pairsOk = false;
      pairBad.push("k=" + r.k + " " + r.pairs + " vs " + r.expectedPairs.toFixed(1));
    }
  }
  check("colliding pairs match C(N,2)/2^k within 3 SE", pairsOk,
    pairBad.length ? pairBad.join(" | ") : "all 8 within tolerance");

  check("the sweep is exactly the occupied blocks, with no overlap",
    sweep.length === blocks * T.poolSize(T.MIN_K_ONE_REQUEST) && new Set(sweep).size === sweep.length,
    sweep.length + " tags = " + blocks + " × " + T.poolSize(T.MIN_K_ONE_REQUEST));

  const missing = sent.filter((s) => !byId.has(s.noteId));
  check("the keyless observer recovered every note put on the wire",
    missing.length === 0, (sent.length - missing.length) + " / " + sent.length);

  check("every tag the observer read is default-shaped",
    fetched.every((f: any) => T.isDefaultShaped(f.tag)),
    fetched.length + " records");

  // per-note candidate sets must equal the census prediction for that receiver
  let candOk = true;
  const candBad: string[] = [];
  for (const s of sent) {
    const got = byId.get(s.noteId);
    if (got === undefined) continue;
    const k = s.k ?? T.DEFAULT_TAG_LEN;
    const want = M.occupancyOf(directory, s.to, k);
    const have = M.candidatesForTag(directory, got, k).length;
    if (have !== want) {
      candOk = false;
      if (candBad.length < 5) candBad.push(s.noteId.slice(0, 12) + "… k=" + k + " " + have + "≠" + want);
    }
  }
  check("note-level candidate sets equal the census prediction, note for note", candOk,
    candBad.length ? candBad.join(" | ") : sent.length + " / " + sent.length + " notes");

  const legacyLink = linkRows.find((r) => r.label === "legacy")!.p;
  const blindLink = linkRows.find((r) => r.k === T.MIN_K_ONE_REQUEST)!.p;
  check("legacy traffic is fully clustered by label alone",
    legacyLink.linkRate === 1 && legacyLink.distinctTags === 1,
    legacyLink.notes + " notes, " + legacyLink.distinctTags + " label(s), " + pct(legacyLink.linkRate));
  check("blinding at k = 7 breaks the label clustering",
    blindLink.linkRate < 0.5 && blindLink.distinctTags >= blindLink.notes - 1,
    blindLink.notes + " notes over " + blindLink.distinctTags + " labels, " + pct(blindLink.linkRate));

  const m7 = matched.find((m) => m.k === T.MIN_K_ONE_REQUEST);
  const m14 = matched.find((m) => m.k === T.DEFAULT_TAG_LEN);
  check("the note-level rate moves with k too",
    !!m7 && !!m14 && m14.r.rate > m7.r.rate,
    (m7 ? "k=7 " + pct(m7.r.rate) : "k=7 n/a") + " → " + (m14 ? "k=14 " + pct(m14.r.rate) : "k=14 n/a"));

  check("a spy who already knows the receiver still gets every note, at every width",
    targetedHits === targetedTotal, targetedHits + " / " + targetedTotal);

  check("the receiver's own pool always contains the tag used",
    sent.every((s) => T.poolContains(s.to, s.k ?? T.DEFAULT_TAG_LEN, s.tag)),
    sent.length + " / " + sent.length);

  check("serials are distinct — no silent note collapse",
    new Set(sent.map((s) => s.serial)).size === sent.length,
    new Set(sent.map((s) => s.serial)).size + " distinct of " + sent.length);

  check("no batch reported saturation", res.saturatedBatches === 0,
    res.saturatedBatches + " of " + res.batches.length);

  state.meta.result = {
    directory: directory.length,
    notes: sent.length,
    recovered: fetched.length,
    sweepTags: sweep.length,
    sweepMs,
    dial,
    conservativeRate: conservative.rate,
    targeted: targetedHits + "/" + targetedTotal,
  };

  log("");
  log("  total " + Math.round(performance.now() - t0) + " ms");
  const failed = checks.filter((c) => !c.ok);
  state.status = failed.length === 0 ? "pass" : "fail";
  log(failed.length === 0
    ? "PASS — " + checks.length + "/" + checks.length + " checks"
    : "FAIL — " + failed.length + " of " + checks.length + ": " + failed.map((c) => c.name).join(" | "));
}

main().catch((e) => {
  log("");
  log("ERROR " + E(e));
  log(String((e as Error)?.stack ?? "").split("\n").slice(0, 6).join("\n"));
  state.status = "fail";
});
