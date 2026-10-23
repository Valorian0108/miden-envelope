# Stage 3 — the tag math becomes library code (measured 2026-10-22)

Mock chain + mock note transport, browser WASM, `@miden-sdk/miden-sdk` 0.17.6.
Pages `stage3.html` / `stage3b.html` / `stage3c.html` with `src/stage3.ts`,
`src/stage3b.ts`, `src/stage3c.ts`. New library module: **`src/envelope/tags.ts`**.

| page | result | wall clock |
|---|---|---|
| `stage3.html` | PASS, 24/24 checks | 244.3 s |
| `stage3b.html` | PASS, 6/6 checks | 212.2 s |
| `stage3c.html` | PASS, 5/5 checks | 121.4 s |

---

## The point of the stage

Harness v1 proved the tag *model* with the arithmetic written inline in a page.
v2 used that model. Neither left anything reusable behind.

Stage 3 moves the arithmetic into `src/envelope/tags.ts` — pure TypeScript,
**no import from `@miden-sdk/miden-sdk` anywhere in it** — so the capture tool,
the demo and any Node-side test share one implementation. It then asks three
questions the corpus had not answered: what an account ID is actually made of,
whether the modelled 1-in-128 collision rate survives contact with real IDs, and
how many tags a client will really track.

The module deliberately does not replace anything Miden already ships.
`NoteTag.withCustomAccountTarget` builds a coarse tag and the client tracks tag
sets. What Miden ships nothing for is the **receiver-side pool** and
**sender-side blinding**, and those two are the module's contribution.

---

## Phase A — the library against the SDK

24 accounts (10 private wallets, 10 public wallets, 4 faucets) at 689 ms each.

| check | result |
|---|---|
| `AccountId.fromHex` round-trips every id | 24/24 |
| `isPrivate()` / `isPublic()` match the storage mode asked for | 24/24 |
| `defaultTag()` = `NoteTag.withAccountTarget()` | 24/24 |
| `coarseTag(id,k)` = `NoteTag.withCustomAccountTarget(id,k)`, k = 1..14 | **336/336** |
| pool size, shape, shared prefix and contains-own-default, every id × every k | **336/336** |
| 4000 blinded tags land inside the pool | 4000/4000 |
| 4000 blinded tags are default-shaped | 4000/4000 |
| distinct pool members hit in 4000 draws (uniform expectation ≈ 128) | **128/128** |
| library rejects bad k and bad ids with `RangeError` | 5/5 |

The 336/336 line is the load-bearing one: 24 ids × 14 tag lengths, the library's
independent implementation agreeing with the SDK's constructor on every single
value. The model `tag(id,k) = (top k bits of the 120-bit id) << (32−k)` is not
an approximation.

### New: the SDK does not validate tag length

`NoteTag.withCustomAccountTarget(id, k)` was probed outside the documented range:

| k | SDK behaviour | tag | default-shaped? |
|---|---|---|---|
| `0` | accepted | `0x00000000` | yes |
| `15` | accepted | `0x7a1e0000` | yes |
| `32` | **accepted** | `0x7a1ef2d5` | **no** — low 18 bits `0x2f2d5` |
| `-1` | rejected: *"note tag length 255 exceeds the maximum of 32"* | — | — |

Only the u8 wraparound is caught. The ceiling is 32, not 14.

`k = 32` is the dangerous one. That account was
`0x7a1ef2d524b46cc17d265df2b438a9`, and the tag returned was `0x7a1ef2d5` — the
first eight hex characters of the account ID, verbatim. It is not a tag that
routes; it is a tag that **publishes**. Because the reserved low 18 bits are no
longer zero, it also stops looking like any real account's tag, so it is
simultaneously a fingerprint and an outlier in the tag space.

This is exactly the failure `MIDEN-009` predicts, reachable by passing one
integer. `tags.ts` refuses every `k > 14` with a `RangeError`, and stage 3
asserts both halves of that: the SDK builds the self-fingerprinting tag, the
library will not.

---

## Phase B — what an account ID is actually made of

`AccountId` exposes `prefix()`, `suffix()`, `isPrivate()` and `isPublic()`. None
of them had ever been read. The naive assumption — that the 30-hex-char id is
just `prefix || suffix` — is **wrong**:

```
id = (prefix << 56) | (suffix >> 8)
```

Verified **7/7** in `stage3b` against six candidate formulas, of which no other
reproduced a single id, and **24/24** in `stage3`. So:

- `prefix()` is the id's **top 64 bits** (id bits 119..56), and its hex is a
  literal substring of the id.
- `suffix()` is the id's **low 56 bits pre-shifted left by 8** — its hex is *not*
  a substring of the id. Reading it as the low 56 bits silently loses 8 bits.

Example from the run:

```
id      0xb293c5dd94b56b81 22879e86ef2b27
prefix  0xb293c5dd94b56b81                  (top 64 bits)
suffix  0x22879e86ef2b2700                  (low 56 bits, << 8)
```

### Seven of the 120 bits are not random

Bit-position census across the sample, ones-fraction:

| id bit | ones | meaning |
|---|---|---|
| 61 | 0.000 | constant 0 |
| **60** | **0.00 private / 1.00 public** | **the storage-mode bit** |
| 59 | 0.000 | constant 0 |
| 58 | 0.000 | constant 0 |
| 57 | 0.000 | constant 0 |
| 56 | 1.000 | constant 1 |
| 55 | 0.000 | constant 0 — the suffix's top bit |

Bits 56..61 are the **low 6 bits of the prefix**. Read directly off
`prefix() & 0x3f`, they are:

```
private account   0b000001     3/3
public  account   0b010001     3/3
faucet            0b010001     1/1
```

Pattern `0 · mode · 0 0 0 1` — a fixed `0001` marker in the low four bits and
the storage mode in bit 4. Faucets are public-storage accounts.

**Bit 60 held with zero exceptions across every account measured: 148 private /
148 public in the first `stage3b` run, 100 / 99 in the second, and 24/24 in
`stage3` — 519 accounts, no counterexample.** That is a hard structural bit, not
a statistical tendency.

### The mode bit is out of a tag's reach

This is the part that matters for the envelope. The SDK caps tag length at 32,
so the widest note tag anyone can build encodes id bits **119..88**. The
storage-mode bit is id bit **60** — 28 bits below the floor of that range.

```
tag reach     bits 119 ─────────────── 88
mode bit                                  60
                        ↑ 28 bits of gap
```

So **a note tag cannot leak whether the receiver is a private or a public
account**, not even the deliberately over-wide `k=32` fingerprinting tag. The
mode is public knowledge — it is in the account ID, and `isPrivate()` is a
shipped accessor — but the tag channel adds nothing to it. Checked
sample-independently in `stage3`, and by direct measurement across all 32
reachable bit positions in `stage3b`.

### The MSB bias was a fluke

The first `stage3` run, at 10 public wallets, showed id bit 119 — the top bit of
every tag — set in only 1 of 10. At n=10 that is a 1% event: suggestive, and
worth real accounts to settle. Three independent samples later:

| sample | n private | n public | bit 119 private | bit 119 public | gap |
|---|---|---|---|---|---|
| `stage3` run 1 | 10 | 10 | — | **0.10** | ≈ −0.38 |
| `stage3b` run 1 | 148 | 148 | 0.480 | 0.439 | +0.041 |
| `stage3b` run 2 | 100 | 99 | 0.580 | 0.525 | +0.055 |
| `stage3` re-run | 10 | 10 | not flagged | not flagged | — |

Pooled across the two large samples: private 0.520 (129/248), public 0.474
(117/247), gap **0.047 against a standard error of 0.045 — almost exactly 1 SE.**
Every account together, private and public, gives 0.497. **Noise.**

The three samples disagreeing in both magnitude and direction is the stronger
evidence: a real structural bit looks like `0.00` vs `1.00` and never moves, the
way bit 60 did across all 519 accounts.

All 14 tag bits sit between 0.41 and 0.58 in both modes in the large samples, and
`stage3b` asserts the whole reachable range — id bits 119..88, everything a k=32
tag can encode — contains no bit that separates the modes by ≥0.35.

The tag draws its bits from the uniform hash region of the id. That is *why* pool
blinding works: the anonymity set at tag length k really is 2^k accounts wide,
not a structured subset of it.

---

## Phase C — the 1-in-128 collision rate, measured

`MIDEN-012` states that two account IDs sharing their top k bits land in each
other's pool, giving 1-in-128 accidental junk per account pair at k=7, and
caveats it as *"arithmetic, not a sample … real account ids may not be uniform in
their high bits."* Phase B settled the uniformity half. This is the sample.

`stage3` re-run, 120 accounts (7,140 pairs):

| k | distinct prefixes | biggest bucket | colliding pairs | expected | ratio | observed | model |
|---|---|---|---|---|---|---|---|
| 4 | 16 of 16 | 12 | 433 | 446.3 | 0.97 | 1 in 16 | 1 in 16 |
| **7** | **75 of 128** | **3** | **50** | **55.8** | **0.90** | **1 in 143** | **1 in 128** |
| 10 | 108 of 1024 | 3 | 13 | 7.0 | 1.86 | 1 in 549 | 1 in 1024 |
| 14 | 118 of 16384 | 2 | 2 | 0.4 | 4.5 | 1 in 3570 | 1 in 16384 |

First `stage3` run, 104 accounts (5,356 pairs), for comparison:

| k | distinct prefixes | biggest | pairs | expected | ratio |
|---|---|---|---|---|---|
| 4 | 16 of 16 | — | 348 | 334.8 | 1.04 |
| **7** | **67 of 128** | **4** | **48** | **41.8** | **1.15** |
| 10 | — | — | 8 | 5.2 | 1.54 |
| 14 | — | — | 1 | 0.3 | 3.1 |

**At k=7 — the design point — the model holds in both runs**, bracketing 1.0 at
0.90 and 1.15. `1 in 143` and `1 in 112` against a modelled `1 in 128`.

At k=10 and k=14 both runs land above expectation, but the counts are single
digits against sub-unit expectations: Poisson noise. At k=14 the second run saw 2
colliding pairs where 0.4 were expected, P(X≥2) ≈ 0.08. Not a signal, and not
worth over-reading — but it is the direction to watch if a much larger sample
ever becomes affordable.

Account creation costs **681–803 ms each**, so 120 accounts is ~80 s. A sample
large enough to resolve the k=14 tail would be tens of thousands of accounts and
is not reachable in the mock.

---

## Phase D — how many tags a client will track, and what it costs

`stage3c`, clean run, no accounts in the client so the baseline is zero and every
tag added is distinct:

| distinct tags | step time | ms/tag |
|---|---|---|
| 128 | 371 ms | 2.9 |
| 256 | 567 ms | 4.4 |
| 512 | 1,762 ms | 6.9 |
| 1,024 | 6,177 ms | 12.1 |
| 2,048 | 22,785 ms | 22.3 |
| 4,096 | 86,468 ms | 42.2 |

`tags.list()` returned exactly 4,096. **No ceiling error at any point.**

- **`tags.add` is idempotent** — re-adding the first and last tag left the count
  at 4,096. Asserted, not inferred: the first `stage3` run restarted its loop
  counter each step, so nearly every add was a duplicate, and `tags.list()` still
  came back at exactly the number of *distinct* values used.
- **`tags.remove()` works** — 4,096 → 4,095.
- **The client auto-registers one tag per account it holds.** With 120 accounts
  in it, `tags.list()` was 120 before a single manual add, and 4,216 = 120 + 4,096
  after. This is the number v2 could only guess at.
- **Cost is quadratic.** Per-tag latency doubles every time the set doubles
  (2.9 → 4.4 → 6.9 → 12.1 → 22.3 → 42.2), so cumulative registration is O(n²).
  With 120 accounts also in the client the same 4,096 tags cost 58.5 ms/tag
  instead of 42.2 — the cost tracks total client state, not just tag count.

### What that means for the library

The 128 is a **transport** ceiling, not a client one. A pool coarser than k=7 is
reachable; it just costs requests and registration time:

| k | pool size | transport requests | registration cost |
|---|---|---|---|
| 4 | 1,024 | 8 | ~30 s, impractical |
| 5 | 512 | 4 | ~9 s |
| 6 | 256 | 2 | ~0.9 s |
| **7** | **128** | **1** | **371 ms** |
| 8 | 64 | 1 | ~190 ms |
| 14 | 1 | 1 | trivial |

So **k = 7 stays the right default** — one request, sub-second registration — and
**k = 6 is the practical floor** if someone wants a 256-wide pool. Below that the
quadratic registration cost, not the protocol, is what stops you. The library
should register a pool **once** and never churn it.

---

## Instrument defects found and fixed

Three, all in the harness rather than the library:

1. **A restarting loop counter.** Phase D's first version reset `i` to 0 each
   step, so it measured duplicate writes and reported a "tracked" count it had
   never reached (`tags.list()` = 4,200 against a claimed 8,192). Fixed with a
   running counter; the accident did prove idempotence.
2. **An under-powered bias check.** "The storage mode does not show up in the tag
   bits" was being decided on 10 accounts per mode, where a bit landing 1-in-10
   is a 1% event. It flagged bit 119, which 148-per-mode then killed. Replaced
   with a **reach** argument that does not depend on sample size at all.
3. **A wrong slice.** The "prefix low 6 bits" line read
   `accountIdBits(id).slice(56).slice(-6)` — the *suffix's* low bits — and printed
   21 values of pure noise. The `bit 60` check next to it used the correct index
   and passed 24/24, so the finding was sound and only the decoration was wrong.
   Fixed to `.slice(58, 64)`.

Also recorded: `AccountId.fromHex` needs the `0x` prefix, `Felt.asInt()` returns
a `bigint` and is the only way to read `prefix()`/`suffix()` numerically, and
`browser.evaluate` caps at 60 s so every long phase polls a `window.__STAGEn__`
status flag in slices.

---

## What the library now contains

`src/envelope/tags.ts`, SDK-independent, `RangeError`-validated:

- constants — `ID_BITS` 120, `DEFAULT_TAG_LEN` 14, `RESERVED_LOW_BITS` 18,
  `TAG_MASK` 0x3ffff, `TAG_SPACE` 16384, `MAX_TAGS_PER_REQUEST` 128,
  `MIN_K_ONE_REQUEST` 7
- id handling — `normalizeId`, `accountIdBits`, `accountIdPrefix`
- tag building — `defaultTag`, `coarseTag`, `blindedTag`
- pool handling — `poolSize`, `poolFor`, `requestsForPool`, `poolContains`,
  `sharesPool`
- inspection — `isDefaultShaped`, `tagPrefix`, `describeTag`

Stage 4 builds the send path on top of `coarseTag` / `blindedTag`; Stage 5 builds
the fetch strategy on top of `poolFor` / `requestsForPool`.
