# miden-envelope

Client-side metadata minimisation for Miden private notes.

Public repository: <https://github.com/Valorian0108/miden-envelope>

A Miden private note is sealed on the inside and labelled on the outside. The label is the
**tag** — a 32-bit number deciding which mailbox the note is filed under — and the standard
client computes it from the receiver's account id, so the tag *names* the receiver. Anyone
watching the note transport can collect every payment to you, group them, and name you,
because account ids are public.

This library changes the label.

## What it does

1. **Blinds the tag.** The sender draws at random from the receiver's **pool** — every tag
   sharing only the top *k* bits of the account id — instead of using the one tag that names
   them. The receiver's client already listens for the whole pool, and pools are
   **self-assembling** (any account with the same top *k* bits is already a member), so the
   note still arrives. It just stops naming its receiver, and consecutive payments stop
   carrying an identical label.
2. **Fetches the pool without losing notes.** The transport returns at most **500 notes per
   request**, that budget is **aggregate across every tag in the request**, it serves **oldest
   first**, and there is **no pagination**. `fetchPool` therefore splits the pool into batches
   — each batch carries its own 500-note budget — reassembles, dedups, and reports any batch
   that hit the ceiling instead of hiding it.
3. **Measures what that bought.** `census`, `reconstruction` and `linkProfile` turn the
   mechanism into two numbers an observer would report: the **attribution rate** (of the
   accounts in a directory, how many a holder of the directory can name outright at width *k*)
   and the **link rate** (of one receiver's payments, how many share a label).

## What it does not do

- It does not hide the **sender**. `NoteMetadata` carries the sender's full account id.
- It does not hide note **contents**. The transport serves them to anyone who names the tag.
- It does not stop a **targeted observer** — someone watching one account. Measured: 36/36
  caught at every width.

These limits are asserted in the code (`stage4`, `stage6`) so nobody over-claims later.

## Requirements

- Node ≥ 22, pnpm.
- `@miden-sdk/miden-sdk` for the send and fetch paths. **The SDK ships no Windows binary**
  (darwin-arm64, darwin-x64, linux-x64 only), so on Windows only the measuring half runs.
- The barrel (`src/envelope/index.ts`) is deliberately SDK-free: `tags`, `metric` and `fetch`
  are pure arithmetic and run in a browser, in Node, or in a test with nothing installed.
  `send` is a separate import on purpose, because pulling the SDK into the barrel would make
  the whole library unimportable where only the measuring half can run.

## Usage

Measure — no SDK, no chain:

```ts
import { census, reconstruction, poolFor, blindedTag } from "./src/envelope/index.js";

const directory = [ /* 120-bit account ids as hex */ ];

for (const row of census(directory)) {
  console.log(`k=${row.k}  named outright ${(row.uniqueRate * 100).toFixed(1)}%  ` +
              `(model ${(row.predicted * 100).toFixed(1)}%)`);
}

const m = reconstruction(directory, {}, 7);
console.log(m.reads);
```

Send — needs the SDK:

```ts
import { sendEnvelope } from "./src/envelope/send.js";

const sent = await sendEnvelope({
  client,                       // a MidenClient, mock or live
  from: senderId,
  to: receiverId,
  assets: [{ token: faucetId, amount: 1_000_000n }],
  k: 7,                         // tag width; 7 = coarsest that fits one request
});
// sent.tag is the label the note actually left under; sent.defaultTag is what a
// legacy sender would have used. sent.landedOnDefault says if the draw was unlucky.
```

Fetch — needs the SDK:

```ts
import { fetchPool, poolFor } from "./src/envelope/index.js";

const result = await fetchPool(client, poolFor(receiverId, 7));
// result.total notes, result.saturatedBatches batches that hit the 500-note cap.
// Non-zero saturation means the fetch is lossy and retrying cannot fix it.
```

## Layout

```
src/envelope/   the library: tags, metric, fetch (barrel) + send (separate)
src/stage*.ts   evidence harnesses, run through esbuild; not type-checked, not shipped
capture/        what each stage measured, one markdown file per stage
test/           unit tests over the pure modules (vitest)
```

## Scripts

```
pnpm test        52 unit tests over tags, metric, fetch, the send planner and the barrel
pnpm typecheck   tsc --noEmit, strict, over src/envelope, test and demo
pnpm dev         vite dev server
pnpm dev:mock    vite in mock mode: the SDK aliased to demo/mock-sdk.ts
pnpm capture     headless review pass: film + demo recordings, width frames, keyboard pass (RD-35)
pnpm stills      reviewable stills of every section, written into capture/
```

`capture/` holds what the review pass produces: `film-1440.webm` and `demo-1440.webm`, full-page
frames at four widths, and `still-*.png` per section. `record.mjs` exits non-zero on any failure,
so it can gate a build.

## Demonstration

`demo/index.html` (served at `/demo/index.html` under `pnpm dev:mock`) runs the library against
the in-memory chain and tells the story in four beats: twelve labels, the sweep, the three
observers, then the width dial unlocked. It is the library working, not a picture of it — the
only simulated part is the chain, and the page says so in its first paragraph.

`shell.html` is the separate explanatory film (parcels at a sorting counter), and the assembled
surface: the timed film on one screen, then the shortlist, the block, the nine-stop dial, the four
readings, six cards of argument, and footnotes saying what was measured and what is a stand-in. It
illustrates the idea and does not import the library. `preview.html` is the earlier surface it
replaces, kept for the record.

## The numbers it produced

Stage 6, on a mock chain: 128 real account ids, 72 private notes, a census at every width.

| k | pool tags | named outright (measured) | model |
|---|---|---|---|
| 7 | 128 | 35.9% | 36.9% |
| 8 | 64 | 66.4% | 60.8% |
| 10 | 16 | 90.6% | 88.3% |
| 12 | 4 | 98.4% | 96.9% |
| 14 | 1 | 100.0% | 99.2% |

The model is the closed form `(1 − 2^−k)^(N−1)`, and across 40 random crowds of 128 the
measured mean at k=7 is 36.5% with sd 4.8 — so a single directory is a sample, not a verdict.
Full tables in `capture/v8-stage6-metric.md`.
