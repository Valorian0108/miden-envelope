// Stage 4 — the send path becomes one call, and the blinding gets measured.
//
// Stages 1–3 built the pieces: a mock chain that settles, a keyless observer that
// can read a private note if it names the right tag, and the tag arithmetic as
// library code validated against the SDK. What was never tested is the claim the
// whole project rests on:
//
//   sending through the library makes a payment invisible to someone who knows
//   the receiver's name.
//
// So this page sends twenty payments to the same receiver. Ten go through
// `sendEnvelope` (blinded: a random tag from the receiver's 128-tag pool). Ten go
// through a plain `createP2IDNote` with no intervention at all (the receiver's own
// default tag, which is what any existing Miden wallet will use). Then the client
// is destroyed, the stores are wiped, and fresh keyless observers are pointed at
// the serialised chain.
//
// Two things are being checked, and they are different:
//
//   1. Does the API work? All twenty arrive, every serial is distinct, every
//      blinded tag is inside the pool.
//   2. Does the property hold? A spy tracking only the receiver's *default* tag
//      recovers the ten naive payments and none of the ten blinded ones. An
//      observer tracking the whole pool recovers all twenty — which is what
//      makes the first result a privacy gain rather than a delivery failure.
//
// The single most load-bearing check here is that the relay did not undo the
// blinding. `notes.sendPrivateOutput({noteId, to})` is given the receiver's
// account id, so if it recomputed a tag from `to` the blinded notes would land
// back on the default tag and the scheme would be theatre. Stage 2's O3 implied
// it does not; this asserts it head-on.

import * as SDK from "@miden-sdk/miden-sdk";
import * as T from "./envelope/tags";
import * as S from "./envelope/send";

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
(window as any).__STAGE4__ = state;

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

const BLINDED = 10;
const LEGACY = 10;
const K = 7;

/** Reproducible RNG so a re-run draws the same tags. */
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

/**
 * Every mock client shares one IndexedDB store. Without a wipe a "fresh
 * observer" inherits the sender's synced notes and measures nothing.
 */
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
    MidenClient, FaucetType, NoteTag, NoteType, Note, NoteMetadata,
    NoteArray, NoteRecipient, AccountId, createP2IDNote, wordToBigInt,
  } = SDK as any;
  for (const [name, v] of Object.entries({
    MidenClient, FaucetType, NoteTag, NoteType, Note, NoteMetadata,
    NoteArray, NoteRecipient, AccountId, createP2IDNote, wordToBigInt,
  })) {
    if (!v) throw new Error("SDK does not export " + name);
  }

  log("stage 4 — one call to send, and what a spy recovers");
  log("");
  mark("boot");

  // ── a chain, one sender, one receiver ──────────────────────────────────
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
  log("  alice  " + ids.alice + "   (sender)");
  log("  bob    " + ids.bob + "   (receiver)");
  mark("accounts");

  await client.transactions.mint({
    account: ids.faucet, to: ids.alice, amount: 1_000_000n, type: "public",
  });
  await client.proveBlock();
  await client.sync();
  await client.transactions.consumeAll({ account: ids.alice });
  await client.proveBlock();
  await client.sync();
  const funded = await client.accounts.getBalance(ids.alice, ids.faucet);
  log("  alice funded: " + funded);
  check("sender is funded", BigInt(String(funded)) > 0n, String(funded));
  mark("funding");

  // ── the tags in play ──────────────────────────────────────────────────
  const defaultTag = T.defaultTag(ids.bob);
  const pool = T.poolFor(ids.bob, K);
  const aliceDefaultTag = T.defaultTag(ids.alice);
  log("");
  log("  bob's default tag  " + hex8(defaultTag) + "   ← what a plain SDK send uses");
  log("  bob's pool         " + pool.length + " tags  " + hex8(pool[0]) + " … " + hex8(pool[pool.length - 1]));
  log("  alice's own tag    " + hex8(aliceDefaultTag) + (pool.includes(aliceDefaultTag) ? "   ← inside bob's pool" : "   (outside bob's pool)"));
  check("the default tag is a member of the pool", pool.includes(defaultTag));
  check("the pool is 2^" + (14 - K) + " = 128 tags", pool.length === 128, String(pool.length));
  state.meta.tags = {
    defaultTag: hex8(defaultTag),
    poolSize: pool.length,
    poolFirst: hex8(pool[0]),
    poolLast: hex8(pool[pool.length - 1]),
  };

  // ── ten payments through the library ──────────────────────────────────
  log("");
  log("── " + BLINDED + " payments through sendEnvelope ──");
  const rng = mulberry32(0x5eed_0004);
  const blinded: { noteId: string; tag: number; serial: string; amount: string; ms: number }[] = [];
  for (let i = 0; i < BLINDED; i++) {
    const amount = BigInt(100 + i);
    const r = await S.sendEnvelope({
      client,
      from: ids.alice,
      to: ids.bob,
      assets: [{ token: ids.faucet, amount }],
      k: K,
      rng,
    });
    blinded.push({ noteId: r.noteId, tag: r.tag, serial: r.serial, amount: String(amount), ms: Math.round(r.ms) });
    log(
      "  " + String(i + 1).padStart(2) + "  tag " + hex8(r.tag) + "  " +
      String(amount).padStart(4) + "  " + r.noteId.slice(0, 18) + "…  " +
      Math.round(r.ms) + " ms" + (r.relayed ? "" : "  RELAY FAILED"),
    );
  }
  mark("blinded");

  // ── ten payments the way a normal wallet sends ─────────────────────────
  log("");
  log("── " + LEGACY + " payments through plain createP2IDNote ──");
  const legacy: { noteId: string; tag: number; amount: string }[] = [];
  for (let i = 0; i < LEGACY; i++) {
    const amount = BigInt(200 + i);
    const note = createP2IDNote({
      from: ids.alice,
      to: ids.bob,
      assets: [{ token: ids.faucet, amount }],
      type: "private",
    });
    // Read the tag the SDK chose, before submit can consume the handle.
    const tagUsed = note.metadata().tag().asU32() >>> 0;
    const nid = noteIdHex(note);
    const builder = await client.feeAwareTransactionRequestBuilder(ids.alice);
    const request = builder.withOwnOutputNotes(new NoteArray([note])).build();
    await client.transactions.submit(ids.alice, request);
    await client.proveBlock();
    await client.sync();
    try {
      await client.notes.sendPrivateOutput({ noteId: nid as any, to: ids.bob });
    } catch (e) {
      log("    relay note: " + E(e));
    }
    legacy.push({ noteId: nid, tag: tagUsed, amount: String(amount) });
    log(
      "  " + String(i + 1).padStart(2) + "  tag " + hex8(tagUsed) + "  " +
      String(amount).padStart(4) + "  " + nid.slice(0, 18) + "…",
    );
  }
  mark("legacy");

  // ── what the send side can prove on its own ───────────────────────────
  log("");
  log("── the send side ──");
  check(
    "every blinded note drew a distinct serial",
    new Set(blinded.map((b) => b.serial)).size === BLINDED,
    new Set(blinded.map((b) => b.serial)).size + " unique of " + BLINDED,
  );
  check(
    "every blinded note got a distinct id",
    new Set(blinded.map((b) => b.noteId)).size === BLINDED,
  );
  check(
    "every blinded tag is inside bob's pool",
    blinded.every((b) => pool.includes(b.tag)),
  );
  const landedOnDefault = blinded.filter((b) => b.tag === defaultTag).length;
  check(
    "no blinded note landed on the default tag",
    landedOnDefault === 0,
    landedOnDefault + " of " + BLINDED + " (expected 0, chance was " + (BLINDED / 128).toFixed(3) + ")",
  );
  const distinctTags = new Set(blinded.map((b) => b.tag)).size;
  check(
    "the blinded notes spread across many tags",
    distinctTags >= 8,
    distinctTags + " distinct tags for " + BLINDED + " notes",
  );
  check(
    "the plain SDK path used bob's default tag every time",
    legacy.every((l) => l.tag === defaultTag),
    new Set(legacy.map((l) => hex8(l.tag))).size + " distinct tag(s) across " + LEGACY + " notes",
  );

  const sendMs = blinded.reduce((a, b) => a + b.ms, 0) / blinded.length;
  log("  mean sendEnvelope latency " + Math.round(sendMs) + " ms/note (includes settle + relay)");
  state.meta.send = {
    blindedMsMean: Math.round(sendMs),
    distinctTags,
    landedOnDefault,
    serials: new Set(blinded.map((b) => b.serial)).size,
  };

  // ── snapshot, then release the sender so the store can be wiped ────────
  const chainBlob = await client.serializeMockChain();
  const transportBlob = await client.serializeMockNoteTransportNode();
  log("");
  log("  snapshot: chain " + chainBlob.length + " bytes, transport " + transportBlob.length + " bytes");
  try { await (client as any)[Symbol.asyncDispose](); } catch { try { client.terminate(); } catch { /* ignore */ } }
  mark("snapshot");

  // ── keyless observers ─────────────────────────────────────────────────
  type Row = { id: string; tag: string; type: number; sender: string; amount: string };

  async function observe(
    label: string,
    tagsToTrack: number[],
    withTransport: boolean,
  ): Promise<{ label: string; tags: number; transport: boolean; count: number; rows: Row[]; addMs: number }> {
    await wipeStores();
    const opts: Record<string, unknown> = { serializedMockChain: chainBlob };
    if (withTransport) opts.serializedNoteTransport = transportBlob;
    const c = await MidenClient.createMock(opts);

    const addStart = performance.now();
    for (const t of tagsToTrack) await c.tags.add(t);
    const addMs = performance.now() - addStart;

    const before = await c.getSyncHeight();
    await c.sync();
    const after = await c.getSyncHeight();

    const listed = await c.notes.list();
    const rows: Row[] = listed.map((n0: any) => {
      const r: Row = { id: noteIdHex(n0), tag: "?", type: -1, sender: "?", amount: "?" };
      try {
        const m = n0.metadata();
        r.tag = hex8(m.tag().asU32());
        r.type = m.noteType();
        r.sender = String(m.sender());
      } catch { /* keep ? */ }
      try {
        const fa = n0.details().assets().fungibleAssets();
        r.amount = fa.map((a: any) => String(a.amount())).join("+") || "none";
      } catch { /* keep ? */ }
      return r;
    });

    log("");
    log("── " + label + " ──");
    log("  tracks " + tagsToTrack.length + " tag(s), " + (withTransport ? "chain + transport" : "chain only") +
        "   registration " + Math.round(addMs) + " ms");
    log("  synced " + before + " → " + after + "   found " + rows.length + " note(s)");
    for (const r of rows) {
      log(
        "    · " + r.id.slice(0, 16) + "…  tag " + r.tag + "  " +
        (r.type === 0 ? "private" : r.type === 1 ? "public " : "type " + r.type) +
        "  amount " + r.amount + "  from " + r.sender.slice(0, 14) + "…",
      );
    }

    try { await (c as any)[Symbol.asyncDispose](); } catch { try { c.terminate(); } catch { /* ignore */ } }
    return { label, tags: tagsToTrack.length, transport: withTransport, count: rows.length, rows, addMs };
  }

  const A1 = await observe("A1 the spy · bob's default tag only", [defaultTag], true);
  const A2 = await observe("A2 the receiver · bob's full 128-tag pool", pool, true);
  const A3 = await observe("A3 control · alice's own tag", [aliceDefaultTag], true);
  const A4 = await observe("A4 chain only · the full pool, no transport", pool, false);
  const A5 = await observe("A5 chain only · alice's own tag", [aliceDefaultTag], false);
  Object.assign((state as any), { observers: { A1, A2, A3, A4, A5 } });
  mark("observers");

  // ── verdict ───────────────────────────────────────────────────────────
  const blindedIds = new Set(blinded.map((b) => b.noteId));
  const legacyIds = new Set(legacy.map((l) => l.noteId));
  const pick = (rows: Row[], set: Set<string>) => rows.filter((r) => set.has(r.id));

  const spyBlinded = pick(A1.rows, blindedIds);
  const spyLegacy = pick(A1.rows, legacyIds);
  const poolBlinded = pick(A2.rows, blindedIds);
  const poolLegacy = pick(A2.rows, legacyIds);

  log("");
  log("── verdict ──");
  log("  spy  (default tag only):  " + spyLegacy.length + "/" + LEGACY + " naive, " +
      spyBlinded.length + "/" + BLINDED + " blinded   = " + A1.count + " of 20");
  log("  recv (full pool):         " + poolLegacy.length + "/" + LEGACY + " naive, " +
      poolBlinded.length + "/" + BLINDED + " blinded   = " + A2.count + " of 20");

  check("A1 recovers every naive payment", spyLegacy.length === LEGACY, spyLegacy.length + " of " + LEGACY);
  check(
    "A1 recovers (almost) no blinded payment",
    spyBlinded.length <= 1,
    spyBlinded.length + " of " + BLINDED + " — chance alone predicts " + (BLINDED / 128).toFixed(3),
  );
  check(
    "A2 recovers all twenty",
    poolBlinded.length === BLINDED && poolLegacy.length === LEGACY,
    poolBlinded.length + " blinded + " + poolLegacy.length + " naive",
  );
  check(
    "the relay files under the note's own tag, not the receiver's default",
    spyBlinded.length <= 1 && spyLegacy.length === LEGACY,
    "if sendPrivateOutput recomputed from `to`, A1 would have seen all 20",
  );
  check("A3 the sender's own tag carries none of the payments", pick(A3.rows, new Set([...blindedIds, ...legacyIds])).length === 0,
    A3.count + " unrelated note(s) visible, e.g. the public mint");
  check("A4 private notes are not on chain at all", A4.count === 0, "got " + A4.count);
  check("A5 a public note is on chain and tag-filtered", A5.count === 1, "got " + A5.count);

  // Attribution: the one thing blinding must not be said to hide.
  const senders = new Set(A2.rows.map((r) => r.sender.toLowerCase().replace(/^0x/, "")));
  const aliceNorm = T.normalizeId(ids.alice);
  check(
    "every recovered note still names the sender in full",
    senders.size === 1 && senders.has(aliceNorm),
    Array.from(senders).map((s) => s.slice(0, 12) + "…").join(", "),
  );

  check(
    "A2 reads every blinded amount in full",
    poolBlinded.map((r) => r.amount).sort().join(",") ===
      blinded.map((b) => b.amount).sort().join(","),
    poolBlinded.length + " amounts",
  );
  check(
    "A2 registered the whole 128-tag pool without complaint",
    A2.addMs >= 0 && A2.tags === 128,
    Math.round(A2.addMs) + " ms for " + A2.tags + " tags (" + (A2.addMs / 128).toFixed(1) + " ms/tag)",
  );

  // The metric the demo's spy character is wired to: of the payments that used
  // the library, what fraction can a spy who knows the receiver's name recover?
  const spyRate = spyBlinded.length / BLINDED;
  const recvRate = poolBlinded.length / BLINDED;
  log("");
  log("  reconstruction rate for library payments:");
  log("    spy with the default tag   " + (spyRate * 100).toFixed(1) + "%   (1/128 = " + (100 / 128).toFixed(1) + "%)");
  log("    receiver with the pool     " + (recvRate * 100).toFixed(1) + "%");
  log("  total run " + Math.round(performance.now() - t0) + " ms");

  state.meta.metric = {
    blinded: BLINDED,
    spyRecovered: spyBlinded.length,
    spyRate,
    poolRecovered: poolBlinded.length,
    poolRate: recvRate,
    naiveRecovered: spyLegacy.length,
    registrationMs: { defaultOnly: Math.round(A1.addMs), fullPool: Math.round(A2.addMs) },
  };
  (state.phases as any).total = Math.round(performance.now() - t0);

  const failed = checks.filter((c) => !c.ok);
  state.status = failed.length === 0 ? "pass" : "fail";
  log("");
  log(failed.length === 0
    ? "PASS — " + checks.length + "/" + checks.length + " checks"
    : "FAIL — " + failed.length + " of " + checks.length + " checks failed");
}

main().catch((e) => {
  log("");
  log("ERROR " + E(e));
  log(String((e as Error)?.stack ?? "").split("\n").slice(0, 6).join("\n"));
  state.status = "fail";
});
