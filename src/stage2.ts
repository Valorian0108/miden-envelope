// Stage 2 — the keyless observer, and the fix for G14.
//
// G14 was: every observer returned *at most one* note, whichever tags it
// tracked. Tracking the default tag alone found nothing, yet tracking it inside
// a pool found it. That is not a coherent filter, so the instrument was suspect.
//
// The leading hypothesis was a harness artifact: v2 built its custom-tag note by
// reusing the baseline note's `recipient()`, so both notes shared one serial
// number and therefore one nullifier. If the client dedupes by nullifier, the
// two collapse into one and which survives depends on ingestion order.
//
// This stage tests that hypothesis directly. Every note here is built with
// `NoteRecipient.fromScript(...)`, which the SDK documents as generating "a
// fresh random serial number". Five genuinely distinct private notes go out —
// three on the receiver's default tag, two on blinded tags — and observers count
// them.
//
// It also measures the thing G14 was blocking: what does *widening* the tag set
// actually pull in? Two public notes are planted under tags inside the
// receiver's pool but belonging to nobody in particular, so the junk count is a
// deliberate measurement rather than a coincidence of random account ids.
//
// Finally it separates the two channels. A chain-only observer tracking the full
// pool is run alongside the transport observers, because public notes arrive
// from the ledger and private note *contents* only from the relay — and a pool
// receiver has to filter junk from both.

import * as SDK from "@miden-sdk/miden-sdk";

const out = document.getElementById("out")!;
const lines: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const observers: Record<string, unknown> = {};
const state = {
  status: "running" as "running" | "pass" | "fail",
  lines,
  checks,
  observers,
  meta: {} as Record<string, unknown>,
};
(window as any).__STAGE2__ = state;

function log(s: string) {
  lines.push(s);
  out.textContent = lines.join("\n");
}
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  log((ok ? "   ok " : "  FAIL") + "  " + name + (detail ? "   " + detail : ""));
}
const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
const hex8 = (n: number) => "0x" + (n >>> 0).toString(16).padStart(8, "0");
const noteIdHex = (n: any) => {
  try {
    const id = n.id();
    return id?.toHex ? id.toHex() : String(id);
  } catch {
    return "?";
  }
};

/** Account ids are 15 bytes = 120 bits, rendered as 30 hex chars. */
function idBits(id: unknown): string {
  let s: string;
  const anyId = id as { toHex?: () => string; toString?: () => string };
  try {
    s = anyId.toHex ? anyId.toHex() : String(id);
  } catch {
    s = String(id);
  }
  s = s.replace(/^0x/, "").toLowerCase().padEnd(30, "0").slice(0, 30);
  let bin = "";
  for (const c of s) bin += parseInt(c, 16).toString(2).padStart(4, "0");
  return bin;
}
const idTopK = (id: unknown, k: number) => parseInt(idBits(id).slice(0, k), 2);

/** Reproducible RNG so a re-run produces the same tags. */
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x57a6e2);

const DEFAULT_TAG_LEN = 14;
const K = 7; // pool of 2^(14-7) = 128 tags — exactly the per-request ceiling

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

  log("stage 2 — the keyless observer");
  log("");

  // ── build the chain ────────────────────────────────────────────────────
  await wipeStores();
  const client = await MidenClient.createMock();
  log("sender client up in " + Math.round(performance.now() - t0) + " ms");

  const faucet = await client.accounts.create({
    type: FaucetType.FungibleFaucet,
    symbol: "TST",
    decimals: 6,
    maxSupply: 1_000_000_000n,
  });
  const alice = await client.accounts.create();
  const bob = await client.accounts.create();
  const carol = await client.accounts.create();

  // Carry hex strings across awaits — a client call can consume the handle it
  // is given, which is what produced v2's `null pointer passed to rust`.
  const ids = {
    faucet: faucet.id().toString(),
    alice: alice.id().toString(),
    bob: bob.id().toString(),
    carol: carol.id().toString(),
  };
  state.meta.ids = ids;
  log("  faucet " + ids.faucet);
  log("  alice  " + ids.alice + "   (sender)");
  log("  bob    " + ids.bob + "   (receiver)");
  log("  carol  " + ids.carol + "   (bystander)");

  await client.transactions.mint({
    account: ids.faucet, to: ids.alice, amount: 5000n, type: "public",
  });
  await client.proveBlock();
  await client.sync();
  await client.transactions.consumeAll({ account: ids.alice });
  await client.proveBlock();
  await client.sync();
  log("  alice funded: " + (await client.accounts.getBalance(ids.alice, ids.faucet)));

  // ── the tags under test ────────────────────────────────────────────────
  const defaultTag = NoteTag.withAccountTarget(AccountId.fromHex(ids.bob)).asU32() >>> 0;
  const aliceDefaultTag = NoteTag.withAccountTarget(AccountId.fromHex(ids.alice)).asU32() >>> 0;
  const fillBits = DEFAULT_TAG_LEN - K;
  const prefix = idTopK(ids.bob, K);
  const poolTags = Array.from({ length: 2 ** fillBits }, (_, i) =>
    ((((prefix << fillBits) | i) << 18) >>> 0));
  const otherPrefix = (prefix + 1) & ((1 << K) - 1);
  const wrongPoolTags = Array.from({ length: 2 ** fillBits }, (_, i) =>
    ((((otherPrefix << fillBits) | i) << 18) >>> 0));

  // Two blinded tags: random members of bob's own pool.
  const blindedTags: number[] = [];
  while (blindedTags.length < 2) {
    const t = poolTags[Math.floor(rand() * poolTags.length)];
    if (t !== defaultTag && !blindedTags.includes(t)) blindedTags.push(t);
  }
  // Two planted-junk tags: also inside bob's pool, but targeting nobody.
  const junkTags = poolTags
    .filter((t) => t !== defaultTag && !blindedTags.includes(t))
    .slice(0, 2);

  log("");
  log("tags");
  log("  bob default        " + hex8(defaultTag));
  log("  alice default      " + hex8(aliceDefaultTag) + (poolTags.includes(aliceDefaultTag) ? "   ← inside bob's pool" : "   (outside bob's pool)"));
  log("  blinded k=" + K + "        " + blindedTags.map(hex8).join(" "));
  log("  planted junk       " + junkTags.map(hex8).join(" "));
  log("  pool               " + poolTags.length + " tags " + hex8(poolTags[0]) + " … " + hex8(poolTags[poolTags.length - 1]));
  log("  control pool       " + wrongPoolTags.length + " tags " + hex8(wrongPoolTags[0]) + " … " + hex8(wrongPoolTags[wrongPoolTags.length - 1]));
  check("the default tag is inside its own pool", poolTags.includes(defaultTag));
  check("the blinded tags are inside the pool", blindedTags.every((t) => poolTags.includes(t)));
  check("the planted junk tags are inside the pool", junkTags.every((t) => poolTags.includes(t)));
  check("the control pool does not overlap", wrongPoolTags.every((t) => !poolTags.includes(t)));
  state.meta.tags = {
    defaultTag: hex8(defaultTag),
    aliceDefaultTag: hex8(aliceDefaultTag),
    aliceInsideBobPool: poolTags.includes(aliceDefaultTag),
    aliceSharesPrefix: idTopK(ids.alice, K) === prefix,
    blindedTags: blindedTags.map(hex8),
    junkTags: junkTags.map(hex8),
    poolSize: poolTags.length,
  };

  // ── notes ──────────────────────────────────────────────────────────────
  //
  // The G14 fix lives in `build`. v2 reused `base.recipient()`; this calls
  // NoteRecipient.fromScript(), which draws a fresh random serial, so every
  // note has its own nullifier and nothing can collapse under dedup.
  function build(fromHex: string, toHex: string, amount: bigint, tagU32: number, priv: boolean) {
    const base = createP2IDNote({
      from: fromHex,
      to: toHex,
      assets: [{ token: ids.faucet, amount }],
      type: priv ? "private" : "public",
    });
    const br = base.recipient();
    const fresh = NoteRecipient.fromScript(br.script(), br.storage());
    const md = new NoteMetadata(
      AccountId.fromHex(fromHex),
      priv ? NoteType.Private : NoteType.Public,
      new NoteTag(tagU32),
    );
    const note = Note.withAttachments(base.assets(), md, fresh, base.attachments());
    const got = note.metadata().tag().asU32() >>> 0;
    if (got !== tagU32) throw new Error("tag did not survive withAttachments: " + hex8(got));
    return {
      note,
      id: note.id().toHex ? note.id().toHex() : String(note.id()),
      serial: "0x" + wordToBigInt(fresh.serialNum()).toString(16),
    };
  }

  async function emit(fromHex: string, built: { note: any; id: string; serial: string }, relay: boolean) {
    const builder = await client.feeAwareTransactionRequestBuilder(fromHex);
    const request = builder.withOwnOutputNotes(new NoteArray([built.note])).build();
    await client.transactions.submit(fromHex, request);
    await client.proveBlock();
    await client.sync();
    if (relay) {
      try {
        await client.notes.sendPrivateOutput({ noteId: built.id as any, to: ids.bob });
      } catch (e) {
        log("    relay note: " + E(e));
      }
    }
  }

  const plan: { label: string; tag: number; amount: bigint; priv: boolean }[] = [
    { label: "default#1", tag: defaultTag, amount: 101n, priv: true },
    { label: "default#2", tag: defaultTag, amount: 102n, priv: true },
    { label: "default#3", tag: defaultTag, amount: 103n, priv: true },
    { label: "blinded#1", tag: blindedTags[0], amount: 201n, priv: true },
    { label: "blinded#2", tag: blindedTags[1], amount: 202n, priv: true },
    { label: "junk#1", tag: junkTags[0], amount: 300n, priv: false },
    { label: "junk#2", tag: junkTags[1], amount: 301n, priv: false },
  ];

  log("");
  log("building " + plan.length + " notes, each with a fresh serial");
  const sent: { label: string; tag: number; amount: bigint; priv: boolean; id: string; serial: string }[] = [];
  for (const p of plan) {
    // The junk notes go to carol, so they are unambiguously somebody else's mail.
    const to = p.priv ? ids.bob : ids.carol;
    const built = build(ids.alice, to, p.amount, p.tag, p.priv);
    await emit(ids.alice, built, p.priv);
    sent.push({ ...p, id: built.id, serial: built.serial });
    log("  " + p.label.padEnd(10) + (p.priv ? "private" : "public ") + "  tag " + hex8(p.tag) + "  amount " + p.amount + "  id " + built.id.slice(0, 18) + "…");
  }

  check("every note got a distinct serial", new Set(sent.map((n) => n.serial)).size === sent.length, new Set(sent.map((n) => n.serial)).size + " unique");
  check("every note got a distinct id", new Set(sent.map((n) => n.id)).size === sent.length);
  state.meta.sent = sent.map((n) => ({
    label: n.label, priv: n.priv, tag: hex8(n.tag), amount: n.amount.toString(), id: n.id,
  }));

  const outNotes = await client.notes.listSent();
  const outIds = new Set(outNotes.map(noteIdHex));
  log("");
  log("sender's output notes: " + outNotes.length + " (includes the mint note)");
  check("the sender recorded all seven notes", sent.every((n) => outIds.has(n.id)), outIds.size + " total output notes");

  // ── snapshot, then release the sender so the store can be wiped ────────
  const chainBlob = await client.serializeMockChain();
  const transportBlob = await client.serializeMockNoteTransportNode();
  log("");
  log("snapshot: chain " + chainBlob.length + " bytes, transport " + transportBlob.length + " bytes");
  state.meta.snapshot = { chain: chainBlob.length, transport: transportBlob.length };

  try { await (client as any)[Symbol.asyncDispose](); } catch { try { client.terminate(); } catch { /* ignore */ } }

  // ── keyless observers ──────────────────────────────────────────────────
  type Row = { id: string; tag: string; type: number; sender: string; amount: string };

  async function observe(
    label: string,
    tagsToTrack: number[],
    withTransport: boolean,
  ): Promise<{ label: string; tags: number; transport: boolean; count: number; rows: Row[] }> {
    await wipeStores();
    const opts: Record<string, unknown> = { serializedMockChain: chainBlob };
    if (withTransport) opts.serializedNoteTransport = transportBlob;
    const c = await MidenClient.createMock(opts);

    for (const t of tagsToTrack) await c.tags.add(t);
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
    log("  tracks " + tagsToTrack.length + " tag(s), " + (withTransport ? "chain + transport" : "chain only"));
    log("  synced " + before + " → " + after + "   found " + rows.length + " note(s)");
    for (const r of rows) {
      log("    · " + r.id.slice(0, 16) + "…  tag " + r.tag + "  " + (r.type === 0 ? "private" : r.type === 1 ? "public " : "type " + r.type) + "  amount " + r.amount + "  from " + r.sender.slice(0, 12) + "…");
    }

    try { await (c as any)[Symbol.asyncDispose](); } catch { try { c.terminate(); } catch { /* ignore */ } }
    return { label, tags: tagsToTrack.length, transport: withTransport, count: rows.length, rows };
  }

  const O1 = await observe("O1 chain only · the three tags used", [defaultTag, ...blindedTags], false);
  const O2 = await observe("O2 transport · bob's default tag alone", [defaultTag], true);
  const O3 = await observe("O3 transport · one blinded tag", [blindedTags[0]], true);
  const O4 = await observe("O4 transport · bob's full 128-tag pool", poolTags, true);
  const O5 = await observe("O5 transport · a wrong 128-tag pool", wrongPoolTags, true);
  const O6 = await observe("O6 transport · default + both blinded (the v2 case)", [defaultTag, ...blindedTags], true);
  const O7 = await observe("O7 chain only · bob's full 128-tag pool", poolTags, false);

  Object.assign(observers, { O1, O2, O3, O4, O5, O6, O7 });

  // ── verdict ────────────────────────────────────────────────────────────
  // "Target" = the five private notes actually meant for bob. Everything else
  // a pool observer collects is junk, and counting it is the measurement.
  const isTarget = (r: Row) =>
    r.type === 0 && r.sender.toLowerCase() === ids.alice.toLowerCase() &&
    sent.some((n) => n.priv && n.id === r.id);

  const target = O4.rows.filter(isTarget);
  const junk = O4.rows.filter((r) => !isTarget(r));

  log("");
  log("── verdict ──");
  check("O1 chain-only sees nothing", O1.count === 0, "got " + O1.count);
  check("O2 default tag alone sees all three", O2.count === 3, "got " + O2.count);
  check("O3 one blinded tag sees exactly one", O3.count === 1, "got " + O3.count);
  check("O5 a wrong pool sees nothing", O5.count === 0, "got " + O5.count);
  check("O6 mixed set sees all five", O6.count === 5, "got " + O6.count);

  check(
    "G14 closed — counting is not capped at one",
    O2.count > 1 && O6.count > 1,
    "O2=" + O2.count + " O6=" + O6.count + " (v2 returned at most 1)"
  );

  check("O4 pool finds all five target private notes", target.length === 5, "got " + target.length);
  check(
    "O4 reads every target amount in full",
    JSON.stringify(target.map((r) => r.amount).sort()) === JSON.stringify(["101", "102", "103", "201", "202"]),
    target.map((r) => r.amount).sort().join(",")
  );
  check("O4's note ids are all distinct", new Set(O4.rows.map((r) => r.id)).size === O4.count, O4.count + " unique");

  const o7Private = O7.rows.filter((r) => r.type === 0);
  check("O7 chain-only pool finds no private note", o7Private.length === 0, "got " + o7Private.length);
  check(
    "O7 chain-only pool still finds the planted public notes",
    junkTags.every((t) => O7.rows.some((r) => r.tag === hex8(t))),
    O7.count + " public note(s)"
  );

  // ── the junk measurement ───────────────────────────────────────────────
  log("");
  log("── what widening the pool pulls in ──");
  log("  1 tag   → " + O2.count + " note(s)");
  log("  128 tags → " + O4.count + " note(s): " + target.length + " intended, " + junk.length + " not");
  for (const j of junk) {
    const who = j.sender.toLowerCase() === ids.alice.toLowerCase() ? "alice"
      : j.sender.toLowerCase() === ids.faucet.toLowerCase() ? "faucet" : "unknown";
    log("    · tag " + j.tag + "  " + (j.type === 1 ? "public" : "type " + j.type) + "  amount " + j.amount + "  from " + who);
  }
  if (state.meta.tags.aliceInsideBobPool) {
    log("  mechanism: alice's id " + ids.alice.slice(0, 8) + "… and bob's " + ids.bob.slice(0, 8) + "… share the top " + K + " bits,");
    log("             so alice's own default tag " + hex8(aliceDefaultTag) + " is a member of bob's pool.");
  }
  check(
    "the planted junk reached the pool receiver",
    junkTags.every((t) => junk.some((r) => r.tag === hex8(t))),
    junk.length + " junk note(s) of " + junkTags.length + " planted"
  );
  state.meta.junk = {
    count: junk.length,
    rows: junk,
    plantedTagsFound: junkTags.filter((t) => junk.some((r) => r.tag === hex8(t))).length,
    planted: junkTags.length,
  };

  log("");
  log("done in " + Math.round(performance.now() - t0) + " ms");
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    log("PASS — counting is coherent, and the pool volume is measured");
    state.status = "pass";
  } else {
    log("FAILED " + failed.length + " check(s): " + failed.map((c) => c.name).join(" | "));
    state.status = "fail";
  }
}

main().catch((e) => {
  log("");
  log("FAIL: " + E(e));
  log(String((e as Error)?.stack ?? "").split("\n").slice(1, 4).join(" | "));
  state.status = "fail";
});
