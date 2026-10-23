// miden-envelope · harness v2
//
// v1 established the tag algebra. v2 tests whether it survives contact with a
// chain, and answers the two questions the whole library rests on:
//
//   A  tag algebra, verified against an explicit model rather than eyeballed
//      A1  is the DEFAULT tag exactly tag_len = 14?
//      A2  is the model `tag = top-k bits of account id, left-aligned`?
//      A3  how many tags may a receiver subscribe to? (sizes the dial)
//      A4  can a coarse tag be random-filled so it is indistinguishable from
//          a default tag? — the construction the library is built on
//
//   B  put a custom-tag private note on the mock chain
//
//   C  what do fresh observers, holding no keys, actually see?
//      C1  chain only            — the public ledger
//      C2  chain + transport, listening on the CUSTOM tag
//      C3  chain + transport, listening on the receiver's DEFAULT tag
//      C2 vs C3 decides whether private-note discovery routes by note tag or
//      by recipient. If C3 finds it and C2 does not, the tag pool is dead for
//      private notes and the design has to change.
//
// Everything is measured. Each phase is guarded so a later failure cannot hide
// an earlier result.

import * as SDK from "@miden-sdk/miden-sdk";

const out = document.getElementById("out")!;
const lines: { cls: string; text: string }[] = [];

function render() {
  out.innerHTML = lines
    .map((l) => `<span class="${l.cls}">${esc(l.text)}</span>`)
    .join("\n");
}
function emit(cls: string, text: string) {
  lines.push({ cls, text });
  render();
}
const log = (t: string) => emit("", t);
const hdr = (t: string) => emit("hdr", `\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const ok = (t: string) => emit("ok", `  ✓ ${t}`);
const warn = (t: string) => emit("warn", `  ! ${t}`);
const bad = (t: string) => emit("err", `  ✗ ${t}`);
const dim = (t: string) => emit("dim", `    ${t}`);

function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 220);

function show(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
  try {
    const s = String(v);
    return s === "[object Object]" ? `{${Object.keys(v).slice(0, 6).join(",")}}` : s.slice(0, 80);
  } catch {
    return "<unprintable>";
  }
}

/** Method names on an object and its prototype chain. */
function surface(o: unknown): string[] {
  const names = new Set<string>();
  let cur = o as object | null;
  while (cur && cur !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      try {
        if (typeof (o as Record<string, unknown>)[k] === "function") names.add(k);
      } catch {
        /* throwing getter */
      }
    }
    cur = Object.getPrototypeOf(cur);
  }
  return [...names].sort();
}

/** Read a field without ever throwing — reports the failure inline. */
function read(label: string, fn: () => unknown): { value: unknown; err?: string } {
  try {
    const value = fn();
    dim(`${label} = ${show(value)}`);
    return { value };
  } catch (e) {
    dim(`${label} → THREW: ${E(e)}`);
    return { value: undefined, err: E(e) };
  }
}

const hex8 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
const bits32 = (n: number) => (n >>> 0).toString(2).padStart(32, "0");

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
const rand = mulberry32(0xc0ffee);

/** Account ids are 15 bytes = 120 bits, rendered as 30 hex chars. */
function idBits(id: unknown): string {
  let s = "";
  const anyId = id as { toHex?: () => string; toString?: () => string };
  try {
    s = anyId.toHex ? anyId.toHex() : String(id);
  } catch {
    s = String(id);
  }
  s = s.replace(/^0x/, "").toLowerCase().padEnd(30, "0").slice(0, 30);
  let bin = "";
  for (const c of s) bin += parseInt(c, 16).toString(2).padStart(4, "0");
  return bin; // 120 chars
}
/** Top k bits of an account id, as a number (k <= 32). */
const idTopK = (id: unknown, k: number) => parseInt(idBits(id).slice(0, k), 2);

const DEFAULT_TAG_LEN = 14;
const N_ACCOUNTS = 24;
const LOW18 = 0x3ffff;

/**
 * The mock chain is a fresh in-memory chain on every page load, but the
 * IndexedDB store survives reloads. A store that synced a previous run's chain
 * to block N meets a new chain at block 1 and the WASM panics with
 * `ForestOutOfBounds`, which poisons the instance and leaves every later
 * promise unsettled. Wipe first so each run starts clean.
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
            req.onsuccess = () => {
              deleted.push(d.name!);
              resolve();
            };
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          }),
      ),
    );
  } catch (e) {
    deleted.push(`<databases() unavailable: ${E(e)}>`);
  }
  return deleted;
}

/** The library's core construction: a coarse tag, random-filled to look default. */
function blindedTag(id: unknown, k: number): { tag: number; poolSize: number } {
  const topK = idTopK(id, k);
  const fillBits = DEFAULT_TAG_LEN - k;
  const fill = Math.floor(rand() * 2 ** fillBits);
  const payload14 = (topK << fillBits) | fill;
  return { tag: (payload14 << 18) >>> 0, poolSize: 2 ** fillBits };
}

async function main() {
  const R: Record<string, unknown> = {};
  (window as any).__HARNESS__ = { done: false, results: R };

  const {
    MidenClient, NoteTag, NoteType, NoteVisibility, FaucetType,
    Note, NoteMetadata, NoteArray, NoteInclusionProof,
  } = SDK as any;

  const wiped = await wipeStores();
  dim(`cleared ${wiped.length} stale IndexedDB store(s)${wiped.length ? ": " + wiped.slice(0, 4).join(", ") : ""}`);

  const client = await MidenClient.createMock({ seed: "envelope-v2" });
  ok(`mock client up (usesMockChain=${client.usesMockChain()})`);
  // ── Phase A · tag algebra ──────────────────────────────────────────────
  hdr("Phase A · tag algebra against an explicit model");

  const ids: any[] = [];
  for (let i = 0; i < N_ACCOUNTS; i++) ids.push((await client.accounts.create()).id());
  ok(`${ids.length} account ids generated`);
  dim(`id[0] = ${show(ids[0])}  (${idBits(ids[0]).length} bits)`);

  // A1 — is the default tag exactly tag_len 14?
  log("\n  [A1] is withAccountTarget(id) identical to withCustomAccountTarget(id, 14)?");
  let a1Match = 0;
  const a1Sample: string[] = [];
  for (const id of ids) {
    const d = NoteTag.withAccountTarget(id).asU32() >>> 0;
    const c = NoteTag.withCustomAccountTarget(id, DEFAULT_TAG_LEN).asU32() >>> 0;
    if (d === c) a1Match++;
    if (a1Sample.length < 3) a1Sample.push(`default ${hex8(d)}  len14 ${hex8(c)}`);
  }
  if (a1Match === ids.length) ok(`${a1Match}/${ids.length} identical → the DEFAULT tag length is 14 bits`);
  else warn(`only ${a1Match}/${ids.length} identical → default is NOT tag_len 14`);
  a1Sample.forEach(dim);
  R.A1_defaultIsLen14 = { match: a1Match, of: ids.length };

  // A2 — verify the model: tag = top-k bits of the id, left-aligned in the u32
  log("\n  [A2] model: tag(id,k) == top-k bits of id, left-aligned in 32 bits");
  const a2: { k: number; match: number; of: number }[] = [];
  for (let k = 1; k <= DEFAULT_TAG_LEN; k++) {
    let match = 0;
    for (const id of ids) {
      const actual = NoteTag.withCustomAccountTarget(id, k).asU32() >>> 0;
      const predicted = k === 32 ? idTopK(id, k) >>> 0 : (idTopK(id, k) << (32 - k)) >>> 0;
      if (actual === predicted) match++;
    }
    a2.push({ k, match, of: ids.length });
    const flag = match === ids.length ? "ok" : match === 0 ? "err" : "warn";
    emit(flag, `       k=${String(k).padStart(2)}  ${match}/${ids.length} predicted correctly`);
  }
  const a2All = a2.every((r) => r.match === r.of);
  if (a2All) ok("model holds for every k in 1..14 → tag length IS the anonymity dial");
  else bad("model does not hold — see per-k mismatches above");
  R.A2_model = a2;
  R.A2_modelHolds = a2All;

  // A3 — how many tags can a receiver subscribe to?
  log("\n  [A3] receiver-side limit: how many tags can one client track?");
  let baseline: number[] = [];
  try {
    baseline = await client.tags.list();
    dim(`tags already tracked (auto-registered at account creation): ${baseline.length}`);
  } catch (e) {
    bad(`tags.list threw: ${E(e)}`);
  }
  let added = 0;
  let limitErr: string | null = null;
  // The note-transport design doc caps `FetchNotesRequest.tags` at 128, so that
  // is the protocol ceiling per fetch. Probe past it to see whether the *client*
  // also refuses. Capped at 160 to keep later syncs cheap.
  const CAP = 160;
  const probe: number[] = [];
  for (let i = 0; i < CAP; i++) {
    // distinct, default-shaped tags that no real account here would use
    const t = (((i + 1) & 0x3fff) << 18) >>> 0;
    try {
      await client.tags.add(t);
      probe.push(t);
      added++;
    } catch (e) {
      limitErr = E(e);
      break;
    }
  }
  const total = (await client.tags.list()).length;
  if (limitErr) {
    warn(`client refused after ${added} tags (total tracked ${total})`);
    dim(`error: ${limitErr}`);
  } else {
    ok(`client accepted ${added} tags (total tracked ${total}) — no CLIENT ceiling at ${CAP}`);
    dim("but FetchNotesRequest carries at most 128 tags, so 128 is the real bound");
  }
  // Unsubscribe again: 160 junk tags would be re-scanned on every later sync.
  let removed = 0;
  for (const t of probe) {
    try {
      await client.tags.remove(t);
      removed++;
    } catch {
      /* ignore */
    }
  }
  dim(`unsubscribed ${removed} probe tags; now tracking ${(await client.tags.list()).length}`);
  R.A3_tagLimit = { baseline: baseline.length, added, total, limitErr, removed };

  // A4 — the construction: coarse + random-filled = default-shaped
  log("\n  [A4] blinded tag: coarse prefix + random fill, is it default-shaped?");
  const target = ids[0];
  const a4: { k: number; tag: string; low18zero: boolean; topKok: boolean; pool: number }[] = [];
  for (const k of [4, 6, 7, 8, 10, 12, 14]) {
    const { tag, poolSize } = blindedTag(target, k);
    const low18zero = (tag & LOW18) === 0;
    const topKok = idBits(target).slice(0, k) === bits32(tag).slice(0, k);
    a4.push({ k, tag: hex8(tag), low18zero, topKok, pool: poolSize });
    const cls = low18zero && topKok ? "ok" : "err";
    emit(cls, `       k=${String(k).padStart(2)}  ${hex8(tag)}  low18zero=${low18zero}  topK=${topKok}  receiver must track ${poolSize} tags`);
  }
  const a4ok = a4.every((r) => r.low18zero && r.topKok);
  if (a4ok) ok("every blinded tag is a legal default-shaped tag carrying only k bits of the receiver");
  else bad("blinded tag construction is wrong");
  R.A4_blinded = a4;
  R.A4_ok = a4ok;

  // uniformity: does a population of blinded tags look like a population of default tags?
  log("\n       uniformity check — blinded(k=7) vs default, over all accounts");
  for (const k of [7, 10]) {
    const blinded = ids.map((id) => blindedTag(id, k).tag);
    const defaults = ids.map((id) => NoteTag.withAccountTarget(id).asU32() >>> 0);
    const uniq = (a: number[]) => new Set(a).size;
    const allLow18 = (a: number[]) => a.every((t) => (t & LOW18) === 0);
    dim(`k=${k}: blinded distinct ${uniq(blinded)}/${ids.length}, default distinct ${uniq(defaults)}/${ids.length}, both default-shaped: ${allLow18(blinded) && allLow18(defaults)}`);
    R[`A4_uniform_k${k}`] = { blindedDistinct: uniq(blinded), defaultDistinct: uniq(defaults) };
  }

  // ── Phase B · a custom-tag private note on the chain ───────────────────
  hdr("Phase B · custom-tag private note on the mock chain");

  let noteCustomIdHex: string | null = null;
  let customTag = 0;
  let customPool = 0;
  let defaultTagOfBob = 0;
  let noteDefaultIdHex: string | null = null;
  let chainBlob: Uint8Array | null = null;
  let transportBlob: Uint8Array | null = null;
  // The receiver's whole blinded pool, and an equally sized pool belonging to a
  // different account to use as a negative control.
  let poolTags: number[] = [];
  let wrongPoolTags: number[] = [];

  try {
    const faucet = await client.accounts.create({
      type: FaucetType.FungibleFaucet, storage: "public",
      symbol: "ENV", decimals: 8, maxSupply: 10_000_000n,
    });
    const alice = await client.accounts.create();
    const bob = await client.accounts.create();
    // A WASM handle passed into a client call can be consumed by it (FP2). The
    // first v2 run cached `alice.id()` / `bob.id()` and reused those handles
    // across several awaits; by the time `send` reached `createP2IDNote` the
    // pointer was null. Carry immutable hex strings across awaits instead, and
    // mint a fresh handle only where a handle is genuinely required.
    const faucetHex = String(faucet.id());
    const aliceHex = String(alice.id());
    const bobHex = String(bob.id());
    defaultTagOfBob = NoteTag.withAccountTarget(bob.id()).asU32() >>> 0;
    ok(`faucet ${faucetHex}`);
    ok(`alice  ${aliceHex}`);
    ok(`bob    ${bobHex}   default tag ${hex8(defaultTagOfBob)}`);

    await client.proveBlock();
    await client.sync();
    await client.transactions.mint({ account: faucetHex, to: aliceHex, amount: 10_000n });
    await client.proveBlock();
    await client.sync();
    const cons = await client.transactions.consumeAll({ account: aliceHex });
    ok(`alice funded, consumed ${show((cons as any)?.consumed)}`);
    await client.proveBlock();
    await client.sync();

    // B1 — the baseline: an ordinary private send, tag derived by the SDK.
    const sent = await client.transactions.send({
      account: aliceHex, to: bobHex, token: faucetHex, amount: 100n,
      type: NoteVisibility.Private, returnNote: true,
    });
    const noteDefault: any = (sent as any).note;
    if (!noteDefault) throw new Error("returnNote gave no note");
    noteDefaultIdHex = noteDefault.id().toHex ? noteDefault.id().toHex() : String(noteDefault.id());
    const dTag = noteDefault.metadata().tag().asU32() >>> 0;
    ok(`baseline private note ${noteDefaultIdHex.slice(0, 20)}…  tag ${hex8(dTag)}  noteType ${noteDefault.metadata().noteType()}`);
    if (dTag === defaultTagOfBob) ok("  baseline tag == bob's default tag (receiver pinned to 14 bits)");

    // Seal a block before building the second note. Without it both
    // transactions sit pending against the same account state and the custom
    // note displaces the baseline — the first run lost the baseline entirely,
    // which left Phase C without its control.
    await client.proveBlock();
    await client.sync();
    ok(`baseline committed at block ${await client.getSyncHeight()}`);

    // B2 — build the SAME payment again, but with a blinded tag.
    // Everything between here and the submit is synchronous: no await, so no
    // other client call can invalidate the WASM handles we are reusing.
    const K = 7; // 2^(14-7) = 128 tags for bob to track
    const blinded = blindedTag(bobHex, K);
    customTag = blinded.tag;
    customPool = blinded.poolSize;
    warn(`blinded tag for bob at k=${K}: ${hex8(customTag)} (bob must track ${customPool} tags)`);

    // bob's pool is every default-shaped tag sharing his top K bits; the
    // control pool is the same construction for the next prefix along.
    const fillBits = DEFAULT_TAG_LEN - K;
    const prefix = idTopK(bobHex, K);
    poolTags = Array.from({ length: 2 ** fillBits }, (_, i) => (((prefix << fillBits) | i) << 18) >>> 0);
    const otherPrefix = (prefix + 1) & ((1 << K) - 1);
    wrongPoolTags = Array.from({ length: 2 ** fillBits }, (_, i) => (((otherPrefix << fillBits) | i) << 18) >>> 0);
    dim(`pool ${hex8(poolTags[0])} … ${hex8(poolTags[poolTags.length - 1])} (${poolTags.length} tags)`);
    dim(`control pool ${hex8(wrongPoolTags[0])} … ${hex8(wrongPoolTags[wrongPoolTags.length - 1])}`);
    if (!poolTags.includes(customTag)) bad("BUG: the blinded tag is not inside its own pool");

    const md = new NoteMetadata(alice.id(), NoteType.Private, new NoteTag(customTag));
    const noteCustom = Note.withAttachments(
      noteDefault.assets(), md, noteDefault.recipient(), noteDefault.attachments(),
    );
    const cTag = noteCustom.metadata().tag().asU32() >>> 0;
    noteCustomIdHex = noteCustom.id().toHex ? noteCustom.id().toHex() : String(noteCustom.id());
    if (cTag === customTag) ok(`custom note built, tag survived: ${hex8(cTag)}`);
    else bad(`tag did NOT survive withAttachments: got ${hex8(cTag)} wanted ${hex8(customTag)}`);
    ok(`custom note id ${noteCustomIdHex.slice(0, 20)}…`);
    dim(`custom note methods: ${surface(noteCustom).join(", ")}`);

    // B3 — submit it as the transaction's own output note.
    const builder = await client.feeAwareTransactionRequestBuilder(aliceHex);
    const request = builder.withOwnOutputNotes(new NoteArray([noteCustom])).build();
    const sub = await client.transactions.submit(aliceHex, request);
    ok(`custom-tag note submitted: ${show(sub)}`);

    await client.proveBlock();
    await client.sync();
    ok(`chain at block ${await client.getSyncHeight()}`);

    // B4 — relay both notes through the private transport.
    for (const [label, idHex] of [["baseline", noteDefaultIdHex], ["custom", noteCustomIdHex]] as const) {
      if (!idHex) continue;
      try {
        await client.notes.sendPrivateOutput({ noteId: idHex as any, to: bobHex });
        ok(`sendPrivateOutput(${label}) accepted`);
      } catch (e) {
        warn(`sendPrivateOutput(${label}) failed: ${E(e)}`);
        try {
          const blk = await client.getSyncHeight();
          await client.notes.sendPrivate({
            note: idHex as any, to: bobHex,
            inclusionProof: NoteInclusionProof.mockAtBlock(Math.max(0, (blk as number) - 1)),
          });
          ok(`sendPrivate(${label}) accepted with mockAtBlock`);
        } catch (e2) {
          bad(`sendPrivate(${label}) also failed: ${E(e2)}`);
        }
      }
    }

    const sentNotes = await client.notes.listSent();
    ok(`sender sees ${sentNotes.length} output note(s)`);
    // Confirm the tag that reached the chain, not just the local object.
    for (const n of sentNotes as any[]) {
      try {
        const t = n.metadata().tag();
        const tu = typeof t === "number" ? t : t.asU32();
        dim(`· type ${n.metadata().noteType()}  tag ${hex8(tu)}`);
      } catch (e) {
        dim(`· unreadable: ${E(e)}`);
      }
    }

    // B5 — snapshot for the observers
    chainBlob = await client.serializeMockChain();
    transportBlob = await client.serializeMockNoteTransportNode();
    ok(`serialized chain (${chainBlob.length} bytes) and transport (${transportBlob.length} bytes)`);
    R.B = { noteDefaultIdHex, noteCustomIdHex, defaultTagOfBob, customTag, customPool, sentNotes: sentNotes.length };
  } catch (e) {
    bad(`Phase B failed: ${E(e)}`);
    dim(String((e as Error)?.stack ?? "").split("\n").slice(1, 5).join(" | "));
    R.B_error = E(e);
  }

  // ── Phase C · what a keyless observer sees ─────────────────────────────
  hdr("Phase C · fresh observers holding no keys");

  async function observe(
    label: string,
    opts: Record<string, unknown>,
    tagsToTrack: number[],
    doFetchPrivate: boolean,
  ) {
    log(`\n  ── ${label} ──`);
    let c: any = null;
    const rec: Record<string, unknown> = { label, tagsToTrack: tagsToTrack.map(hex8) };
    try {
      // Every mock client shares one `mock_client_db` store. Without a wipe the
      // "fresh observer" would inherit the sender's synced notes and the
      // experiment would measure nothing at all.
      const w = await wipeStores();
      dim(`store wiped (${w.length}) — this observer starts from the snapshot alone`);
      c = await MidenClient.createMock(opts);
      for (const t of tagsToTrack) await c.tags.add(t);
      const before = await c.getSyncHeight();
      await c.sync();
      const after = await c.getSyncHeight();
      ok(`synced ${before} → ${after}`);
      if (doFetchPrivate) {
        try {
          await c.notes.fetchPrivate();
          ok("fetchPrivate() completed");
        } catch (e) {
          warn(`fetchPrivate() threw: ${E(e)}`);
          rec.fetchPrivateErr = E(e);
        }
      }
      const listed = await c.notes.list();
      rec.noteCount = listed.length;
      if (listed.length === 0) {
        warn("sees NO notes");
      } else {
        ok(`sees ${listed.length} note record(s)`);
        // One compact line per note, so a multi-note result stays readable and
        // the amount question is answered for every note, not just the first.
        for (const n0 of listed.slice(0, 6) as any[]) {
          const bits: string[] = [];
          try { bits.push(`id ${String(n0.id().toHex ? n0.id().toHex() : n0.id()).slice(0, 16)}…`); } catch { bits.push("id ?"); }
          try {
            const m = n0.metadata();
            bits.push(`tag ${hex8(m.tag().asU32())}`, `type ${m.noteType()}`, `sender ${String(m.sender()).slice(0, 10)}…`);
          } catch { bits.push("metadata ?"); }
          try {
            const fa = n0.details().assets().fungibleAssets();
            bits.push(`amount ${fa.map((a: any) => String(a.amount())).join("+") || "none"}`);
          } catch { bits.push("details ✗"); }
          dim(`· ${bits.join("  ")}`);
        }
        const n: any = listed[0];
        dim(`record methods: ${surface(n).join(", ")}`);
        for (const f of ["id", "noteId", "metadata", "sender", "tag", "noteType", "assets", "recipient", "details", "status", "inclusionProof"]) {
          if (typeof n[f] === "function") {
            const r = read(`${f}()`, () => n[f]());
            if (f === "metadata" && r.value) {
              const m: any = r.value;
              read("  metadata.sender()", () => m.sender());
              read("  metadata.tag()", () => hex8(m.tag().asU32()));
              read("  metadata.noteType()", () => m.noteType());
            }
            if (f === "tag" && typeof r.value === "number") dim(`    → ${hex8(r.value)}`);
            // The confidentiality question: can a keyless observer reach the
            // note's contents, or only its header? Dump the surface so the
            // difference is visible rather than assumed.
            if ((f === "assets" || f === "details" || f === "recipient") && r.value) {
              dim(`    ${f} surface: ${surface(r.value).join(", ")}`);
              if (f === "details") {
                // The confidentiality question made concrete: can a keyless
                // observer read the AMOUNT, or only tell that a note exists?
                try {
                  const fa = (r.value as any).assets().fungibleAssets();
                  dim(`    fungible assets inside the "private" note: ${fa.length}`);
                  for (const a of fa) {
                    read("      faucetId()", () => a.faucetId?.());
                    read("      amount()", () => a.amount?.());
                  }
                  rec.amountsReadable = fa.length > 0;
                } catch (e) {
                  dim(`    fungibleAssets() → ${E(e)}`);
                }
                read("    details.recipient()", () => (r.value as any).recipient());
              }
            }
          }
        }
        rec.firstNoteMethods = surface(n);
      }
    } catch (e) {
      bad(`${label} failed: ${E(e)}`);
      rec.error = E(e);
    } finally {
      try {
        if (c) await c.terminate();
      } catch { /* ignore */ }
    }
    R[`C_${label}`] = rec;
    return rec;
  }

  if (chainBlob && transportBlob) {
    try {
      await client.terminate();
      dim("main client terminated so observers get the store to themselves");
    } catch (e) {
      warn(`terminate failed: ${E(e)}`);
    }

    await observe("chainOnly_customTag", { serializedMockChain: chainBlob, seed: "obs-chain" }, [customTag], false);
    await observe("transport_customTag", { serializedMockChain: chainBlob, serializedNoteTransport: transportBlob, seed: "obs-t-custom" }, [customTag], true);
    await observe("transport_defaultTag", { serializedMockChain: chainBlob, serializedNoteTransport: transportBlob, seed: "obs-t-default" }, [defaultTagOfBob], true);
    // The control that was missing from the first run: bob's default tag now
    // has a real note under it, so finding the baseline there and the blinded
    // note only under its own tag rules out recipient-based routing.
    await observe("transport_defaultTag_baseline", { serializedMockChain: chainBlob, serializedNoteTransport: transportBlob, seed: "obs-t-base" }, [defaultTagOfBob], true);
    // What a real receiver has to do: subscribe to the entire blinded pool.
    await observe("transport_fullPool", { serializedMockChain: chainBlob, serializedNoteTransport: transportBlob, seed: "obs-pool" }, poolTags, true);
    // Negative control: an equally sized pool for a different account.
    await observe("transport_wrongPool", { serializedMockChain: chainBlob, serializedNoteTransport: transportBlob, seed: "obs-wrong" }, wrongPoolTags, true);

    hdr("Phase C · verdict");
    const chainOnly = R.C_chainOnly_customTag as any;
    const byCustom = R.C_transport_customTag as any;
    const byDefault = R.C_transport_defaultTag as any;
    const byDefaultBase = R.C_transport_defaultTag_baseline as any;
    const byPool = R.C_transport_fullPool as any;
    const byWrong = R.C_transport_wrongPool as any;
    const found = (x: any) => (x?.noteCount ?? 0) > 0;

    if (found(byCustom) && !found(byDefault)) ok("the blinded note is reachable by its own tag and NOT by the receiver's default tag");
    else if (!found(byCustom)) bad("the blinded note was not reachable at all — the design fails");
    else warn("found under both tags → the tag is not the gate; investigate");

    if (found(byDefaultBase)) ok("the default tag finds the BASELINE note → two notes to one recipient, each reachable only by its own tag. Routing is by note tag.");
    else warn("the baseline note was not found under the default tag — control inconclusive");

    if (found(byPool)) ok(`subscribing to the whole ${poolTags.length}-tag pool finds it → the receiver-side pool is implementable`);
    else bad("the full pool did NOT find it — check the pool construction");

    if (!found(byWrong)) ok("an equally sized pool for a different account finds nothing → widening is not a blanket download");
    else warn("the wrong pool also found notes → tag filtering is weaker than expected");

    if (!found(chainOnly)) ok("a chain-only observer sees no trace of the private note — the exposure lives in the transport, not the ledger");
    else warn("the chain-only observer saw notes → private notes leak on-chain as well");

    if (byCustom?.amountsReadable) bad("a KEYLESS observer read the asset amounts → private note contents are not encrypted; the tag is the only access control");

    R.verdict = {
      chainOnlyFound: found(chainOnly), customTagFound: found(byCustom),
      defaultTagFound: found(byDefault), baselineFound: found(byDefaultBase),
      poolFound: found(byPool), wrongPoolFound: found(byWrong),
      amountsReadable: !!byCustom?.amountsReadable,
    };
  } else {
    bad("no serialized chain — Phase C skipped");
  }

  // ── Phase D · isolating the default-tag anomaly ─────────────────────────
  // Tracking bob's default tag alone found nothing, yet the very same tag
  // inside the 128-tag pool found the baseline note. Same transport blob, same
  // tag, opposite answer. These runs separate three candidate causes: the
  // number of tags tracked, fetchPrivate(), and sync().
  if (chainBlob && transportBlob) {
    hdr("Phase D · isolating the default-tag anomaly");
    const snap = (seed: string) => ({ serializedMockChain: chainBlob, serializedNoteTransport: transportBlob, seed });
    await observe("D1_bothTags", snap("obs-d1"), [defaultTagOfBob, customTag], true);
    await observe("D2_defaultOnly", snap("obs-d2"), [defaultTagOfBob], true);
    await observe("D3_defaultNoFetch", snap("obs-d3"), [defaultTagOfBob], false);

    const d1 = (R.C_D1_bothTags as any)?.noteCount ?? 0;
    const d2 = (R.C_D2_defaultOnly as any)?.noteCount ?? 0;
    const d3 = (R.C_D3_defaultNoFetch as any)?.noteCount ?? 0;
    dim(`both tags → ${d1}   default alone → ${d2}   default alone, no fetchPrivate → ${d3}`);
    if (d1 >= 2) ok("tracking both tags surfaces BOTH notes → tag filtering is exact and the pool design is sound");
    else if (d1 === 1) warn("even with both tags tracked only one note surfaces → something drops the other; the pool cannot be trusted yet");
    else warn("neither surfaced → the transport snapshot may hold only one note");
    R.D = { both: d1, defaultOnly: d2, defaultNoFetch: d3 };
  }

  hdr("done");
  ok("window.__HARNESS__.results holds the machine-readable copy");
  (window as any).__HARNESS__ = { done: true, results: R };
}

main().catch((e) => {
  bad(`FATAL: ${E(e)}`);
  dim(String((e as Error)?.stack ?? "").split("\n").slice(0, 8).join("\n"));
  (window as any).__HARNESS__ = { done: true, fatal: E(e) };
});
