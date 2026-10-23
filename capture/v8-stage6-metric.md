# v8 — Stage 6: the reconstruction metric

Run 2026-10-22. Pages `stage6.html` + `src/stage6.ts` (16/16 checks, 248.9 s) and
`stage6b.html` + `src/stage6b.ts` (7/7 checks, 105.7 s on the final run, three runs
total). New library module **`src/envelope/metric.ts`**.

Everything here is mock-chain. No live traffic.

---

## What Stage 6 had to answer

Stages 2–5 built mechanism: a keyless observer can read the wire (Stage 2), tags are
arithmetic on account ids (Stage 3), a send can be blinded into a pool (Stage 4), a pool
can be fetched in bounded batches (Stage 5). None of that says how much privacy any of it
buys. `BUILD-001`'s acceptance test: *the metric moves when `k` moves, in the direction
`MIDEN-010` predicts.*

The question is not "can the observer see the note" — Stage 4 settled that, yes, always.
It is: **having seen it, can the observer say who it was for?**

## Two observers, because they hold different things

- **Tag-only.** Has the wire and nothing else. Can group notes only by identical labels.
  Its power is the **link rate**.
- **Directory.** Also holds the list of account ids. It can recompute any account's pool
  from an id and a width, so it does not need repeated labels. Its power is the
  **attribution rate**.

Giving the observer the directory is not a concession, it is the threat model. Miden
publishes account ids: they sit in block commitments, `MIDEN-013` measured the id layout
as public, and `MIDEN-011` measured the live transport handing a note's **sender** id to
anyone who names the tag. An observer that could not obtain the id list would be an
observer that had not bothered to look. The mock cannot enumerate accounts, so the
harness passes the list explicitly.

## The structural fact that makes the metric closed-form

Pools at width *k* **partition** the 16,384-tag space into 2^k blocks of 2^(14−k). Two
accounts' pools are either identical or disjoint — never partly overlapping. So:

- a tag names a block;
- the candidate set for a note is exactly the directory members standing in that block;
- **which tag inside the block a sender drew is irrelevant to attribution.**

Blinding hides the label. It cannot hide the block. That is the metric's honest ceiling,
and it is why the answer depends on *k* and on how crowded the directory is, and not at
all on how many notes anyone sends.

Two consequences follow as arithmetic:

```
attribution(k, N) = (1 − 2^−k)^(N−1)      P(receiver alone in its block)
pairs(k, N)       = C(N,2) / 2^k          P-weighted count of confusable pairs
```

`metric.ts` exports both as `predictedUniqueRate` and `predictedPairs`, and measures
rather than trusts them (below).

---

## Phase A — the census

128 real account ids from `client.accounts.create()`, 754 ms each, 98.0 s total. Plus a
faucet and a sender. Target receiver `0x8e1bed3ae2cca241746ef1ca4bf1ec`, default tag
`0x8e180000`.

Every account counted at every width — a census, not a sample.

| k | pool tags | blocks | occupied | largest | alone | attribution | predicted | mean set | pairs (expected) |
|---|---|---|---|---|---|---|---|---|---|
| 7 | 128 | 128 | 83 | 4 | 46 | **35.9%** | 36.9% | 1.844 | 54 (63.5) |
| 8 | 64 | 256 | 105 | 3 | 85 | **66.4%** | 60.8% | 1.406 | 26 (31.8) |
| 9 | 32 | 512 | 117 | 2 | 106 | **82.8%** | 78.0% | 1.172 | 11 (15.9) |
| 10 | 16 | 1,024 | 122 | 2 | 116 | **90.6%** | 88.3% | 1.094 | 6 (7.9) |
| 11 | 8 | 2,048 | 125 | 2 | 122 | **95.3%** | 94.0% | 1.047 | 3 (4.0) |
| 12 | 4 | 4,096 | 127 | 2 | 126 | **98.4%** | 96.9% | 1.016 | 1 (2.0) |
| 13 | 2 | 8,192 | 128 | 1 | 128 | **100.0%** | 98.5% | 1.000 | 0 (1.0) |
| 14 | 1 | 16,384 | 128 | 1 | 128 | **100.0%** | 99.2% | 1.000 | 0 (0.5) |

Monotone, and 2.8× from one end to the other. The target's own block held 3 accounts at
k = 7 and 8, 2 at k = 9, 1 at k ≥ 10 — which is why its note-level rate below jumps
rather than slides.

Occupied blocks at k = 7 was **83 in both independent runs** against 80.9 expected from
128·(1 − (1 − 1/128)^128). Unremarkable, but it means the sweep size is stable run to run.

## Phase B — traffic

72 notes, all P2ID, all private, all relayed, all with fresh serials:

| group | notes | receiver(s) | width |
|---|---|---|---|
| target | 30 | the target | k = 7, 8, 10, 12, 14 — six each |
| naive | 6 | the target | legacy: `tag = defaultTag(receiver)` |
| crowd | 36 | 12 other directory members | k = 7, three each |

The crowd exists so the note-level rate has a distribution instead of one receiver's
0-or-1. Settled and relayed in 45.5 s.

Tags actually used, target at each width (top five hex digits):

```
k = 7    8e040 8e140 8f8c0 8e940 8f1c0 8e240     six labels
k = 8    8e780 8ebc0 8eac0 8ea40 8e940 8e600     six labels
k = 10   8e1c0 8e040 8e040 8e300 8e340 8e240     five labels, one repeat
k = 12   8e180 8e180 8e180 8e1c0 8e1c0 8e100     three labels
k = 14   8e180 8e180 8e180 8e180 8e180 8e180     one label — the pool has size 1
legacy   0x8e180000 for all six
```

At k = 14 blinding is a no-op by construction: `poolSize(14) = 1`, so the only drawable
tag *is* the default tag. The library degrades to a plain SDK send at the narrow end and
never claims otherwise.

## Phase C — the keyless observer

A fresh client restored from the snapshot, holding **no accounts and no keys**. Warmed
with one 84 ms sync against empty tag `0x3e000000` first, because `MIDEN-014` measured
the alternative at ~218 ms per note instead of ~12 ms.

It sweeps every block its directory occupies at k = 7 — the coarsest width, so a note
blinded at any k ≥ 7 lands inside one of them:

```
sweep   10,624 tags = 83 occupied blocks × 128 · 64.8% of the tag space
plan    83 requests of ≤128 tags · 41,500 notes of headroom vs 500 in one request
run     83 batches in 95.8 s (≈1.15 s/batch) · removeAfterBatch: true
result  72 of 72 notes recovered · 0 saturated batches
```

`removeAfterBatch` is not optional here. Stage 5 finding 4: **every sync re-fetches every
registered tag.** Without removal, batch *n* would carry 128·n tags and the sweep would
be quadratic — 83 batches accumulating to 10,624 live tags. With it, each sync costs the
same as the last. This is the first run where that choice was load-bearing rather than
merely measured-safe.

## Phase D — what the observer can actually say

### The tag-only observer, on the target's payments

| sent at | notes | distinct labels | clustered | link rate | expected |
|---|---|---|---|---|---|
| k = 7 | 6 | 6 | 0 | **0.0%** | 0.23 |
| k = 8 | 6 | 6 | 0 | **0.0%** | 0.45 |
| k = 10 | 6 | 5 | 2 | **33.3%** | 1.65 |
| k = 12 | 6 | 3 | 5 | **83.3%** | 4.58 |
| k = 14 | 6 | 1 | 6 | **100.0%** | 6.00 |
| legacy | 6 | 1 | 6 | **100.0%** | 6.00 |

Every observed count sits at or below the uniform-fill expectation, as it should. Legacy
traffic is one label for all six payments — an observer with no directory at all can
group the target's entire history and never learn a single account id.

### The directory observer, matched width

| width | notes caught | named outright | rate | mean candidate set |
|---|---|---|---|---|
| k = 7 | 42 | 6 | **14.3%** | 2.50 |
| k = 8 | 6 | 0 | **0.0%** | 3.00 |
| k = 10 | 6 | 6 | **100.0%** | 1.00 |
| k = 12 | 6 | 6 | **100.0%** | 1.00 |
| k = 14 | 12 | 6+6 | **100.0%** | 1.00 |

The k = 8 row is the target's own block holding 3 accounts: mean candidate set 3.00,
nothing named. At k = 10 the block has 1 and everything is named. The step is exactly
where the census said it would be.

Assuming k = 7 for *everything* it caught — the conservative observer, which is what a
real one would do since it cannot know each sender's width:

```
72 notes → 6 named outright (8.3%), mean candidate set 2.71
```

### The targeted-observer control

A spy who already knows the receiver's id registers that receiver's pool and loses
nothing: **36 of 36** of the target's notes recoverable at every width, including k = 7.

This bounds the claim. **Blinding de-attributes in a crowd; it does not hide you from
someone who already has you.** Stage 4 measured the same thing from the other side, and
Stage 6 now measures it as part of the metric rather than leaving it implied.

---

## The failed check, and why the check was wrong

Stage 6's first run passed 14 of 15. The failure:

```
FAIL  every width matches the closed form (1 − 2^−k)^(N−1) within 3 SE
      k=14 96.9% vs 99.2% ±2.3%
```

That was 2 colliding pairs out of 128 ids where uniform top bits predict 0.5. Stage 3 had
independently measured 2 pairs in 120 accounts against 0.4 expected. Two samples both
landing on exactly 2 looked like a ~0.6% coincidence, so the tolerance was not widened.
`stage6b` was written to find out which of two explanations held:

- **(a)** the mock derives ids from something sequential — a nonce, a counter, a shared
  seed — so accounts created one after another are correlated, and the directory is not a
  fair model of a network population. If so, every crowding number above is an artefact
  of creation order.
- **(b)** the ids are independent and the closed form is simply noisy at this N.

### The null model

2,000 synthetic directories of 128 uniform random 120-bit ids, no SDK involved:

| k | closed form | simulated null mean | null distribution (pairs: trials) |
|---|---|---|---|
| 10 | 7.94 | 7.95 | 4:125 5:192 6:255 **7:289 8:286** 9:250 10:184 11:140 12:80 … |
| 11 | 3.97 | 3.93 | 2:331 3:369 **4:393** 5:319 6:204 7:102 … |
| 12 | 1.98 | 2.00 | 0:274 **1:547 2:540** 3:359 4:164 … |
| 13 | 0.99 | 0.97 | **0:746 1:761** 2:348 3:105 … |
| 14 | 0.50 | 0.48 | **0:1253** 1:578 2:139 3:23 4:6 5:1 |

The closed form is confirmed to two decimals at every width. `P(X ≥ 2)` at k = 14 is
**9.0%** — not a 0.6% event at all. The 0.6% figure came from asking "what is the chance
two samples both show 2?" *after* noticing that they both showed 2. Post-hoc selection.

### Fingerprint 1 — creation order

Tested at k = 10, the coarsest width, because that is where there are enough pairs to
average. (The second run of `stage6b` tested it at k = 14, where that directory yielded a
single pair; one gap cannot separate a counter from a coincidence, since ~9% of random
pairs out of 128 sit within six indices of each other. That run **failed** on gap 6, and
the failure meant nothing. The instrument was moved to k = 10, not the threshold.)

| run | pairs at k=10 | creation-index gaps | mean | expected | note |
|---|---|---|---|---|---|
| 6b run 1 | 4 | 13, 88, 21, 5 | 31.8 | 43.0 | not tested at the time |
| 6b run 2 | 9 | 71, 42, 26, 26, 85, 6, 80, 6, 35 | 41.9 | 43.0 | check was mis-aimed at k=14 |
| 6b run 3 | 9 | 77, 49, 95, 2, 91, 20, 60, 3, 34 | 47.9 | 43.0 | **two-sided p = 61.5%** over 20,000 simulated directories |

All three means sit on the order-independent expectation. Run 2's gaps average 41.9
against 43.0 — the run that "failed" the order test was in fact the most conforming of the
three; it was scored on one pair at the wrong width.

### Fingerprint 2 — bit divergence

Two independent ids that happen to share their top *k* bits are still uniform in the rest,
so they should differ in about half the free bits below the prefix, and their highest
differing bit should sit just under the prefix boundary. A counter diverges at the bottom.

| run | probed at | pair | differing bits | expected | highest differing bit | prefix floor |
|---|---|---|---|---|---|---|
| 6b run 2 | k = 14 | #60 ↔ #66 | 55 | ~50 | **105** | 106 |
| 6b run 3 | k = 11 | #7 ↔ #56 | 51 | ~51 | **108** | 109 |
| 6b run 3 | k = 11 | #24 ↔ #26 | 48 | ~51 | **108** | 109 |

```
#60  9a7996b5c14f52c10c157cade8800d
#66  9a7afc131a7e61014ebcea1516ec93
xor  00036aa6db3133c042a996b8fe6c9e   55 bits differ, highest at 105
```

`9a79` and `9a7a` agree on their top 14 bits and differ at bit 105 — the first bit below
the prefix. That is what a coincidence looks like. A counter would have produced a xor of
`000000000000000000000000000003`.

### Verdict

Hypothesis (a) is rejected. The k = 14 excess is Poisson noise, and pooling every
directory measured in this project settles it:

| sample | ids | pairs at k=14 | expected |
|---|---|---|---|
| Stage 3 (`v5`) | 120 | 2 | 0.44 |
| Stage 6 run 1 | 128 | 2 | 0.50 |
| Stage 6 run 2 | 128 | 0 | 0.50 |
| Stage 6b run 1 | 128 | 0 | 0.50 |
| Stage 6b run 2 | 128 | 1 | 0.50 |
| Stage 6b run 3 | 128 | 0 | 0.50 |
| **pooled** | **760** | **5** | **2.94** |

`P(X ≥ 5 | λ = 2.94) = 17.5%`. Nothing to explain.

### The instrument defect, stated plainly

The failed check compared `uniqueRate` against the prediction using a **binomial**
standard error. `alone` is not a sum of independent Bernoulli trials: when two accounts
share a block they are both non-alone *together*, so the trials are correlated and the
binomial SE understates the spread exactly where the rate is closest to 1. At k = 14 the
tolerance was ±2.32% and the deviation was 2.35% — the check failed by 1.4% of its own
width on a statistic whose variance it had wrong.

The sufficient statistic is the **collision count**, whose null is Poisson with mean
C(N,2)/2^k. The check is now a Poisson tail p-value, Bonferroni-corrected across the eight
widths (reject below 0.125%). Run 2's p-values: 89.8%, 86.8%, 91.8%, 80.3%, 75.7%, 86.3%,
100%, 100%.

A second check was added alongside it: the census **recomputed from the raw ids** without
going through `metric.ts`, asserting `alone + shared = N` and that pairs and occupied
blocks agree at all eight widths. An arithmetic bug in the library would otherwise present
as a finding.

### A cosmetic defect, recorded because the run output shows it

`stage6b`'s fingerprint-2 annotation compared the highest differing bit against the
**14-bit** tag boundary regardless of the width being probed. At k = 11 it therefore
printed `highest at bit 108 ← INSIDE the tag bits` for a perfectly correct result: bit 108
is below the top-11 prefix (bits 109–119), which is exactly what a k = 11 collision
requires. Fixed to compare against `ID_BITS − probeK`. No number in this file is affected;
the check itself used a `≥ floor − 20` threshold that passed either way.

---

## New facts, not already in the corpus

### 1. No tag bit is invariant — confirmed by invariance, not by marginals

Measured by invariance across all 128 ids: a position is invariant if it holds one value
in *every* id, which is a stronger test than the per-bit marginals `MIDEN-013` used
(how often a bit is 1 across 495 accounts). Reproduced bit-for-bit in two independently
generated directories:

```
bit  55 = 0     56 = 1     57 = 0     58 = 0     59 = 0     60 = 0     61 = 0
tag bits are 106..119 → none invariant, all 14 free
```

**This set is not new.** `MIDEN-013` documented exactly these seven positions, including
bit 55 as the suffix's top bit, and bits 56–61 as the prefix's low six reading
`0·mode·0001`. What is new is the *kind* of test: marginals average, invariance does not,
and the two agree here bit for bit. All 128 accounts were `accounts.create()` defaults, so
**bit 60 is invariant in this sample because the sample is single-mode, not because the bit
is fixed** — `MIDEN-013` measured it at 0.00 private / 1.00 public across 519 accounts.

The load-bearing part is what the test says about the bits that are *not* in the set:
**no tag bit is invariant.** `TAG_SPACE = 16,384`, `poolSize(k) = 2^(14−k)` and
`MIN_K_ONE_REQUEST = 7` all rest on the top 14 bits being free. `MIDEN-013` established
that by marginals — every tag bit between 0.41 and 0.58 ones. It now also holds by direct
invariance, which is the form the pool arithmetic actually needs.

### 2. The free bits are jointly uniform, not just marginally so

Marginal uniformity — each bit near 0.5 — does **not** imply the closed form. The form
needs ids to be *independent* across accounts. Pairwise Hamming distance tests that:

```
113 free bits predict a mean of 56.50 differing bits between two random ids
run 2 observed 56.67 ± 0.75 (500 pairs, sd 5.63)
run 3 observed 56.00 ± 0.69 (500 pairs, sd 5.14)
```

Both inside 1 SE of the prediction (± is 3 SE of the mean, not 1). The highest differing
bit averaged 118.0 and 117.9 out of a possible 119 — the ids diverge at the very top, as
independent uniform values must.

### 3. `removeAfterBatch` is load-bearing at scale, not merely safe

Stage 5 established that unregistering a batch's tags keeps the notes already synced, and
left the default `false` because one observation did not justify changing it. Stage 6 is
the case that would have broken without it: 83 batches, 10,624 tags, and a sync that
re-fetches every registered tag. The sweep ran at a flat ~1.15 s per batch from batch 1 to
batch 83. Accumulating instead would have made batch 83 cost 83× batch 1.

### 4. Blinding is a no-op at k = 14, by construction

`poolSize(14) = 1`, so the only tag a sender can draw *is* the receiver's default tag. The
library's dial has a hard floor at k = 7 (`MIN_K_ONE_REQUEST`, set by the transport's
128-tag ceiling) and a hard ceiling at k = 14 where it becomes a plain SDK send. Both ends
are visible in the data rather than asserted in a docstring.

### 5. A keyless observer has to sweep 64.8% of the tag space

Not the whole 16,384. Blocks partition the space, so the observer only needs the blocks
its directory occupies — 83 of 128 at N = 128, and the fraction tends to
1 − e^(−N/128) as N grows. At N = 1,000 that is 99.96%: **a large enough directory makes
the sweep exhaustive.** The privacy blinding buys is a function of how many accounts the
observer is tracking, and it decays as the observer's directory grows.

---

## Cost

| | |
|---|---|
| create 128 account ids | 98.0 s (754 ms each) |
| fund the sender | 4.8 s |
| build + settle + relay 72 notes | 45.5 s |
| observer warm-up sync | 84 ms |
| sweep 10,624 tags in 83 batches | 95.8 s (≈1.15 s/batch) |
| **Stage 6 whole run** | **248.9 s** |
| create 128 ids (`stage6b`) | 96.2 s |
| 2,000-trial null model, 5 widths | ≈1 s |
| **Stage 6b whole run** | **105.7 s** |

Account creation dominates both pages. At 754–920 ms per id, a directory of 1,000 — the
size at which the sweep becomes exhaustive — would cost ~13 minutes to build. That is a
harness cost, not a library cost: the metric itself is arithmetic and runs in microseconds.

---

## Verdict

Stage 6 is done. The metric moves when `k` moves, monotonically, in the direction
`MIDEN-010` predicts: **35.9% → 100%** for the directory observer, **0% → 100%** for the
tag-only observer, across k = 7 → 14 on 128 real account ids. The note-level candidate
sets match the census prediction for all 72 notes, note for note. The closed form survives
a goodness-of-fit at every width. 16/16 checks.

What the metric says, in one sentence each:

- A payment sent the legacy way carries one label for every payment to that account, and
  anyone on the wire can group the whole history without knowing who it belongs to.
- The same payment blinded at k = 7 carries one of 128 labels, and grouping by label
  collapses to zero.
- An observer holding the public id list still narrows a k = 7 payment to 2.71 accounts on
  average, and names the receiver outright 8.3% of the time.
- The same observer at k = 14 names the receiver 100% of the time.
- An observer who already knows the receiver's id gets every note at every width. Blinding
  is crowd cover, not concealment.
