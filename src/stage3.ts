// Stage 3 — the tag math becomes library code.
//
// Harness v1 proved the tag model (336/336 predictions) and v2 used it. Both had
// the arithmetic inline, in a page. This stage moves it into
// `src/envelope/tags.ts` — the library's first real module — and then asks three
// questions the corpus has not answered:
//
//   B. What is an account ID actually made of? The SDK exposes `prefix()`,
//      `suffix()`, `isPrivate()` and `isPublic()`, none of which the harness ever
//      read. If the account's storage mode shows up in the bits a tag encodes,
//      the tag leaks it — a channel nobody has logged.
//
//   C. Is the top-7-bit collision rate real? `MIDEN-012` states 1 in 128 per
//      account pair and caveats it as "arithmetic, not a sample … real account
//      ids may not be uniform in their high bits". This measures the sample.
//
//   D. How many tags will a client actually track? v2 got anecdotes (160, then
//      455). The number decides whether the library can offer k < 7 at the cost
//      of extra requests, or whether 128 is a hard floor on the design.

import * as SDK from "@miden-sdk/miden-sdk";
import * as T from "./envelope/tags";

const out = document.getElementById("out")!;
const lines: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const state = {
  status: "running" as "running" | "pass" | "fail",
  lines,
  checks,
  phases: {} as Record<string, unknown>,
  meta: {} as Record<string, unknown>,
};
(window as any).__STAGE3__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  log((ok ? "   ok " : "  FAIL") + "  " + name + (detail ? "   " + detail : ""));
}
const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
const hex8 = T.describeTag;

/** Reproducible RNG so a re-run produces the same sample. */
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function wipeStores(): Promise<string[]> {
  const deleted: string[] = [];
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((resolve) => {
            if (!d.name) return resolve();
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = () => { deleted.push(d.name!); resolve(); };
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
            setTimeout(resolve, 2000);
          }),
      ),
    );
  } catch (e) {
    deleted.push("<databases() unavailable: " + E(e) + ">");
  }
  return deleted;
}

/** Fraction of 1s at each bit position, indexed MSB-first (0 = bit 119). */
function bitBias(ids: string[]): number[] {
  const bias = new Array<number>(T.ID_BITS).fill(0);
  if (ids.length === 0) return bias;
  for (const id of ids) {
    const bits = T.accountIdBits(id);
    for (let i = 0; i < T.ID_BITS; i++) if (bits[i] === "1") bias[i]++;
  }
  return bias.map((c) => c / ids.length);
}

async function main() {
  const t0 = performance.now();
  const { MidenClient, FaucetType, NoteTag, AccountId } = SDK as any;
  for (const [name, v] of Object.entries({ MidenClient, FaucetType, NoteTag, AccountId })) {
    if (!v) throw new Error("SDK does not export " + name);
  }

  log("stage 3 — tag math, as library code");
  log("");

  await wipeStores();
  const client = await MidenClient.createMock();
  log("client up in " + Math.round(performance.now() - t0) + " ms");

  // ══ Phase A — the library against the SDK ═══════════════════════════════
  log("");
  log("── A · the library against the SDK ──");
  const tA = performance.now();

  const sample: { hex: string; kind: string; storage: string }[] = [];
  const FAUCETS = ["AAA", "BBB", "CCC", "DDD"];

  for (let i = 0; i < 10; i++) {
    const a = await client.accounts.create({ storage: "private" });
    sample.push({ hex: a.id().toString(), kind: "wallet", storage: "private" });
  }
  for (let i = 0; i < 10; i++) {
    const a = await client.accounts.create({ storage: "public" });
    sample.push({ hex: a.id().toString(), kind: "wallet", storage: "public" });
  }
  for (const symbol of FAUCETS) {
    const a = await client.accounts.create({
      type: FaucetType.FungibleFaucet, symbol, decimals: 6, maxSupply: 1_000_000_000n,
    });
    sample.push({ hex: a.id().toString(), kind: "faucet", storage: "faucet" });
  }
  log("  " + sample.length + " accounts in " + Math.round(performance.now() - tA) + " ms"
    + "  (" + Math.round((performance.now() - tA) / sample.length) + " ms each)");
  state.meta.sampleRateMs = (performance.now() - tA) / sample.length;

  // A1 — does AccountId.fromHex round-trip, and does the storage mode survive?
  let roundTrip = 0, modeAgrees = 0;
  for (const s of sample) {
    const id = AccountId.fromHex(s.hex);
    if (id.toString().toLowerCase() === s.hex.toLowerCase()) roundTrip++;
    const wantPrivate = s.storage === "private";
    if (id.isPrivate() === wantPrivate && id.isPublic() === !wantPrivate) modeAgrees++;
  }
  check("AccountId.fromHex round-trips every id", roundTrip === sample.length, roundTrip + "/" + sample.length);
  check(
    "isPrivate()/isPublic() agree with the storage mode asked for",
    modeAgrees === sample.length,
    modeAgrees + "/" + sample.length
  );

  // A2 — defaultTag vs the SDK's own constructor.
  let defaultOk = 0;
  for (const s of sample) {
    const mine = T.defaultTag(s.hex);
    const theirs = NoteTag.withAccountTarget(AccountId.fromHex(s.hex)).asU32() >>> 0;
    if (mine === theirs) defaultOk++;
  }
  check("defaultTag() matches NoteTag.withAccountTarget()", defaultOk === sample.length,
    defaultOk + "/" + sample.length);

  // A3 — coarseTag vs withCustomAccountTarget, every account at every k.
  let coarseOk = 0, coarseTotal = 0;
  const coarseMismatches: string[] = [];
  for (const s of sample) {
    const aid = AccountId.fromHex(s.hex);
    for (let k = 1; k <= T.DEFAULT_TAG_LEN; k++) {
      coarseTotal++;
      const mine = T.coarseTag(s.hex, k);
      const theirs = NoteTag.withCustomAccountTarget(aid, k).asU32() >>> 0;
      if (mine === theirs) coarseOk++;
      else if (coarseMismatches.length < 5) {
        coarseMismatches.push(`${s.hex.slice(0, 10)} k=${k} mine=${hex8(mine)} sdk=${hex8(theirs)}`);
      }
    }
  }
  check("coarseTag() matches withCustomAccountTarget() at every k", coarseOk === coarseTotal,
    coarseOk + "/" + coarseTotal + (coarseMismatches.length ? " — " + coarseMismatches.join("; ") : ""));

  // A4 — the SDK's own boundaries. Does it reject k outside 1..14?
  const boundary: { k: number; result: string }[] = [];
  for (const k of [0, 15, 32, -1]) {
    try {
      const t = NoteTag.withCustomAccountTarget(AccountId.fromHex(sample[0].hex), k).asU32() >>> 0;
      boundary.push({ k, result: "accepted → " + hex8(t) });
    } catch (e) {
      boundary.push({ k, result: "rejected: " + E(e) });
    }
  }
  log("  SDK boundary behaviour for k: " + boundary.map((b) => `${b.k} ${b.result}`).join(" | "));
  state.phases.A_boundary = boundary;

  // A4b — the SDK's silence above k=14 is the footgun MIDEN-009 describes: the
  // reserved low 18 bits stop being zero, so the tag stops looking like a real
  // account tag and publishes the account id's top bits verbatim.
  const k32tag = NoteTag.withCustomAccountTarget(AccountId.fromHex(sample[0].hex), 32).asU32() >>> 0;
  let libRefused = false;
  try { T.coarseTag(sample[0].hex, 32); } catch (e) { libRefused = e instanceof RangeError; }
  log("  at k=32 the SDK returns " + hex8(k32tag) + " — default-shaped: " + T.isDefaultShaped(k32tag));
  check(
    "the SDK will build a self-fingerprinting tag at k=32; the library refuses to",
    !T.isDefaultShaped(k32tag) && libRefused,
    "sdk=" + hex8(k32tag) + " low18bits=" + hex8(k32tag & T.TAG_MASK) + " libraryRefused=" + libRefused
  );
  state.phases.A_k32 = { tag: hex8(k32tag), defaultShaped: T.isDefaultShaped(k32tag), libraryRefused: libRefused };

  // A5 — the library's own boundaries must be stricter than the SDK's silence.
  let throwsOk = 0;
  const throwCases: [string, () => unknown][] = [
    ["k=0", () => T.coarseTag(sample[0].hex, 0)],
    ["k=15", () => T.coarseTag(sample[0].hex, 15)],
    ["k=1.5", () => T.coarseTag(sample[0].hex, 1.5)],
    ["short id", () => T.defaultTag("0x1234")],
    ["non-hex id", () => T.defaultTag("0x" + "z".repeat(30))],
  ];
  for (const [, fn] of throwCases) {
    try { fn(); } catch (e) { if (e instanceof RangeError) throwsOk++; }
  }
  check("the library rejects bad k and bad ids with RangeError", throwsOk === throwCases.length,
    throwsOk + "/" + throwCases.length);

  // A6 — pool shape, at every k, for every account.
  let poolOk = 0, poolTotal = 0;
  const poolProblems: string[] = [];
  for (const s of sample) {
    for (let k = 1; k <= T.DEFAULT_TAG_LEN; k++) {
      poolTotal++;
      const pool = T.poolFor(s.hex, k);
      const want = T.poolSize(k);
      const uniq = new Set(pool).size === pool.length;
      const shaped = pool.every(T.isDefaultShaped);
      const samePrefix = pool.every((t) => T.tagPrefix(t, k) === T.accountIdPrefix(s.hex, k));
      const hasDefault = pool.includes(T.defaultTag(s.hex));
      if (pool.length === want && uniq && shaped && samePrefix && hasDefault) poolOk++;
      else if (poolProblems.length < 5) {
        poolProblems.push(`${s.hex.slice(0, 8)} k=${k} size=${pool.length}/${want} uniq=${uniq} shaped=${shaped} prefix=${samePrefix} default=${hasDefault}`);
      }
    }
  }
  check("every pool has the right size, shape, prefix and default member", poolOk === poolTotal,
    poolOk + "/" + poolTotal + (poolProblems.length ? " — " + poolProblems.join("; ") : ""));
  check("k=7 gives exactly the 128-tag single-request pool", T.poolSize(7) === T.MAX_TAGS_PER_REQUEST,
    "poolSize(7)=" + T.poolSize(7));
  check("MIN_K_ONE_REQUEST is 7", T.MIN_K_ONE_REQUEST === 7, String(T.MIN_K_ONE_REQUEST));

  // A7 — blinding stays inside the pool and actually spreads.
  const rng = mulberry32(0x57a6e3);
  const target = sample[0].hex;
  const pool7 = T.poolFor(target, 7);
  let inside = 0, shaped = 0;
  const seen = new Set<number>();
  for (let i = 0; i < 4000; i++) {
    const b = T.blindedTag(target, 7, rng);
    if (pool7.includes(b)) inside++;
    if (T.isDefaultShaped(b)) shaped++;
    seen.add(b);
  }
  check("4000 blinded tags all land inside the pool", inside === 4000, inside + "/4000");
  check("4000 blinded tags are all default-shaped", shaped === 4000, shaped + "/4000");
  log("  blinding coverage: " + seen.size + " of " + pool7.length + " pool members hit in 4000 draws"
    + " (uniform expectation ≈ " + Math.round(pool7.length * (1 - Math.exp(-4000 / pool7.length))) + ")");
  check("blinding spreads across the pool, not onto one tag", seen.size > pool7.length * 0.9,
    seen.size + "/" + pool7.length);
  state.phases.A_blinding = { draws: 4000, distinct: seen.size, poolSize: pool7.length };

  // ══ Phase B — what an account ID is actually made of ════════════════════
  log("");
  log("── B · what an account id is made of ──");

  // B1 — the layout. `suffix()` is not the id's low 56 bits; it is those bits
  // shifted left by 8, so the naive concatenation does not reconstruct the id.
  let layoutOk = 0;
  const widths: { p: number; s: number }[] = [];
  for (const smp of sample) {
    const id = AccountId.fromHex(smp.hex);
    const pre = id.prefix().asInt();
    const suf = id.suffix().asInt();
    const whole = BigInt("0x" + T.normalizeId(smp.hex));
    if (widths.length < 8) widths.push({ p: pre.toString(2).length, s: suf.toString(2).length });
    if (((pre << 56n) | (suf >> 8n)) === whole) layoutOk++;
  }
  log("  example id      0x" + T.normalizeId(sample[0].hex));
  log("  prefix/suffix   bit widths seen: " + widths.map((w) => `${w.p}+${w.s}`).join(", "));
  log("  layout          id = (prefix << 56) | (suffix >> 8)");
  log("                  prefix is the top 64 bits; suffix() returns the low 56 pre-shifted by 8");
  state.phases.B_layout = { formula: "(prefix << 56) | (suffix >> 8)", matched: layoutOk, of: sample.length, widths };
  check("every id reconstructs as (prefix << 56) | (suffix >> 8)", layoutOk === sample.length,
    layoutOk + "/" + sample.length);

  // B1b — the mode bit. Bit 60 is the low end of the prefix, and it is the only
  // bit in the id that tracks the storage mode. It sits 28 bits below anything a
  // note tag can encode, because the SDK caps tag length at 32.
  const bit60 = (hex: string) => T.accountIdBits(hex)[T.ID_BITS - 1 - 60];
  let modeBitOk = 0;
  for (const smp of sample) {
    const wantPublic = smp.storage !== "private";
    if ((bit60(smp.hex) === "1") === wantPublic) modeBitOk++;
  }
  // The prefix is id bits 119..56, i.e. the first 64 characters of the MSB-first
  // bit string; its low 6 bits are therefore characters 58..63, which are id bits
  // 61..56. Slicing the *end* of the string instead reads the suffix's low bits
  // and prints noise — that bug is what made the first run of this line useless.
  const preLow6 = [...new Set(sample.map((s) =>
    T.accountIdBits(s.hex).slice(58, 64)))] as string[];
  log("  prefix low 6 bits observed: " + preLow6.map((b) => `0b${b}`).join(", ")
    + "   (pattern: 0·mode·0001)");
  check("id bit 60 is the storage-mode bit", modeBitOk === sample.length,
    modeBitOk + "/" + sample.length + " agree (0=private, 1=public)");

  // B2 — the question that matters: do the bits a tag encodes carry structure?
  const priv = sample.filter((s) => s.storage === "private").map((s) => s.hex);
  const pub = sample.filter((s) => s.storage === "public").map((s) => s.hex);
  const fauc = sample.filter((s) => s.kind === "faucet").map((s) => s.hex);

  const biasPriv = bitBias(priv);
  const biasPub = bitBias(pub);
  const biasFauc = bitBias(fauc);
  const biasAll = bitBias(sample.map((s) => s.hex));

  const biased = (b: number[], lo = 0, hi = T.ID_BITS) => {
    const hits: string[] = [];
    for (let i = lo; i < hi; i++) {
      if (b[i] <= 0.15 || b[i] >= 0.85) hits.push(`bit${T.ID_BITS - 1 - i}=${b[i].toFixed(2)}`);
    }
    return hits;
  };

  log("");
  log("  ones-fraction across the 14 bits a tag encodes (MSB first):");
  log("    private wallets  " + biasPriv.slice(0, 14).map((b) => b.toFixed(2).slice(1)).join(" "));
  log("    public  wallets  " + biasPub.slice(0, 14).map((b) => b.toFixed(2).slice(1)).join(" "));
  log("    faucets          " + biasFauc.slice(0, 14).map((b) => b.toFixed(2).slice(1)).join(" "));

  const tagBitsPriv = biased(biasPriv, 0, 14);
  const tagBitsPub = biased(biasPub, 0, 14);
  const tagBitsAll = biased(biasAll, 0, 14);
  const anywhereAll = biased(biasAll);
  const anywhereFauc = biased(biasFauc);

  log("");
  log("  strongly biased bit positions (≤0.15 or ≥0.85 ones), whole id:");
  log("    all accounts     " + (anywhereAll.length ? anywhereAll.join(" ") : "none"));
  log("    faucets only     " + (anywhereFauc.length ? anywhereFauc.slice(0, 24).join(" ") : "none"));
  log("    inside the tag bits — private: " + (tagBitsPriv.length ? tagBitsPriv.join(" ") : "none")
    + " · public: " + (tagBitsPub.length ? tagBitsPub.join(" ") : "none")
    + " · all: " + (tagBitsAll.length ? tagBitsAll.join(" ") : "none"));

  state.phases.B_structure = {
    n: { private: priv.length, public: pub.length, faucet: fauc.length },
    tagBitBias: { private: biasPriv.slice(0, 14), public: biasPub.slice(0, 14), faucet: biasFauc.slice(0, 14) },
    biasedAnywhere: anywhereAll,
    biasedInFaucets: anywhereFauc,
    biasedInTagBits: { private: tagBitsPriv, public: tagBitsPub, all: tagBitsAll },
  };

  check(
    "no bit inside the 14 tag bits is strongly biased across all accounts",
    tagBitsAll.length === 0,
    tagBitsAll.length ? tagBitsAll.join(" ") : "all 14 look uniform"
  );
  // Per-mode bias at 10 accounts each is mostly noise — stage 3b measures it
  // properly at 148 per mode. What does not depend on sample size is *reach*: the
  // widest tag the SDK will build is k=32, covering id bits 119..88, and the
  // storage-mode bit is id bit 60.
  log("  per-mode bias in the tag bits at this sample size is indicative only"
    + " (private: " + (tagBitsPriv.length ? tagBitsPriv.join(" ") : "none")
    + " · public: " + (tagBitsPub.length ? tagBitsPub.join(" ") : "none") + ")");
  check(
    "the storage-mode bit is out of reach of even the widest tag the SDK builds",
    60 < T.ID_BITS - 32,
    `mode bit 60 vs a k=32 tag covering id bits ${T.ID_BITS - 1}..${T.ID_BITS - 32}`
  );

  // ══ Phase C — is the 1-in-128 collision rate real? ══════════════════════
  log("");
  log("── C · the collision rate, measured ──");
  const tC = performance.now();
  const BUDGET_MS = 60_000;
  const MAX_ACCOUNTS = 512;
  const ids: string[] = sample.map((s) => s.hex);

  while (ids.length < MAX_ACCOUNTS && performance.now() - tC < BUDGET_MS) {
    const batch = Math.min(16, MAX_ACCOUNTS - ids.length);
    for (let i = 0; i < batch; i++) {
      const a = await client.accounts.create({ storage: i % 2 ? "public" : "private" });
      ids.push(a.id().toString());
    }
  }
  const elapsedC = performance.now() - tC;
  log("  " + ids.length + " account ids in " + Math.round(elapsedC) + " ms"
    + "  (" + Math.round(elapsedC / Math.max(1, ids.length - sample.length)) + " ms per new account)");

  for (const k of [4, 7, 10, 14]) {
    const buckets = new Map<number, number>();
    for (const id of ids) {
      const p = T.accountIdPrefix(id, k);
      buckets.set(p, (buckets.get(p) ?? 0) + 1);
    }
    let pairs = 0;
    for (const c of buckets.values()) pairs += (c * (c - 1)) / 2;
    const totalPairs = (ids.length * (ids.length - 1)) / 2;
    const expected = totalPairs / (1 << k);
    const biggest = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0];
    const observedRate = pairs / totalPairs;
    log(
      `  k=${String(k).padStart(2)}  ${String(buckets.size).padStart(4)} distinct prefixes of ${1 << k}`
      + `  ·  biggest holds ${biggest ? biggest[1] : 0}`
      + `  ·  colliding pairs ${pairs} (expected ${expected.toFixed(1)})`
      + `  ·  1 in ${observedRate > 0 ? Math.round(1 / observedRate) : "∞"} (model says 1 in ${1 << k})`
    );
    state.phases["C_k" + k] = {
      k, accounts: ids.length, distinctPrefixes: buckets.size, possiblePrefixes: 1 << k,
      biggestBucket: biggest ? biggest[1] : 0, collidingPairs: pairs, expectedPairs: expected,
      observedOneIn: observedRate > 0 ? 1 / observedRate : null, modelOneIn: 1 << k,
    };
    if (k === 7) {
      // MIDEN-012's caveat, tested. Within a factor of two is a fair sample at this n.
      const ratio = expected > 0 ? pairs / expected : 0;
      check("the k=7 collision rate matches 1 in 128", ratio > 0.5 && ratio < 2.0,
        `${pairs} observed vs ${expected.toFixed(1)} expected (ratio ${ratio.toFixed(2)})`);
      check("top-7 prefixes spread over most of the space", buckets.size > (1 << 7) * 0.5,
        buckets.size + "/128 prefixes used by " + ids.length + " accounts");
    }
  }
  state.meta.phaseC = { accounts: ids.length, ms: Math.round(elapsedC) };

  // ══ Phase D — how many tags will a client track? ═══════════════════════
  log("");
  log("── D · the client-side pool ceiling, and what it costs ──");

  // A client tracks a tag for every account it holds before we add anything.
  const baseline = (await client.tags.list()).length;
  log("  the client already tracks " + baseline + " tag(s) for the " + ids.length
    + " account(s) it holds — one auto-registered each");

  // `i` must run across steps, not restart: re-adding an existing tag is a no-op,
  // so a restarting counter measures duplicate writes and reports a set size it
  // never reached.
  const cost: { step: number; total: number; ms: number; perTag: number; error: string | null }[] = [];
  let next = 0;
  const steps = [128, 128, 256, 512, 1024, 2048];
  for (const step of steps) {
    const t = performance.now();
    let err: string | null = null;
    try {
      for (let i = 0; i < step; i++) {
        await client.tags.add(((next++) << T.RESERVED_LOW_BITS) >>> 0);
      }
    } catch (e) {
      err = E(e);
    }
    const ms = performance.now() - t;
    cost.push({ step, total: next, ms: Math.round(ms), perTag: ms / step, error: err });
    log(`  +${String(step).padStart(5)} distinct tags → ${String(next).padStart(5)} total`
      + `  (${Math.round(ms)} ms, ${(ms / step).toFixed(1)} ms/tag)` + (err ? "  ERROR: " + err : ""));
    if (err) break;
    if (performance.now() - t0 > 180_000) { log("  (time budget reached, stopping)"); break; }
  }

  const listed = (await client.tags.list()).length;
  log("  tags.list() returns " + listed + " = " + baseline + " auto + " + next + " added");

  // Idempotence, asserted rather than assumed: tag 0 was added in the first step.
  await client.tags.add(0);
  const afterDup = (await client.tags.list()).length;
  check("re-adding an existing tag does not duplicate it", afterDup === listed, `${listed} → ${afterDup}`);
  check("a client tracks far more than the 128-tag per-request ceiling", listed > T.MAX_TAGS_PER_REQUEST,
    listed + " tags tracked, no ceiling error");
  check("tags.list() accounts for every distinct tag added", listed === baseline + next,
    `listed=${listed} expected=${baseline + next}`);
  check(
    "registering tags gets steadily more expensive per tag as the set grows",
    cost.length >= 4 && cost[cost.length - 1].perTag > cost[0].perTag * 3,
    `${cost[0]?.perTag.toFixed(1)} ms/tag for the first ${cost[0]?.step}`
    + ` → ${cost[cost.length - 1]?.perTag.toFixed(1)} ms/tag reaching ${cost[cost.length - 1]?.total}`
  );
  state.phases.D_ceiling = { baseline, accounts: ids.length, cost, listed, afterDup };

  // What that means for the library: k below 7 costs requests, not impossibility.
  log("");
  log("  so a pool at k<7 is reachable, it just needs more requests:");
  for (const k of [4, 5, 6, 7, 8, 10, 14]) {
    log(`    k=${String(k).padStart(2)}  pool ${String(T.poolSize(k)).padStart(5)} tags`
      + `  → ${T.requestsForPool(k)} transport request(s)`);
  }
  state.phases.D_requests = [4, 5, 6, 7, 8, 10, 14].map((k) => ({
    k, pool: T.poolSize(k), requests: T.requestsForPool(k),
  }));

  // ══ verdict ═════════════════════════════════════════════════════════════
  log("");
  log("── verdict ──");
  log("done in " + Math.round(performance.now() - t0) + " ms");
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    log("PASS — the module agrees with the SDK everywhere, and three open questions have numbers");
    state.status = "pass";
  } else {
    log("FAILED " + failed.length + " check(s): " + failed.map((c) => c.name).join(" | "));
    state.status = "fail";
  }

  try { await (client as any)[Symbol.asyncDispose](); } catch { try { client.terminate(); } catch { /* ignore */ } }
}

main().catch((e) => {
  log("");
  log("FAIL: " + E(e));
  log(String((e as Error)?.stack ?? "").split("\n").slice(1, 4).join(" | "));
  state.status = "fail";
});
