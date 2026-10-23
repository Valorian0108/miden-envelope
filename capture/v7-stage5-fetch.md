# Stage 5 — the pool fetch strategy, and the cold-sync penalty

**Date:** 2026-10-22
**Pages:** `stage5.html` + `src/stage5.ts` (13/13, 156.9 s), `stage5b.html` + `src/stage5b.ts` (5/5, 397.4 s)
**Library module:** `src/envelope/fetch.ts`
**Result:** **13/13** and **5/5** green after one instrument fix and one false lead corrected.

---

## What the stage had to answer

`BUILD-001` set the acceptance test for Stage 5: *a full pool fetch returns every note that per-tag
queries return, with no silent truncation.* Its reason for batching came from `MIDEN-011`, measured
live on testnet:

> at most **500 notes per request**, the budget **aggregate across every tag in that request**,
> served **oldest first**, with **no cursor and no pagination**.

So the strategy is not "fetch the pool". It is "batch the pool so each batch carries its own 500-note
budget". Three questions had to be settled by measurement rather than reasoning:

- **A.** Does the mock transport model the cap at all?
- **B.** Does a full pool fetch return everything per-tag queries return?
- **C.** Is unregistering a batch after syncing it safe — i.e. does `tags.remove` keep the notes
  already in the store?

---

## The traffic

520 notes on **one** pool tag, plus 8 notes spread one-each across 8 other pool tags. 528 total.
Deferred settle: 528 `submit`s, one `proveBlock()`, then 528 relays.

| | |
|---|---|
| pool | 128 tags, k = 7 |
| flooded tag | `0x20fc0000` (pool member 63) |
| spread tags | `0x20040000 … 0x20e00000` |
| send | 528 notes in 68.8 s (≈ 130 ms/note, no per-note block proof) |
| relay | 528 / 528 |
| snapshot | chain 433,388 bytes · transport 153,183 bytes |

---

## Observers

| observer | tracks | found | time |
|---|---|---|---|
| **O1** — flooded tag alone (ground truth) | 1 | **520 of 520** | 8.8 s |
| **O2** — the 8 spread tags (ground truth) | 8 | **8 of 8** | 0.2 s |
| **O3** — whole pool, one request | 128 | **528**, 0 missed | 8.0 s |
| **O4** — `fetchPool`, 32 tags/batch | 128 in 4 | **528**, 0 missed | 10.2 s |
| **O5** — accumulate 32 tags, sync, then the other 96 | 128 in 2 | **528**, 0 missed | 7.1 s |
| **O6** — add flooded tag, sync, **remove**, sync | 1 → 0 | **520 → 520** | — |

O4's batches, in order:

```
batch 1/4   32 tags  +  4 notes    198 ms
batch 2/4   32 tags  +524 notes   7932 ms
batch 3/4   32 tags  +  0 notes    939 ms
batch 4/4   32 tags  +  0 notes   1140 ms
total 528 notes across 4 requests, 10208 ms
```

---

## Findings

### 1. The mock transport does not model the 500-note cap

A single tag holding 520 notes returned **all 520**. Not 500, not "the oldest 500" — 520.

This is the most important negative result of the stage. It means:

- The cap **cannot be reproduced locally**. Any harness built on the mock will see zero truncation and
  can be forgiven for concluding batching is unnecessary. It is not unnecessary; it is untestable here.
- The batching strategy rests entirely on `MIDEN-011`'s live measurement, and the local run can only
  verify that batching **loses nothing and costs little** — not that it rescues anything.

Stated plainly: Stage 5's acceptance test passes on the mock for the wrong reason. It is recorded as
passing, with that qualification, rather than presented as evidence about the cap.

### 2. Batching buys budget, not speed — and the first run said otherwise

Warm, on the same 528 notes:

| strategy | requests | headroom | cost |
|---|---|---|---|
| one wide request | 1 | 500 notes | **7.95 s** |
| four batches of 32 | 4 | 2,000 notes | **10.21 s** — 1.28× |

The arithmetic that motivates it: `1 × 500 = 500`, `4 × 500 = 2,000`, `8 × 500 = 4,000`.

**The first run measured 0.07×** — four batches *thirteen times faster* than one request. That was
wrong, and finding out why is the third finding.

### 3. The cold-sync penalty: a first sync costs 18–33× a later one

Stage 5b exists because Stage 5 produced a 16× anomaly between two paths moving identical data. Three
clients, one snapshot, segment-timed:

| client | sync | ingest | time |
|---|---|---|---|
| **B1** — pool, first sync | 1st | 528 notes | **115,140 ms** |
| **B2** — empty tag first, then pool | 1st | 0 notes | **102 ms** |
| | 2nd | 528 notes | **6,254 ms** |
| **B3** — pool, first sync, then again | 1st | 528 notes | **203,974 ms** |
| | 2nd | 0 new | **460 ms** |

`notes.list()` is not the cost — 272 ms for 528 rows in B1, against 115 s of sync.

**The shape of it.** A first sync ingests at roughly **218 ms per note** (115 s / 528). A later sync
ingests at **12 ms per note** (6.3 s / 528) — 18× cheaper. B3's 204 s against B1's 115 s for identical
work puts the variation at 18×–33×; the mechanism is **not identified**, so the entry claims the
behaviour and not the cause.

**Why it produced a false headline.** O4's first batch carried only 4 notes (its 32-tag slice
happened not to contain the flooded tag). So O4's first sync paid the penalty on 4 notes, and its
*second* sync carried all 524 at the cheap rate. O1 and O3 put all 520+ notes through a first sync.
Batching looked 13× faster purely because it accidentally arranged for the expensive mode to see
almost no work. The strategy was being credited with a scheduling accident.

**The fix, and it is free.** One `sync()` against an empty tag — 102 ms — moves every later ingest
onto the cheap path. 6.36 s total instead of 115 s. `stage5.ts` now warms every observer this way, and
the cold numbers only appear in 5b. Stage 7 needs this: a cold demo load is 7 s, not two minutes.

### 4. Unregistering a batch after syncing it is safe

O6: register the flooded tag, sync (520 notes), `tags.remove`, sync again → **still 520 notes**, and
`tags.list()` is empty.

So a batch's tags can be dropped once its notes are in the client store, which is what keeps a long
batch plan from paying for an ever-growing tag set. It is measured, not assumed — `fetchPool` still
defaults `removeAfterBatch` to `false` because one observation on a mock is not a licence to make it
the default.

### 5. Accumulating tags across syncs loses nothing

O5 reached 528 in two syncs and dropped none. So both batching shapes are correct; only the cost
differs — and the cost is visibly paid on the accumulated set:

Batches 3 and 4 found **zero** new notes yet cost **939 ms** and **1,140 ms**, because each sync
re-fetches every registered tag. Without removal, sync *n* costs proportional to the total tag set,
not to the new batch. With removal (finding 4), that growth disappears.

---

## Instrument defect found and fixed

**The saturation detector fired on the wrong comparison.** `saturated` was `found >= cap`, so a batch
returning **524** notes against a cap of 500 was flagged saturated — the exact opposite of the truth:
524 proves no cap was applied at all. Changed to `found === cap`, which is what saturation means. The
first run's only failure (11/12) was this check.

Same family as Stage 3's defects: an assertion that fires for a plausible-looking reason while
measuring nothing. Caught because the false positive was impossible to explain away.

---

## Cost, as it now stands

| | |
|---|---|
| send 528 notes, deferred settle | 68.8 s (130 ms/note) |
| relay 528 notes | 11.4 s |
| warm-up sync (per observer) | ~0.1 s |
| pool fetch, 128 tags, 4 batches, 528 notes | 10.2 s |
| pool fetch, 128 tags, 1 request, 528 notes | 8.0 s |
| whole stage run | 156.9 s |
| whole stage-5b run | 397.4 s |

---

## What is still not proven

- **The cap itself.** Never reproduced locally, for the reason in finding 1. It remains `MIDEN-011`'s
  live measurement, and the batching rationale is arithmetic on top of it.
- **Whether the cold-sync penalty exists on the live network.** Measured only on the mock client
  restored from a snapshot. The mechanism is unknown, so generalising it would be speculation.
- **Whether a saturated batch can be recovered.** It cannot, as far as the transport's semantics go —
  no pagination, oldest-first. `fetchPool` reports saturation rather than pretending to fix it.
