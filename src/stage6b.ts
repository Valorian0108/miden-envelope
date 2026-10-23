// Stage 6b — why do two pairs of ids share all fourteen tag bits?
//
// Stage 6 passed 14 of 15 checks. The one that failed was the tightest and the
// most interesting: at k = 14 the directory showed 96.9% of accounts alone in
// their block against a closed-form prediction of 99.2%. That is 2 colliding
// pairs out of 128 ids, where uniform top bits predict 0.5.
//
// On its own that is a 9% event and means nothing. But Stage 3 measured the
// same quantity on an independently created set of 120 accounts and also got
// exactly 2 pairs, against 0.4 expected. Two samples both landing on 2 is
// about a 0.6% coincidence, and Stage 3's bit-uniformity work is the reason not
// to shrug at it: if the top 14 bits really are uniform, collisions at k = 14
// should be rare.
//
// So there are two candidate explanations and they have opposite consequences.
//
//   (a) the mock derives ids from something sequential — a nonce, a counter, a
//       shared seed — so accounts created one after another are correlated, and
//       the directory is not a fair model of a network population. Everything
//       Stage 6 measured about crowding would then be an artefact of creation
//       order, and the census would have to be re-based on ids that are not
//       neighbours.
//   (b) the ids are independent and Miden's id space genuinely clusters slightly
//       at the top, in which case the closed form over-states privacy at wide k
//       and the metric should be measured, not predicted.
//
// (a) leaves fingerprints that (b) cannot produce. Correlated ids collide with
// *nearby* creation indices, and they differ only in their low bits. Both are
// directly observable, so this page measures both instead of arguing.
//
// It also runs the null model properly: 2,000 synthetic directories of the same
// size, uniformly random, to get the actual distribution of pair counts at each
// width and a real p-value for what Stage 6 saw.

import * as SDK from "@miden-sdk/miden-sdk";
import * as T from "./envelope/tags";
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
(window as any).__STAGE6B__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  log((ok ? "   ok " : "  FAIL") + "  " + name + (detail ? "   " + detail : ""));
}
const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240);

const N = 128;
const KS = [10, 11, 12, 13, 14];
const TRIALS = 2000;

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

/** Every pair in `ids` sharing its top k bits, with creation indices. */
function collidingPairs(ids: string[], k: number): { i: number; j: number; gap: number }[] {
  const byPrefix = new Map<number, number[]>();
  ids.forEach((id, i) => {
    const p = T.accountIdPrefix(id, k);
    const a = byPrefix.get(p);
    if (a) a.push(i);
    else byPrefix.set(p, [i]);
  });
  const out: { i: number; j: number; gap: number }[] = [];
  for (const idx of byPrefix.values()) {
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) {
        out.push({ i: idx[x], j: idx[y], gap: idx[y] - idx[x] });
      }
    }
  }
  return out;
}

/** A synthetic directory: uniform random 120-bit ids, no SDK involved. */
function synthetic(n: number, rng: () => number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    let h = "";
    for (let c = 0; c < T.ID_HEX_CHARS; c++) h += "0123456789abcdef"[Math.floor(rng() * 16)];
    ids.push(h);
  }
  return ids;
}

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many bits two ids differ in, and where. */
function xorReport(a: string, b: string): { bits: number; topBit: number; hex: string } {
  const x = BigInt("0x" + T.normalizeId(a)) ^ BigInt("0x" + T.normalizeId(b));
  let bits = 0;
  let top = -1;
  for (let i = 0; i < T.ID_BITS; i++) {
    if ((x >> BigInt(i)) & 1n) {
      bits++;
      top = i;
    }
  }
  return { bits, topBit: top, hex: x.toString(16).padStart(30, "0") };
}

async function main() {
  const t0 = performance.now();
  const { MidenClient } = SDK as any;

  log("stage 6b — are the k=14 collisions real, or are they creation order?");
  log("");

  await wipeStores();
  const client = await MidenClient.createMock();
  state.phase = "create";

  const ids: string[] = [];
  const cStart = performance.now();
  for (let i = 0; i < N; i++) {
    const a = await client.accounts.create();
    ids.push(a.id().toString());
    if ((i + 1) % 32 === 0) log("  " + (i + 1) + " / " + N + " ids   " + Math.round(performance.now() - cStart) + " ms");
  }
  state.meta.directory = ids;
  log("  " + N + " real ids in " + Math.round(performance.now() - cStart) + " ms");
  try { await (client as any)[Symbol.asyncDispose](); } catch { try { client.terminate(); } catch { /* ignore */ } }

  // ── the null model ──────────────────────────────────────────────────────
  log("");
  log("── null model · " + TRIALS + " synthetic directories of " + N + " uniform random ids ──");
  const rng = mulberry32(0x6b11_0006);
  const nullDist = new Map<number, Map<number, number>>(); // k -> pairCount -> trials
  for (const k of KS) nullDist.set(k, new Map());
  for (let t = 0; t < TRIALS; t++) {
    const s = synthetic(N, rng);
    for (const k of KS) {
      const c = collidingPairs(s, k).length;
      const m = nullDist.get(k)!;
      m.set(c, (m.get(c) ?? 0) + 1);
    }
  }

  log("  k   expected   null distribution of pair counts (count: trials)");
  for (const k of KS) {
    const m = nullDist.get(k)!;
    const keys = Array.from(m.keys()).sort((a, b) => a - b);
    const mean = keys.reduce((s, x) => s + x * (m.get(x) ?? 0), 0) / TRIALS;
    log("  " + String(k).padStart(2) + M.predictedPairs(k, N).toFixed(2).padStart(9) + "   "
      + keys.map((x) => x + ":" + m.get(x)).join("  "));
    log("      null mean " + mean.toFixed(2));
  }
  state.phase = "pairs";

  // ── what the real directory did ─────────────────────────────────────────
  log("");
  log("── the real directory ──");
  log("  k   pairs   null mean   p(>= observed)   creation-index gaps");
  const observed = new Map<number, { i: number; j: number; gap: number }[]>();
  for (const k of KS) {
    const pairs = collidingPairs(ids, k);
    observed.set(k, pairs);
    const m = nullDist.get(k)!;
    let ge = 0;
    for (const [c, n] of m) if (c >= pairs.length) ge += n;
    const mean = Array.from(m.keys()).reduce((s, x) => s + x * (m.get(x) ?? 0), 0) / TRIALS;
    log("  " + String(k).padStart(2) + String(pairs.length).padStart(7)
      + mean.toFixed(2).padStart(11)
      + ((ge / TRIALS) * 100).toFixed(1).padStart(13) + "%"
      + "   " + (pairs.length ? pairs.map((p) => p.i + "↔" + p.j + " (gap " + p.gap + ")").join(", ") : "—"));
  }

  const widest = KS[KS.length - 1];

  // ── what the ids are actually made of ───────────────────────────────────
  // Before asking whether collisions are correlated, pin down how many bits are
  // free at all. A position holding the same value in every id carries no
  // information, and if one of those sat inside the tag the whole pool
  // arithmetic would be measuring a smaller space than it claims.
  log("");
  log("── bit invariance across the directory ──");
  const bitRows = ids.map((x) => T.accountIdBits(x));
  const invariant: { bit: number; value: string }[] = [];
  for (let b = 0; b < T.ID_BITS; b++) {
    const idx = T.ID_BITS - 1 - b;
    const c = bitRows[0][idx];
    if (bitRows.every((r) => r[idx] === c)) invariant.push({ bit: b, value: c });
  }
  const tagLo = T.ID_BITS - T.DEFAULT_TAG_LEN;
  const invInTag = invariant.filter((x) => x.bit >= tagLo);
  log("  " + invariant.length + " of " + T.ID_BITS + " positions hold one value in all " + N + " ids:");
  log("    " + (invariant.map((x) => x.bit + "=" + x.value).join("  ") || "none"));
  log("  tag bits are " + tagLo + ".." + (T.ID_BITS - 1) + " → "
    + (invInTag.length
      ? invInTag.map((x) => x.bit + "=" + x.value).join(", ") + " INVARIANT — the tag space is smaller than 16,384"
      : "none invariant, all " + T.DEFAULT_TAG_LEN + " free"));
  const freeBits = T.ID_BITS - invariant.length;
  const expectedDiff = freeBits / 2;
  state.meta.invariant = invariant;

  // what a random pair of directory members looks like, for scale
  const rr = mulberry32(0x1234_5678);
  const sampleDiff: number[] = [];
  const sampleTop: number[] = [];
  for (let t = 0; t < 500; t++) {
    const i = Math.floor(rr() * N);
    let j = Math.floor(rr() * N);
    if (i === j) j = (j + 1) % N;
    const x = xorReport(ids[i], ids[j]);
    sampleDiff.push(x.bits);
    sampleTop.push(x.topBit);
  }
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = (a: number[]) => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(a.length - 1, 1));
  };
  log("");
  log("  500 random directory pairs: mean " + mean(sampleDiff).toFixed(2)
    + " differing bits (sd " + sd(sampleDiff).toFixed(2) + "), highest differing bit "
    + mean(sampleTop).toFixed(1) + " on average");
  log("  " + freeBits + " free bits predict " + expectedDiff.toFixed(2));

  // ── the fingerprints of sequential generation ───────────────────────────
  // Two fingerprints, each tested where it actually has power.
  //
  // Fingerprint 1 is creation order, and it is tested at the COARSEST width,
  // not the widest. At k = 14 a clean directory yields one colliding pair or
  // none, and a single gap separates nothing: roughly 9% of random pairs out of
  // 128 sit within six indices of each other. The first run of this page failed
  // exactly that way — one pair, gap 6, and a threshold that meant nothing. At
  // k = 10 there are enough pairs to average.
  const orderK = KS[0];
  const orderPairs = observed.get(orderK) ?? [];
  const gaps = orderPairs.map((p) => p.gap);
  const meanGap = gaps.length ? mean(gaps) : NaN;
  const expectedGap = (N + 1) / 3; // mean |i − j| over order-independent pairs
  log("");
  log("── fingerprint 1 · creation order, at k = " + orderK + " (" + orderPairs.length + " pairs) ──");
  log("    gaps " + (gaps.length ? gaps.join(", ") : "—"));
  log("    mean " + (gaps.length ? meanGap.toFixed(1) : "n/a") + " vs "
    + expectedGap.toFixed(1) + " expected if ids are nothing to do with creation order");

  // A simulated null for the mean gap, because with this few pairs a Gaussian
  // approximation is worse than just asking.
  const GAP_TRIALS = 20000;
  const grng = mulberry32(0x9a9a_0007);
  let geCount = 0;
  let leCount = 0;
  for (let t = 0; t < GAP_TRIALS; t++) {
    let s = 0;
    for (let m = 0; m < gaps.length; m++) {
      const i = Math.floor(grng() * N);
      let j = Math.floor(grng() * (N - 1));
      if (j >= i) j++;
      s += Math.abs(i - j);
    }
    const mu = gaps.length ? s / gaps.length : 0;
    if (mu >= meanGap) geCount++;
    if (mu <= meanGap) leCount++;
  }
  const gapP = gaps.length ? Math.min(1, (2 * Math.min(geCount, leCount)) / GAP_TRIALS) : 1;
  log("    two-sided p = " + (gapP * 100).toFixed(1) + "% over " + GAP_TRIALS + " simulated directories");

  // Fingerprint 2 is how much of the id actually differs, and this one does
  // belong at the widest width with a collision: two independent ids sharing
  // their top k bits are still uniform in the rest, so they differ in about
  // half the free bits below the tag and their highest differing bit sits just
  // under the tag boundary. A counter or nonce instead diverges at the bottom.
  let probeK = widest;
  while (probeK > KS[0] && (observed.get(probeK) ?? []).length === 0) probeK--;
  const probePairs = observed.get(probeK) ?? [];
  // Bits at or above this floor are the prefix the collision is defined by, so a
  // genuine k = probeK collision can never differ at or above it. Comparing
  // against the 14-bit boundary instead — which the first run of this page did —
  // labels a perfectly correct result "INSIDE the tag bits" whenever probeK < 14.
  const probeFloor = T.ID_BITS - probeK;
  log("");
  log("── fingerprint 2 · bit divergence, at k = " + probeK + " (" + probePairs.length + " pair(s)) ──");
  const diffBits: number[] = [];
  const topDiffBits: number[] = [];
  for (const p of probePairs) {
    const a = ids[p.i];
    const b = ids[p.j];
    const x = xorReport(a, b);
    diffBits.push(x.bits);
    topDiffBits.push(x.topBit);
    log("    #" + String(p.i).padStart(3) + " " + T.normalizeId(a));
    log("    #" + String(p.j).padStart(3) + " " + T.normalizeId(b));
    log("      xor " + x.hex + "   differ in " + x.bits + " bit(s), highest at bit " + x.topBit
      + (x.topBit < probeFloor
        ? "  ← below the top " + probeK + " bits, as this collision requires"
        : "  ← IMPOSSIBLE for a k=" + probeK + " collision"));
  }
  const expectedPairDiff = (freeBits - probeK) / 2;

  // ── checks ──────────────────────────────────────────────────────────────
  log("");
  log("── checks ──");

  check("the null model reproduces the closed form",
    KS.every((k) => {
      const m = nullDist.get(k)!;
      const mu = Array.from(m.keys()).reduce((s, x) => s + x * (m.get(x) ?? 0), 0) / TRIALS;
      return Math.abs(mu - M.predictedPairs(k, N)) < 3 * Math.sqrt(Math.max(M.predictedPairs(k, N), 0.1) / TRIALS) + 0.05;
    }),
    KS.map((k) => {
      const m = nullDist.get(k)!;
      const mu = Array.from(m.keys()).reduce((s, x) => s + x * (m.get(x) ?? 0), 0) / TRIALS;
      return "k=" + k + " " + mu.toFixed(2) + " vs " + M.predictedPairs(k, N).toFixed(2);
    }).join(" · "));

  const pTail = (k: number) => {
    const m = nullDist.get(k)!;
    const n = (observed.get(k) ?? []).length;
    let ge = 0;
    for (const [c, cnt] of m) if (c >= n) ge += cnt;
    return ge / TRIALS;
  };
  check("no width shows more collisions than the uniform null allows",
    KS.every((k) => pTail(k) >= 0.01),
    KS.map((k) => "k=" + k + " p=" + (pTail(k) * 100).toFixed(0) + "%").join(" · "));

  check("no invariant bit sits inside the 14 tag bits",
    invInTag.length === 0,
    invInTag.length ? invInTag.map((x) => "bit " + x.bit).join(", ") : invariant.length + " invariant bits, all below bit " + tagLo);

  check("a random pair differs in exactly the number of bits the free-bit count predicts",
    Math.abs(mean(sampleDiff) - expectedDiff) < 3 * sd(sampleDiff) / Math.sqrt(500) + 0.5,
    mean(sampleDiff).toFixed(2) + " observed vs " + expectedDiff.toFixed(2)
    + " predicted (±" + (3 * sd(sampleDiff) / Math.sqrt(500)).toFixed(2) + ")");

  // Fingerprint 1 — creation order. A counter or nonce-driven generator makes
  // neighbours collide, so the gaps would be tiny. Order-independent ids give a
  // mean gap of (N+1)/3 ≈ 43.
  check("colliding pairs are not creation-order neighbours",
    gaps.length === 0 || gapP >= 0.01,
    gaps.length
      ? gaps.length + " pairs at k=" + orderK + ", mean gap " + meanGap.toFixed(1)
        + " vs " + expectedGap.toFixed(1) + " expected, p = " + (gapP * 100).toFixed(1) + "%"
      : "no pairs at k=" + orderK + " to test");

  // Fingerprint 2 — how much of the id actually differs. Two independent ids
  // that happen to share their top k bits are still uniform in the rest, so
  // they differ in about half of the free bits below the tag. A sequential
  // generator instead differs in a handful of low bits.
  check("colliding pairs differ across the whole id, not in a few low bits",
    diffBits.length === 0 || mean(diffBits) > 0.6 * expectedPairDiff,
    (diffBits.length ? mean(diffBits).toFixed(1) : "n/a") + " differing bits vs ~"
    + expectedPairDiff.toFixed(0) + " expected for independent ids sharing the top " + probeK);

  // Same test read off the top: the highest differing bit should sit just under
  // the prefix the collision is defined by, not buried at the bottom.
  check("the divergence reaches up to just below the probed prefix",
    topDiffBits.length === 0 || Math.max(...topDiffBits) >= probeFloor - 20,
    topDiffBits.length
      ? "highest differing bit " + Math.max(...topDiffBits) + ", the top " + probeK
        + " bits start at " + probeFloor
      : "no pairs at any width to test");

  state.meta.result = {
    n: N,
    observedPairs: Object.fromEntries(KS.map((k) => [k, (observed.get(k) ?? []).length])),
    nullMeans: Object.fromEntries(KS.map((k) => {
      const m = nullDist.get(k)!;
      return [k, +(Array.from(m.keys()).reduce((s, x) => s + x * (m.get(x) ?? 0), 0) / TRIALS).toFixed(3)];
    })),
    pTails: Object.fromEntries(KS.map((k) => [k, +pTail(k).toFixed(4)])),
    invariantBits: invariant.map((x) => x.bit + "=" + x.value),
    freeBits,
    orderK,
    gapP: +gapP.toFixed(4),
    meanGap: gaps.length ? +meanGap.toFixed(2) : null,
    expectedGap: +expectedGap.toFixed(2),
    probeK,
    gaps,
    diffBits,
    topDiffBits,
    meanRandomDiffBits: +mean(sampleDiff).toFixed(2),
    expectedRandomDiffBits: +expectedDiff.toFixed(2),
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
