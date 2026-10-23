// Stage 5b — the cold-sync penalty.
//
// Stage 5 produced a number it could not explain. The same 528 notes, restored
// from the same snapshot, ingest in wildly different times depending only on WHICH
// sync call carries them:
//
//   O1  one sync, one tag,          520 notes   91.7 s
//   O3  one sync, 128 tags,         528 notes  102.6 s
//   O4  four syncs, 32 tags each,   528 notes    7.5 s   (hot batch alone: 5.6 s)
//   O5  two syncs, 32 then 128,     528 notes    6.0 s
//
// A 16× difference between two paths that move identical data is either a real
// property of the client or a broken measurement, and Stage 3's instrument defects
// are the reason not to guess. So this page isolates it with segment timing: sync
// and `notes.list()` measured separately, on three clients restored from one
// snapshot.
//
//   B1  add the pool, sync once.                → the cold path, as the demo would
//   B2  sync once with an empty tag, then the pool. → can the cost be warmed away?
//   B3  add the pool, sync, then sync again.    → is the penalty per first sync?
//
// If B2 is fast, the fix is free and Stage 7 gets it. If B2 is slow too, the cost
// is unavoidable at cold load and the demo has to design around it — 100 s of
// spinner is not a demo.

import * as SDK from "@miden-sdk/miden-sdk";
import * as T from "./envelope/tags";
import * as S from "./envelope/send";

const out = document.getElementById("out")!;
const lines: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const state = {
  status: "running" as "running" | "pass" | "fail",
  lines,
  checks,
  meta: {} as Record<string, unknown>,
};
(window as any).__STAGE5B__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  log((ok ? "   ok " : "  FAIL") + "  " + name + (detail ? "   " + detail : ""));
}
const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240);
const hex8 = T.describeTag;

const K = 7;
const FLOOD = 520;
const SPREAD = 8;
/** An empty, default-shaped tag: registering it fetches nothing. */
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

async function main() {
  const t0 = performance.now();
  const { MidenClient, FaucetType } = SDK as any;

  log("stage 5b — why does the first sync cost 16× the second?");
  log("");

  await wipeStores();
  const client = await MidenClient.createMock();
  const faucet = await client.accounts.create({
    type: FaucetType.FungibleFaucet, symbol: "TST", decimals: 6, maxSupply: 1_000_000_000n,
  });
  const alice = await client.accounts.create();
  const bob = await client.accounts.create();
  const ids = { faucet: faucet.id().toString(), alice: alice.id().toString(), bob: bob.id().toString() };

  await client.transactions.mint({ account: ids.faucet, to: ids.alice, amount: 100_000_000n, type: "public" });
  await client.proveBlock();
  await client.sync();
  await client.transactions.consumeAll({ account: ids.alice });
  await client.proveBlock();
  await client.sync();

  const pool = T.poolFor(ids.bob, K);
  const hotTag = pool[63];
  const spreadTags = [1, 8, 16, 24, 32, 40, 48, 56].map((i) => pool[i]);
  log("  pool " + pool.length + " tags · flooded " + hex8(hotTag) + " · empty-tag control " + hex8(EMPTY_TAG));

  // ── the same traffic Stage 5 used ─────────────────────────────────────
  const rng = mulberry32(0x5eed_0005);
  const sendStart = performance.now();
  const sent: string[] = [];
  for (let i = 0; i < FLOOD; i++) {
    const r = await S.sendEnvelope({
      client, from: ids.alice, to: ids.bob,
      assets: [{ token: ids.faucet, amount: BigInt(1000 + i) }],
      k: K, rng, tag: hotTag, settle: false, relay: false,
    });
    sent.push(r.noteId);
    if ((i + 1) % 130 === 0) log("  sent " + (i + 1) + "…");
  }
  for (let i = 0; i < SPREAD; i++) {
    const r = await S.sendEnvelope({
      client, from: ids.alice, to: ids.bob,
      assets: [{ token: ids.faucet, amount: BigInt(9000 + i) }],
      k: K, rng, tag: spreadTags[i], settle: false, relay: false,
    });
    sent.push(r.noteId);
  }
  await client.proveBlock();
  await client.sync();
  for (const id of sent) await client.notes.sendPrivateOutput({ noteId: id as any, to: ids.bob });
  log("  " + sent.length + " notes built and relayed in " + Math.round(performance.now() - sendStart) + " ms");

  const chainBlob = await client.serializeMockChain();
  const transportBlob = await client.serializeMockNoteTransportNode();
  try { await (client as any)[Symbol.asyncDispose](); } catch { try { client.terminate(); } catch { /* ignore */ } }

  // ── segment timing ────────────────────────────────────────────────────
  type Seg = { label: string; syncMs: number; listMs: number; notes: number };

  async function fresh(): Promise<any> {
    await wipeStores();
    return MidenClient.createMock({ serializedMockChain: chainBlob, serializedNoteTransport: transportBlob });
  }

  /** Register tags, sync, list — each step timed on its own. */
  async function step(c: any, label: string, tags: number[]): Promise<Seg> {
    const a = performance.now();
    for (const t of tags) await c.tags.add(t);
    const addMs = performance.now() - a;
    const b = performance.now();
    await c.sync();
    const syncMs = performance.now() - b;
    const d = performance.now();
    const listed = await c.notes.list();
    const listMs = performance.now() - d;
    const seg: Seg = {
      label, syncMs: Math.round(syncMs), listMs: Math.round(listMs), notes: listed.length,
    };
    log("  " + label.padEnd(28) + " register " + String(Math.round(addMs)).padStart(5) + " ms"
      + " · sync " + String(seg.syncMs).padStart(6) + " ms"
      + " · list " + String(seg.listMs).padStart(5) + " ms"
      + " → " + seg.notes + " notes");
    return seg;
  }

  async function teardown(c: any) {
    try { await c[Symbol.asyncDispose](); } catch { try { c.terminate(); } catch { /* ignore */ } }
  }

  log("");
  log("── B1 · the cold path: pool, one sync ──");
  const b1c = await fresh();
  const b1 = await step(b1c, "B1 cold full pool", pool);
  await teardown(b1c);

  log("");
  log("── B2 · warm it first: an empty tag, sync, then the pool ──");
  const b2c = await fresh();
  const b2warm = await step(b2c, "B2 warm-up (empty tag)", [EMPTY_TAG]);
  const b2full = await step(b2c, "B2 full pool after warm-up", pool);
  await teardown(b2c);

  log("");
  log("── B3 · cold, then sync again ──");
  const b3c = await fresh();
  const b3first = await step(b3c, "B3 first sync", pool);
  const b3second = await step(b3c, "B3 second sync", []);
  await teardown(b3c);

  // ── verdict ───────────────────────────────────────────────────────────
  log("");
  log("── verdict ──");
  log("  cold one-shot sync        " + b1.syncMs + " ms   (" + b1.notes + " notes)");
  log("  warm-up + pool            " + (b2warm.syncMs + b2full.syncMs) + " ms   ("
    + b2warm.syncMs + " + " + b2full.syncMs + ", " + b2full.notes + " notes)");
  log("  cold sync, then again     " + b3first.syncMs + " ms, then " + b3second.syncMs + " ms");

  const cold = b1.syncMs;
  const warm = b2full.syncMs;
  const ratio = cold / Math.max(warm, 1);

  check("all three clients recovered every note",
    b1.notes === sent.length && b2full.notes === sent.length && b3first.notes === sent.length,
    b1.notes + " / " + b2full.notes + " / " + b3first.notes + " of " + sent.length);
  check("the cold first sync is far more expensive than a later one",
    ratio > 3,
    cold + " ms vs " + warm + " ms = " + ratio.toFixed(1) + "×");
  check("warming with an empty sync removes the penalty",
    b2warm.syncMs + b2full.syncMs < cold,
    (b2warm.syncMs + b2full.syncMs) + " ms total vs " + cold + " ms cold");
  check("a second sync on the same client is cheap",
    b3second.syncMs < b3first.syncMs / 3,
    b3second.syncMs + " ms vs " + b3first.syncMs + " ms");
  check("the cost is in sync(), not in notes.list()",
    b1.listMs < b1.syncMs / 3,
    "sync " + b1.syncMs + " ms, list " + b1.listMs + " ms");

  state.meta.result = {
    notes: sent.length,
    b1, b2warm, b2full, b3first, b3second,
    coldMs: cold, warmMs: warm, ratio: +ratio.toFixed(2),
    warmTotalMs: b2warm.syncMs + b2full.syncMs,
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
