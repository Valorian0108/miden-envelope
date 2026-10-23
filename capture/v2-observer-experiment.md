# Harness v2 — what a keyless observer actually sees (measured 2026-10-22)

Mock chain + mock note transport, browser WASM, `@miden-sdk/miden-sdk` 0.17.6
(wrapping Rust crate `miden-client-0.17.5`). Every number below is measured;
nothing is inferred from docs unless marked.

---

## Phase A — the tag model is proven, not eyeballed

**A1.** `NoteTag.withAccountTarget(id)` === `NoteTag.withCustomAccountTarget(id, 14)`
for **24/24** accounts. The default tag length is exactly 14 bits.

**A2.** The model

```
tag(id, k) = (top k bits of the 120-bit account id) << (32 - k)
```

predicts `withCustomAccountTarget(id, k)` correctly for **24/24 accounts at
every k from 1 to 14**. 336/336 predictions correct. The tag length *is* the
anonymity dial, and it is a shipped first-class API.

**A3.** `client.tags.add()` accepted **160 tags** on top of 24 auto-registered
ones (total 184) with **no client-side ceiling** — an earlier run took it to
455. The 128 limit is *not* a client limit. It is `FetchNotesRequest.tags`,
capped by the note-transport node ("Send all tags the client wants to check,
up to 128 tags"). So 128 is a **per-request protocol ceiling**, and covering
more tags means more requests, not impossibility.

Consequence for the design: pool size = 2^(14−k) ≤ 128 forces **k ≥ 7**.
k = 7 gives exactly 128 tags and the widest possible anonymity set.

**A4.** The blinding construction — coarse prefix plus random fill:

```
tag = ((topK(id) << (14-k)) | random(14-k bits)) << 18
```

Verified default-shaped (low 18 bits zero) and top-k-preserving for
k ∈ {4,6,7,8,10,12,14}. Pool sizes as predicted: k=7→128, k=10→16, k=12→4,
k=14→1.

Bonus property, arithmetic not measurement: because the fill is random **per
note**, two payments to the same receiver carry **different** tags. Under the
default scheme every payment to bob carries the identical tag `0x89380000`, so
an observer links them trivially. Blinding gives per-payment unlinkability, not
just a larger anonymity set.

**Structural fact worth stating:** the receiver's *default* tag is always a
member of its own blinded pool (same top-k prefix by construction). Measured:
pool `0x88000000 … 0x89fc0000`, bob's default `0x89380000` — inside it. A pool
receiver is therefore backwards-compatible with legacy senders for free.

---

## Phase B — a custom tag survives to the chain

```
faucet 0x6abf3efe3dacadd17c0ff43d72ab66
alice  0x78cb5308af9810c16a80d2121e9480
bob    0x893953ceaa1003c110bc4c08427dc4   default tag 0x89380000

baseline private note  0x0112509db94a021a69…  tag 0x89380000  noteType 0 (Private)
blinded tag at k=7     0x88500000             pool 0x88000000 … 0x89fc0000
custom note            0x7914976d3004a3b823…  tag 0x88500000  noteType 0 (Private)
```

Path that works, since `SendOptions`/`NoteOptions` have no tag field:

```ts
const md   = new NoteMetadata(alice.id(), NoteType.Private, new NoteTag(blinded));
const note = Note.withAttachments(base.assets(), md, base.recipient(), base.attachments());
const req  = (await client.feeAwareTransactionRequestBuilder(aliceHex))
               .withOwnOutputNotes(new NoteArray([note])).build();
await client.transactions.submit(aliceHex, req);
```

The sender's own `listSent()` confirms the tag that reached the chain:
`type 0  tag 0x88500000`.

**Private sends auto-relay to the transport.** `transactions.send(..., Private)`
published the baseline note to the transport with no explicit
`sendPrivateOutput` call — the later explicit relay failed with *"No output note
found for the given id"* precisely because it had already gone. The library does
not need a separate relay step.

---

## Phase C — the decisive result

Six fresh clients, **holding no keys**, each restored from a serialized snapshot
with the shared `mock_client_db` store wiped first.

| observer | tracks | result |
|---|---|---|
| `chainOnly` | blinded tag | **sees nothing** — synced 0→5, no notes |
| `transport` | blinded tag | **sees the note, in full** |
| `transport` | bob's default tag | sees nothing |
| `transport` | full 128-tag pool | sees a note, in full |
| `transport` | other account's 128-tag pool | sees nothing |

What the keyless observer read off a note marked `NoteType.Private`:

```
id()                  = 0x7914976d3004a3b823df5d857736e4573257d000dc47514ad65595f2a633d3f4
metadata.sender()     = 0x78cb5308af9810c16a80d2121e9480   ← alice, in full
metadata.tag()        = 0x88500000
metadata.noteType()   = 0                                   ← Private
details().assets().fungibleAssets()
   → faucetId()       = 0x6abf3efe3dacadd17c0ff43d72ab66
   → amount()         = 100n                                ← THE AMOUNT
details().recipient() = readable
```

### The headline

**A private note's contents are not encrypted, and the tag is the only access
control on them.** `FetchNotes` is unauthenticated — the transport node "does
not authenticate senders or recipients" and treats `details` as opaque bytes
that "may contain encrypted note details". The web SDK exposes **no
note-details encryption API at all**; its only encryption surface is
`TransactionEncryptionKey` / `submitProvenTx`, which encrypts the transaction
witness to the validators and has nothing to do with note contents.

Combined with the Phase A model this is a complete break of confidentiality for
an ordinary private payment:

1. bob's account ID is public.
2. `tag(bob, 14)` is a pure function of it — top 14 bits, left-aligned.
3. `FetchNotes([that tag])` needs no key, no permission, no authentication.
4. The response contains the sender, the amount, and the recipient.

So **anyone who knows a receiver's account ID can read every private payment
ever sent to them.** And because the tag space is only 2^14 and a request
carries 128 tags, the entire transport corpus is enumerable in ~128
unauthenticated requests.

What blinding changes: it does not make contents unreadable — nothing in the
SDK can. It makes them **unattributable**. An attacker who knows bob's ID can
still fetch the whole 128-tag pool, but that pool is shared by every account
with the same top-7 prefix, so a fetched note can no longer be pinned on bob.

### What the chain does and does not leak

`chainOnly` — restored from the chain snapshot alone, tracking the right tag,
synced to the tip — **saw nothing at all**. The exposure lives entirely in the
note transport, not the ledger. That is a meaningful split: the public chain
keeps its promise, and the off-chain relay does not.

Caveat, not measured: upstream issue `0xMiden/node#1796` states the node
"returns only NoteId + metadata for private notes" and that the client's
`NoteScreener` discards ones it cannot screen. So a **raw RPC** observer may
see more than the SDK client surfaces. My result is about the SDK client.

---

## Open anomaly — the counting is unreliable, the mechanism is not

Every observer returned **at most one note**, whichever tags it tracked:

| tracks | notes found |
|---|---|
| `[blinded]` | 1 — the blinded note |
| `[default]` | 0 |
| `[default, blinded]` | 1 — the *default*-tag note |
| `[128-tag pool]` | 1 — the *default*-tag note |
| `[wrong 128-tag pool]` | 0 |

Tracking the default tag alone finds nothing, yet tracking it alongside others
finds it. That is not a coherent filter, so the instrument is broken rather
than the pool.

**Leading hypothesis: a harness artifact, not an SDK bug.** The custom note was
built by reusing the baseline's `assets()` *and* `recipient()`, so both notes
share a serial number and storage commitment. If the client dedupes by
nullifier, the two collapse into one and which survives depends on ingestion
order. The fix is to make them genuinely distinct — different amount, or a
fresh serial — and re-run.

Until then: **the pool mechanism is proven** (a blinded tag is found by an
observer tracking it; an equally sized wrong pool finds nothing), but **the
volume a pool pulls is not measured**. The demo's junk-traffic metric depends
on closing this.

---

## Cost of the dial, all documented

- A 128-tag pool must be **polled**, not streamed: `StreamNotes` holds a
  subscription for one tag only.
- The transport does not validate note contents against chain state and does
  not authenticate senders, so a wider pool is an **open mailbox** — widening
  from 1 to 128 tags multiplies the inbound junk surface 128×.
- Attachment padding is public on-chain even for private notes and "only
  increases the note's public on-chain data and the fees its creator pays", so
  size uniformity costs real fee. `--max-note-size` (default 512,000 bytes)
  bounds it.
- Default retention is 30 days; notes vanish from the transport after that.

## Harness bugs found and fixed

- **`ForestOutOfBounds(5, 1)` WASM panic** — all mock clients share one
  IndexedDB store named `mock_client_db`, which survives reloads. A store that
  synced a previous chain meets a fresh one and panics, poisoning the instance
  and leaving every later promise unsettled. Fixed by wiping stores at startup
  *and* before each observer.
- **`null pointer passed to rust`** in `createP2IDNote` — cached `AccountId`
  handles reused across awaits. A client call can consume the handle it is
  given. Fixed by carrying hex strings across awaits (`AccountRef` is
  `string | Account | AccountHeader | AccountId`, so strings are API-blessed)
  and minting a fresh `.id()` only inside the synchronous build block.
- **Baseline note displaced** — two transactions left pending against the same
  account state. Fixed by sealing a block between them.
