// Stage 5 — the pool fetch strategy.
//
// `MIDEN-011` measured the live transport: at most **500 notes per request**, the
// budget **aggregate across every tag in that request**, served **oldest first**,
// with **no cursor and no pagination**. That is the constraint Stage 5 has to be
// built around, and it produces an uncomfortable asymmetry:
//
//   128 tags in ONE request share ONE 500-note budget.
//   4 requests of 32 tags get FOUR separate budgets.
//
// So fetching the pool as one wide request is not merely slower or faster — it is
// the wrong shape. This page measures whether that matters, and answers three
// questions the corpus has not:
//
//   A. Does the mock transport model the 500-note cap at all? If it does, a
//      flooded tag will come back short and the cap is reproducible locally.
//      If it does not, the strategy rests on the live measurement and this page
//      must say so instead of implying it was reproduced.
//
//   B. Does a full pool fetch return everything that per-tag queries return? This
//      is `BUILD-001`'s stated acceptance test for the stage, and it is decided
//      by comparing against ground truth — the two per-tag observers, not the
//      sender's own count.
//
//   C. Is tag removal a safe batching lever? If `tags.remove` preserves notes
//      already synced, a batch can be unregistered once its notes are in the
//      store and each batch stays cheap. If removal deletes them, batches must
//      accumulate and every sync re-fetches everything. The library's default
//      depends on which.

import * as SDK from "@miden-sdk/miden-sdk";
import * as T from "./envelope/tags";
import * as S from "./envelope/send";
import * as F from "./envelope/fetch";

const out = document.getElementById("out")!;
const lines: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const phase = { t: performance.now() };
const state = {
  status: "running" as "running" | "pass" | "fail",
  lines,
  checks,
  phases: {} as Record<string, unknown>,
  meta: {} as Record<string, unknown>,
};
(window as any).__STAGE5__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  log((ok ? "   ok " : "  FAIL") + "  " + name + (detail ? "   " + detail : ""));
}
function mark(name: string) {
  const now = performance.now();
  (state.phases as any)[name] = Math.round(now - phase.t);
  phase.t = now;
}
const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240);
const hex8 = T.describeTag;

const K = 7;
/** Comfortably past the 500-note per-request cap, if the transport enforces it. */
const TARGET_FLOOD = 520;
const SPREAD = 8;
/** Give up on flooding after this long and record what was actually reached. */
const FLOOD_LIMIT_MS = 120_000;
/**
 * An empty, default-shaped tag. Registering and syncing it fetches nothing.
 *
 * Stage 5b measured why this is here: the **first** `sync()` on a client restored
 * from a snapshot costs 18–33× more than a later one doing identical work
 * (115 s and 204 s cold, against 6.3 s warm). A 100 ms sync against an empty tag
 * moves the whole ingest onto the cheap path. Without it this page spends ~5
 * minutes doing the same measurement Stage 5b did.
 */
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

async function main() {
  const t0 = performance.now();
  const {
    MidenClient, FaucetType, AccountId,
  } = SDK as any;
  for (const [name, v] of Object.entries({ MidenClient, FaucetType, AccountId })) {
    if (!v) throw new Error("SDK does not export " + name);
  }

  log("stage 5 — the pool fetch strategy");
  log("");
  mark("boot");

  await wipeStores();
  const client = await MidenClient.createMock();
  const faucet = await client.accounts.create({
    type: FaucetType.FungibleFaucet, symbol: "TST", decimals: 6, maxSupply: 1_000_000_000n,
  });
  const alice = await client.accounts.create();
  const bob = await client.accounts.create();
  const ids = {
    faucet: faucet.id().toString(),
    alice: alice.id().toString(),
    bob: bob.id().toString(),
  };
  mark("accounts");

  await client.transactions.mint({
    account: ids.faucet, to: ids.alice, amount: 100_000_000n, type: "public",
  });
  await client.proveBlock();
  await client.sync();
  await client.transactions.consumeAll({ account: ids.alice });
  await client.proveBlock();
  await client.sync();
  mark("funding");

  // ── the traffic shape ─────────────────────────────────────────────────
  const pool = T.poolFor(ids.bob, K);
  const hotTag = pool[63];
  const spreadTags = [1, 8, 16, 24, 32, 40, 48, 56].map((i) => pool[i]);
  log("  bob's pool        " + pool.length + " tags, k = " + K);
  log("  flooded tag       " + hex8(hotTag) + "   ← target " + TARGET_FLOOD + " notes, past the 500 cap");
  log("  spread tags       " + spreadTags.map(hex8).join(" "));
  check("the flooded tag is in the pool", pool.includes(hotTag));
  check("the spread tags are distinct and in the pool",
    new Set(spreadTags).size === SPREAD && spreadTags.every((t) => pool.includes(t)));

  // ── send ──────────────────────────────────────────────────────────────
  //
  // Settle is deferred to a single proveBlock at the end: 500+ individual block
  // proofs would dominate the run and measure nothing this stage cares about.
  log("");
  log("── sending ──");
  const rng = mulberry32(0x5eed_0005);
  const sent: { noteId: string; tag: number; group: "flood" | "spread" }[] = [];
  const sendStart = performance.now();
  let flood = 0;
  let stalled = false;

  for (let i = 0; i < TARGET_FLOOD; i++) {
    if (performance.now() - sendStart > FLOOD_LIMIT_MS) { stalled = true; break; }
    const r = await S.sendEnvelope({
      client, from: ids.alice, to: ids.bob,
      assets: [{ token: ids.faucet, amount: BigInt(1000 + i) }],
      k: K, rng, tag: hotTag, settle: false, relay: false,
    });
    sent.push({ noteId: r.noteId, tag: r.tag, group: "flood" });
    flood++;
    if (flood % 100 === 0) log("  flood " + flood + "…  " + Math.round(performance.now() - sendStart) + " ms elapsed");
  }
  const floodMs = performance.now() - sendStart;

  for (let i = 0; i < SPREAD; i++) {
    const r = await S.sendEnvelope({
      client, from: ids.alice, to: ids.bob,
      assets: [{ token: ids.faucet, amount: BigInt(9000 + i) }],
      k: K, rng, tag: spreadTags[i], settle: false, relay: false,
    });
    sent.push({ noteId: r.noteId, tag: r.tag, group: "spread" });
  }
  log("  sent " + sent.length + " notes in " + Math.round(performance.now() - sendStart) + " ms" +
      (stalled ? "  (stopped at the time limit — see note below)" : ""));
  log("  " + flood + " on the flooded tag · " + SPREAD + " across " + SPREAD + " other tags");
  mark("send");

  log("");
  log("  settling once, then relaying " + sent.length + " notes");
  await client.proveBlock();
  await client.sync();

  let relayed = 0;
  const relayErrors: string[] = [];
  for (const n of sent) {
    try {
      await client.notes.sendPrivateOutput({ noteId: n.noteId as any, to: ids.bob });
      relayed++;
    } catch (e) {
      if (relayErrors.length < 3) relayErrors.push(E(e));
    }
  }
  log("  relayed " + relayed + " of " + sent.length +
      (relayErrors.length ? "   errors: " + relayErrors.join(" | ") : ""));
  check("every note was relayed", relayed === sent.length, relayed + " of " + sent.length);
  check("every serial was distinct", new Set(sent.map((s) => s.noteId)).size === sent.length);
  mark("relay");

  const chainBlob = await client.serializeMockChain();
  const transportBlob = await client.serializeMockNoteTransportNode();
  log("  snapshot: chain " + chainBlob.length + " bytes, transport " + transportBlob.length + " bytes");
  try { await (client as any)[Symbol.asyncDispose](); } catch { try { client.terminate(); } catch { /* ignore */ } }
  mark("snapshot");

  // ── observers ─────────────────────────────────────────────────────────
  type Row = { id: string; tag: string; amount: string };

  async function fresh(): Promise<any> {
    await wipeStores();
    const c = await MidenClient.createMock({ serializedMockChain: chainBlob, serializedNoteTransport: transportBlob });
    // Move the expensive first sync off the measurement — see EMPTY_TAG.
    await c.tags.add(EMPTY_TAG);
    await c.sync();
    return c;
  }

  function rowsOf(list: any[]): Row[] {
    return list.map((n0: any) => {
      const r: Row = { id: noteIdHex(n0), tag: "?", amount: "?" };
      try { r.tag = hex8(n0.metadata().tag().asU32()); } catch { /* keep ? */ }
      try {
        const fa = n0.details().assets().fungibleAssets();
        r.amount = fa.map((a: any) => String(a.amount())).join("+") || "none";
      } catch { /* keep ? */ }
      return r;
    });
  }

  async function teardown(c: any) {
    try { await c[Symbol.asyncDispose](); } catch { try { c.terminate(); } catch { /* ignore */ } }
  }

  // O1 — ground truth for the flooded tag.
  log("");
  log("── O1 · the flooded tag alone (per-tag ground truth) ──");
  const o1c = await fresh();
  const o1t = performance.now();
  await o1c.tags.add(hotTag);
  await o1c.sync();
  const o1rows = rowsOf(await o1c.notes.list());
  const o1ms = Math.round(performance.now() - o1t);
  log("  found " + o1rows.length + " of " + flood + " sent, in " + o1ms + " ms");
  const o1ids = new Set(o1rows.map((r) => r.id));
  if (o1rows.length < flood) {
    const missing = sent.filter((s) => s.group === "flood" && !o1ids.has(s.noteId));
    log("  missing " + missing.length + " — newest kept?   " + missing.slice(0, 3).map((m) => m.noteId.slice(0, 14) + "…").join(" "));
  }
  await teardown(o1c);
  mark("O1");

  // O2 — ground truth for the other tags.
  log("");
  log("── O2 · the " + SPREAD + " spread tags (the rest of the truth) ──");
  const o2c = await fresh();
  const o2t = performance.now();
  for (const t of spreadTags) await o2c.tags.add(t);
  await o2c.sync();
  const o2rows = rowsOf(await o2c.notes.list());
  const o2ms = Math.round(performance.now() - o2t);
  log("  found " + o2rows.length + " of " + SPREAD + " sent, in " + o2ms + " ms");
  await teardown(o2c);
  mark("O2");

  const truth = o1rows.length + o2rows.length;
  const truthIds = new Set([...o1rows.map((r) => r.id), ...o2rows.map((r) => r.id)]);
  log("");
  log("  ground truth = " + truth + " notes (" + o1rows.length + " flooded + " + o2rows.length + " spread)");
  check("the two per-tag observers account for every note sent", truth === sent.length,
    truth + " of " + sent.length + (stalled ? " (flood stopped early at " + flood + ")" : ""));

  // O3 — the whole pool in one request.
  log("");
  log("── O3 · the whole 128-tag pool, ONE request ──");
  const o3c = await fresh();
  const o3t = performance.now();
  for (const t of pool) await o3c.tags.add(t);
  await o3c.sync();
  const o3rows = rowsOf(await o3c.notes.list());
  const o3ms = Math.round(performance.now() - o3t);
  log("  found " + o3rows.length + " in " + o3ms + " ms");
  const o3ids = new Set(o3rows.map((r) => r.id));
  const o3missed = [...truthIds].filter((id) => !o3ids.has(id));
  log("  missed " + o3missed.length + " of the ground truth");
  await teardown(o3c);
  mark("O3");

  // O4 — the library's batched fetch.
  log("");
  log("── O4 · fetchPool, 32 tags per batch ──");
  const o4c = await fresh();
  const plan = F.planFetch(pool, 32);
  F.assertPoolCovered(pool, plan);
  log("  plan: " + F.describePlan(pool.length, 32).seams);
  const o4 = await F.fetchPool(o4c, pool, {
    tagsPerRequest: 32,
    onBatch: (b) => log("    batch " + (b.index + 1) + "/" + plan.length +
      "  " + String(b.tags).padStart(3) + " tags  +" + String(b.found).padStart(3) + " notes" +
      "  " + b.ms + " ms" + (b.saturated ? "  SATURATED" : "")),
  });
  log("  total " + o4.total + " notes across " + o4.requests + " request(s), " + o4.totalMs + " ms");
  const o4ids = new Set(o4.noteIds);
  const o4missed = [...truthIds].filter((id) => !o4ids.has(id));
  log("  missed " + o4missed.length + " of the ground truth");
  await teardown(o4c);
  mark("O4");

  // O5 — incremental accumulation: add a batch, sync, add more, sync.
  log("");
  log("── O5 · accumulate: 32 tags, sync, then the other 96 ──");
  const o5c = await fresh();
  const o5t = performance.now();
  for (const t of pool.slice(0, 32)) await o5c.tags.add(t);
  await o5c.sync();
  const half = rowsOf(await o5c.notes.list()).length;
  for (const t of pool.slice(32)) await o5c.tags.add(t);
  await o5c.sync();
  const whole = rowsOf(await o5c.notes.list());
  const o5ms = Math.round(performance.now() - o5t);
  log("  after 32 tags:  " + half + " notes");
  log("  after 128 tags: " + whole.length + " notes, in " + o5ms + " ms");
  const o5ids = new Set(whole.map((r) => r.id));
  const o5missed = [...truthIds].filter((id) => !o5ids.has(id));
  await teardown(o5c);
  mark("O5");

  // O6 — is tag removal a safe batching lever?
  log("");
  log("── O6 · add the flooded tag, sync, REMOVE it, sync ──");
  const o6c = await fresh();
  await o6c.tags.add(hotTag);
  await o6c.sync();
  const beforeRemove = rowsOf(await o6c.notes.list()).length;
  await o6c.tags.remove(hotTag);
  await o6c.sync();
  const afterRemove = rowsOf(await o6c.notes.list()).length;
  log("  notes before removal: " + beforeRemove);
  log("  notes after removal:  " + afterRemove);
  log("  registered tags now:  " + (await o6c.tags.list()).length);
  await teardown(o6c);
  mark("O6");

  // ── verdict ───────────────────────────────────────────────────────────
  log("");
  log("── verdict ──");

  const capModelled = o1rows.length < flood;
  log("  the mock " + (capModelled ? "DOES" : "does NOT") + " model the 500-note cap"
    + "   (flooded tag returned " + o1rows.length + " of " + flood + ")");

  check(
    "O1 the flooded tag returns everything, or exactly the cap",
    o1rows.length === flood || o1rows.length === F.TRANSPORT_NOTE_CAP,
    o1rows.length + " of " + flood,
  );
  check(
    "O3 one 128-tag request recovers the whole ground truth",
    o3missed.length === 0,
    o3missed.length + " missed of " + truth + " on this transport",
  );
  check(
    "O4 the batched fetch recovers the whole ground truth",
    o4missed.length === 0,
    o4missed.length + " missed of " + truth + " across " + o4.requests + " request(s)",
  );
  check(
    "O4 issues one request per batch, not one for the pool",
    o4.requests === plan.length,
    o4.requests + " request(s) for " + plan.length + " batch(es)",
  );
  check(
    "O4's saturation detector stays quiet below the cap",
    o4.saturatedBatches === 0,
    o4.saturatedBatches + " flagged; the largest batch returned " +
      Math.max(...o4.batches.map((b) => b.found)) + " notes against a cap of " + F.TRANSPORT_NOTE_CAP,
  );
  check(
    "O5 accumulating tags across syncs loses nothing",
    o5missed.length === 0,
    o5missed.length + " missed; " + half + " notes after 32 tags, " + whole.length + " after 128",
  );
  const removalSafe = afterRemove === beforeRemove && beforeRemove > 0;
  check(
    "O6 removing a synced tag keeps its notes  → removeAfterBatch is safe",
    removalSafe,
    beforeRemove + " → " + afterRemove + (removalSafe ? "" : "   the store drops notes with the tag"),
  );

  check(
    "O4's batched fetch costs no more than 3× the single wide request",
    o4.totalMs <= o3ms * 3,
    o3ms + " ms vs " + o4.totalMs + " ms = " + (o4.totalMs / o3ms).toFixed(2) + "×",
  );

  // The budget argument, stated as arithmetic on measured semantics.
  const oneShot = F.TRANSPORT_NOTE_CAP;
  const batched = 4 * F.TRANSPORT_NOTE_CAP;
  log("");
  log("  per-request budget, by strategy (from MIDEN-011's measured semantics):");
  log("    1 request  × 128 tags   " + oneShot + " notes");
  log("    4 requests ×  32 tags   " + batched + " notes   (" + (batched / oneShot).toFixed(1) + "× headroom)");
  log("    8 requests ×  16 tags   " + (8 * F.TRANSPORT_NOTE_CAP) + " notes   (" + ((8 * F.TRANSPORT_NOTE_CAP) / oneShot).toFixed(1) + "× headroom)");
  log("");
  log("  cost on this transport, all " + truth + " notes (both warm — see below):");
  log("    one request   " + o3ms + " ms");
  log("    four batches  " + o4.totalMs + " ms   (" + (o4.totalMs / o3ms).toFixed(2) + "×)");
  log("  batching buys budget, not speed. Any apparent speed-up here is the");
  log("  cold-sync penalty (stage 5b) landing on whichever observer syncs once,");
  log("  not a property of batching — measured, then removed from every observer.");
  log("  total run " + Math.round(performance.now() - t0) + " ms");

  state.meta.result = {
    sent: sent.length,
    flood,
    spread: SPREAD,
    stalled,
    floodMs: Math.round(floodMs),
    truth,
    o1: o1rows.length,
    o1ms,
    o2: o2rows.length,
    o2ms,
    o3: o3rows.length,
    o3ms,
    o3missed: o3missed.length,
    o4: o4.total,
    o4ms: o4.totalMs,
    o4requests: o4.requests,
    o4missed: o4missed.length,
    o5: whole.length,
    o5missed: o5missed.length,
    o6before: beforeRemove,
    o6after: afterRemove,
    capModelled,
    removalSafe,
  };
  (state.phases as any).total = Math.round(performance.now() - t0);

  const failed = checks.filter((c) => !c.ok);
  state.status = failed.length === 0 ? "pass" : "fail";
  log("");
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
