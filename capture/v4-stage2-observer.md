# Stage 2 — the keyless observer, and the closing of G14 (measured 2026-10-22)

Mock chain + mock note transport, browser WASM, `@miden-sdk/miden-sdk` 0.17.6.
Page `stage2.html` + `src/stage2.ts`. Every number below is measured in one run;
19/19 checks green, 32.3 s wall clock.

---

## The question

`G14`: every observer in harness v2 returned **at most one note**, whichever tags
it tracked. Tracking the default tag alone found nothing, yet tracking it inside
a pool found it. Not a coherent filter, so the instrument was suspect.

Leading hypothesis recorded at the time: v2 built its custom-tag note by reusing
the baseline note's `recipient()`, so both notes shared one serial number and
therefore one nullifier, and the client's dedup collapsed them.

## The fix

`NoteRecipient.fromScript(script, storage)` — the SDK documents it as generating
"a fresh random serial number (the secret that prevents double-spends)". v2 used
`base.recipient()` instead. Building every note with a fresh recipient gives
7 notes → **7 distinct serials → 7 distinct ids**, verified before any observer
runs.

The hypothesis was **correct**. Counting is now coherent.

---

## Accounts and tags

```
faucet 0xfe61994a862c3b910506158668d856
alice  0x1d90972708200a81424681b74046c0   sender     default tag 0x1d900000
bob    0xc019f1b7c5198d810d3fab6ddcc820   receiver   default tag 0xc0180000
carol  0x6ddb2185675c3341226603ebfd24e4   bystander

pool (k=7)        128 tags  0xc0000000 … 0xc1fc0000
control pool      128 tags  0xc2000000 … 0xc3fc0000   (no overlap)
blinded tags                0xc18c0000  0xc1e80000
planted junk tags           0xc0000000  0xc0040000
```

`aliceInsideBobPool: false` in this run — alice's top 7 bits differ from bob's.

## Seven notes emitted

| label | visibility | tag | amount | to |
|---|---|---|---|---|
| default#1 | private | `0xc0180000` | 101 | bob |
| default#2 | private | `0xc0180000` | 102 | bob |
| default#3 | private | `0xc0180000` | 103 | bob |
| blinded#1 | private | `0xc18c0000` | 201 | bob |
| blinded#2 | private | `0xc1e80000` | 202 | bob |
| junk#1 | **public** | `0xc0000000` | 300 | carol |
| junk#2 | **public** | `0xc0040000` | 301 | carol |

The junk notes are deliberate: filed under tags inside bob's pool but addressed
to somebody else, so the junk count is a measurement and not a coincidence of
random account ids. All built with `createP2IDNote` → fresh `NoteRecipient` →
`Note.withAttachments(assets, new NoteMetadata(sender, type, new NoteTag(tag)), recipient, attachments)`,
submitted via `feeAwareTransactionRequestBuilder(...).withOwnOutputNotes(new NoteArray([note])).build()`
→ `transactions.submit`, with `proveBlock()` + `sync()` between each.

Snapshot: chain **26,134 bytes**, transport **1,482 bytes**.

---

## Seven observers, holding no keys

Each is a fresh `createMock({serializedMockChain[, serializedNoteTransport]})`
after a full IndexedDB wipe, so it starts from the snapshot alone.

| observer | channel | tracks | found |
|---|---|---|---|
| O1 | chain only | default + 2 blinded (3) | **0** |
| O2 | chain + transport | bob's default tag (1) | **3** |
| O3 | chain + transport | one blinded tag (1) | **1** |
| O4 | chain + transport | full 128-tag pool | **7** |
| O5 | chain + transport | wrong 128-tag pool | **0** |
| O6 | chain + transport | default + 2 blinded (3) | **5** |
| O7 | chain only | full 128-tag pool | **2** |

O6 is the exact case that returned **1** in v2. It now returns **5**.

### What O4 read, in full

All five target notes, every amount, every sender id:

```
0x1b20d732…  tag 0xc0180000  private  amount 101  from 0x1d90972708…
0x916eea99…  tag 0xc0180000  private  amount 102  from 0x1d90972708…
0x3c0bb8e3…  tag 0xc0180000  private  amount 103  from 0x1d90972708…
0x8929e29b…  tag 0xc18c0000  private  amount 201  from 0x1d90972708…
0x53defdbb…  tag 0xc1e80000  private  amount 202  from 0x1d90972708…
0x38c01de5…  tag 0xc0000000  public   amount 300  from 0x1d90972708…   ← junk
0x32d2c8ed…  tag 0xc0040000  public   amount 301  from 0x1d90972708…   ← junk
```

7 distinct ids. `noteType() = 0` (Private) on all five targets, and the sender's
full 120-bit account id is readable on every one.

### The pool volume, measured for the first time

```
1 tag    →  3 notes
128 tags →  7 notes   (5 intended, 2 not)
```

---

## The new finding: junk arrives on two channels

O7 is the observer that produces it. **Chain only**, tracking the full 128-tag
pool, it found:

```
0x38c01de5…  tag 0xc0000000  public  amount 300
0x32d2c8ed…  tag 0xc0040000  public  amount 301
```

— the two planted public notes, and **zero private notes**.

So the split is clean and now measured on both sides:

- **Private note contents come only from the transport.** A chain-only observer
  tracking the right tags sees nothing at all. Confirms `MIDEN-010`'s "the chain
  keeps its promise" on the pool case, not just the single-tag case.
- **Public notes come from the ledger, indexed by the same tag.** A pool receiver
  collects them whether or not it ever talks to the transport.

Consequence for the receiver design: widening the tag set widens inbound junk on
**both** channels, and a pool receiver must filter both. Stage 5 cannot treat the
transport as the only source of noise.

## Tag collisions between unrelated accounts are real

The **first** run of this stage (before the junk notes were planted) produced the
same effect by accident:

```
alice 0x72b49296…  default tag 0x72b40000
bob   0x73c7fcea…  pool        0x72000000 … 0x73fc0000
```

alice and bob shared the top 7 bits, so alice's own default tag was a member of
bob's pool, and the **public mint note** (2000, from the faucet) arrived in bob's
pool read uninvited. That run's O4 returned 6 where 5 were expected.

At k = 7 the collision probability is 1 in 128 per account pair. It is not rare
enough to ignore, and it is not something a sender chooses — it falls out of two
public account ids. The second run had no collision, which is exactly why the
junk notes are planted rather than hoped for.

---

## Instrument traps found

1. **`String(serialNum())` yields `[object Object]`.** A distinctness check built
   on it reported "1 unique" for 7 genuinely distinct serials. The SDK ships
   `wordToBigInt(word)` for reading a `Word`. Same family as Stage 1's
   `.status`-vs-`state()` trap: a blank answer silently satisfies a negative
   assertion.
2. **`listSent()` spans every account in the shared client.** It returned 8
   output notes for 7 emitted, because the faucet's mint note is one of them.
   Assertions must be by note id, never by count.
3. **The sender client must be disposed before the observers' wipes.**
   `indexedDB.deleteDatabase` fires `onblocked` and resolves without deleting if
   a connection is still open, which would leave each "fresh" observer holding
   the previous one's notes. `await client[Symbol.asyncDispose]()` releases the
   store connection; `terminate()` alone does not wait.

## Timing

Client up in 4.0 s (warm). 7 notes emitted + 7 observers run in **32.3 s**
total. Each observer costs a store wipe, a `createMock` from snapshot, and a
`sync`.
