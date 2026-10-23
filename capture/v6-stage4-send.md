# Stage 4 — the send path is one call, and the blinding is measured

**Date:** 2026-10-22
**Pages:** `stage4.html` + `src/stage4.ts`
**Library module under test:** `src/envelope/send.ts`
**Result:** **19/19 checks green**, twice. 24.5 s (first run, 18 checks) and 41.7 s (second run, 19 checks).

---

## What this stage had to prove

Stages 1–3 produced the pieces: a mock chain that settles, a keyless observer that can read a private
note if it names the right tag, and the tag arithmetic as library code agreeing with the SDK 336/336.

None of that tests the claim the project exists to make. That claim is:

> Sending through the library makes a payment invisible to someone who knows the receiver's name.

So the page sends **twenty payments to one receiver**:

- **10 through `sendEnvelope`** — blinded, a random tag drawn from the receiver's 128-tag pool.
- **10 through plain `createP2IDNote`** — no intervention at all, which is what every existing Miden
  wallet does.

Then the sender client is disposed, the IndexedDB stores are wiped, the chain and transport are
serialised, and **five keyless observers** are pointed at the snapshot. None holds a key, an account,
or any permission.

---

## The API

`src/envelope/send.ts` exports:

- `planEnvelope(receiverId, {k, rng, tag?})` → the decision, pure, no SDK. Refuses a `tag` that is
  not inside the receiver's pool, because a note filed there would be uncollectable.
- `sendEnvelope({client, from, to, assets, k, rng, noteType, relay, settle})` → one call, replaces the
  twelve-step raw sequence.
- `planBatch(receiverId, n, opts)` → the spread of `n` payments without sending them.

The `tag?` override is what makes the demo's before/after honest: pass the receiver's own `defaultTag`
and the note goes out exactly as a plain SDK send would, through the same code path.

---

## Run 2 (19/19) — the numbers

| | |
|---|---|
| sender | `0x86296da9946468c13dc512c86cad4c` |
| receiver | `0x94360463740dfbc14ea74b0155065a` |
| receiver's default tag | `0x94340000` |
| receiver's pool, k = 7 | 128 tags, `0x94000000` … `0x95fc0000` |
| sender's own default tag | `0x86280000` — outside the pool |

Ten blinded tags drawn:

```
0x95ec0000  0x944c0000  0x95880000  0x94a80000  0x95f00000
0x953c0000  0x953c0000  0x94800000  0x940c0000  0x95140000
```

**9 distinct across 10 notes** — one birthday collision. Expected collisions at 10 draws over 128
slots is C(10,2)/128 = 0.35, so this is unremarkable.

Ten naive payments all carried `0x94340000`. Not "usually" — every single one.

| observer | tracks | channel | found |
|---|---|---|---|
| **A1 — the spy** | receiver's default tag | chain + transport | **10** — all naive, **0 blinded** |
| **A2 — the receiver** | full 128-tag pool | chain + transport | **20** — 10 + 10 |
| A3 — control | sender's own tag | chain + transport | **1** — the public mint note, unrelated |
| A4 — control | full 128-tag pool | chain only | **0** |
| A5 — control | sender's own tag | chain only | **1** — the public mint note |

**The first row is the finding.**

Reconstruction rate for library payments, which is what the demo's spy character is wired to:

```
spy with the default tag   0.0%    (1/128 = 0.8% by arithmetic)
receiver with the pool    100.0%
```

---

## New facts

### 1. The relay files under the note's own tag, not a tag recomputed from the receiver

`notes.sendPrivateOutput({noteId, to})` is handed the receiver's account id. If it recomputed a tag
from `to`, every blinded note would land back on the default tag at relay time and the whole scheme
would be theatre — the note would arrive, look private, and be filed under the receiver's name.

A1 is the test. It tracks only `0x94340000`. It found the ten naive notes and **none** of the ten
blinded ones. Had the relay recomputed, A1 would have found all twenty.

Stage 2's O3 implied this — it found a note by its blinded tag after the same relay call — but never
asserted it. This is now a check, with the failure mode named in its own detail string.

### 2. `createP2IDNote` uses the receiver's default tag unconditionally

Ten of ten, in two independent runs, one distinct tag across all ten notes in each. So the naive path
is not *usually* the default tag; it always is.

That matters because `MIDEN-010`'s claim — the tag is the only access control — depends on the tag
being predictable, and predictability in turn depends on the default being the thing senders actually
use. It is.

### 3. A keyless observer's note list is exactly its registered tag set — public notes included

A5 tracks the sender's own tag, chain only, and finds the **public** mint note. A4 tracks the
receiver's 128-tag pool, chain only, and finds **nothing** — the twenty private notes are absent from
the chain entirely.

Two things fall out:

- Public notes are on the ledger and are readable without the transport, as expected.
- But an account-less observer still only sees them **if it registered the matching tag**. The tag
  set, not the chain, decides what such an observer sees.

This is the shortest statement of why tag secrecy is the whole of the access control: nothing else
gates the read. It also explains Stage 2's 0-vs-2 result without needing the transport to be involved.

### 4. Blinding costs nothing measurable

188 ms and 191 ms mean per blinded note, including `proveBlock()`, `sync()` **and** the relay. The ten
naive payments took 210 ms/note by phase total on the same run, with the same settle and relay steps.

So the library's tag choice is not a latency tax. On a mock chain, at least; the live cost will be
dominated by block cadence, not by 128 registered tags.

### 5. A pool with no strangers in it returns no junk

A2's 128-tag pool returned exactly 20 notes, all addressed to the receiver. Stage 2's pool returned
7 — 5 intended, 2 planted, plus a real accidental collision.

Both are correct. Junk arrives at roughly 1/128 per stranger *pair*, so a run with two accounts has no
stranger to collide with. This run is the clean baseline Stage 2's was measured against.

---

## Instrument defect found and fixed

One, and it failed loudly rather than quietly — but it was measuring the wrong thing.

**A3 asserted "sees nothing".** The first run (17/18) failed on `A3 the sender's own tag carries
nothing — got 1`. The observation was correct: a keyless observer tracking the sender's tag finds her
**public mint note**, which legitimately sits under that tag. The assertion should have been "sees
none of the payments", not "sees nothing".

Fixed, and kept as a control rather than dropped, because the note it does find is informative: it is
the thing that forced fact 3. Added **A5** at the same time — the same tag, chain only — to settle
whether public notes need the transport. They do not.

A second, quieter risk was written in from the start: the A1 assertion is `spyBlinded <= 1`, not
`=== 0`. Chance alone predicts 0.078 of ten, so a strict zero would fail one run in thirteen for
reasons that say nothing about the design. The tolerance is stated in the check's own detail string.

---

## Cost

| phase | run 2 |
|---|---|
| account creation (4 accounts) | 7.1 s |
| mint + consume | 0.9 s |
| 10 blinded sends | 1.9 s |
| 10 naive sends | 2.1 s |
| five observers (wipe + restore + register + sync) | 29.7 s |
| snapshot | 5 ms |
| **total** | **41.7 s** |

The observers dominate. Each one wipes every IndexedDB database, restores the snapshot and re-syncs,
which is the price of being genuinely keyless rather than nominally so.

Pool registration: **550 ms for 128 tags** (4.3 ms/tag) in run 2, **363 ms** (2.8 ms/tag) in run 1.
Against 2–4 ms for a single tag. Noisy, but decisively sub-second either way.

---

## What is still not proven

- **Live.** Everything here is the mock chain and the mock transport. The live transport's behaviour
  is `MIDEN-011`'s, measured separately; the two have not been wired together for a private note yet,
  because that needs testnet funding.
- **One sample.** Ten blinded payments, one run of record. The 0.0% is consistent with the arithmetic
  prediction of 0.8% and with `MIDEN-013`'s uniformity measurement, but it is not itself a rate
  estimate. Stage 6 is where the metric gets enough samples to be quoted as a number.
- **The sender is still fully named.** Confirmed in this run: all twenty recovered notes carry the
  sender's complete 120-bit account id in `NoteMetadata`. Blinding de-attributes the **receiver**.
  It does not touch the sender, and the library does not claim otherwise.
