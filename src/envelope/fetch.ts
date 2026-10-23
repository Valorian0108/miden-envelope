/**
 * miden-envelope · fetch
 *
 * The receiver-side half of the library: getting every note filed in a tag pool
 * back out of the transport.
 *
 * The constraint that shapes this module was measured live, not read from docs.
 * `MIDEN-011` swept the real testnet transport: a `FetchNotes` request returns at
 * most **500 notes**, and that budget is **aggregate across every tag in the
 * request**, not per tag. It serves **oldest first** and there is **no cursor and
 * no pagination** — you cannot ask for the next page, only for the oldest 500
 * again.
 *
 * Three consequences, and they compose badly:
 *
 *   1. One request carrying all 128 pool tags gets **one** 500-note budget.
 *   2. Splitting into four requests of 32 tags gets **four** separate budgets.
 *   3. A tag that is busy enough to saturate its request will starve every other
 *      tag in that same request, and re-asking returns the same oldest notes.
 *
 * So the strategy is simple and it is not "fetch the pool": **batch the pool so
 * each batch carries its own budget**, reassemble, dedup client-side, and report
 * per-batch saturation so a caller can see a batch that hit the ceiling instead
 * of silently receiving less.
 *
 * The module cannot fix a saturated batch. Nothing can — the transport has no
 * pagination. What it can do is refuse to hide it.
 */

import * as T from "./tags";
import { MAX_TAGS_PER_REQUEST } from "./tags";

/** Measured live on testnet, `MIDEN-011`. Notes per request, aggregated across tags. */
export const TRANSPORT_NOTE_CAP = 500;

/** Re-exported from {@link T.MAX_TAGS_PER_REQUEST} so callers of this module keep one import. */
export { MAX_TAGS_PER_REQUEST };

/**
 * Tags per batch, default.
 *
 * The trade is budget against requests. Each batch carries its own 500-note
 * allowance, and each batch costs one round trip plus the client-side work of a
 * sync. 32 gives four budgets and four requests — enough headroom that a single
 * busy tag cannot swallow the rest, cheap enough to run on a timer.
 */
export const DEFAULT_TAGS_PER_REQUEST = 32;

/**
 * Split a pool into batches of at most `tagsPerRequest`.
 *
 * Pure, so the shape and cost of a fetch can be inspected without touching a
 * client. Throws rather than silently capping: a batch wider than the transport
 * accepts would be rejected at runtime, and a batch of zero would loop forever.
 */
export function planFetch(pool: number[], tagsPerRequest = DEFAULT_TAGS_PER_REQUEST): number[][] {
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new RangeError("planFetch needs a non-empty pool");
  }
  if (!Number.isInteger(tagsPerRequest) || tagsPerRequest < 1) {
    throw new RangeError(`tagsPerRequest must be a positive integer, got ${String(tagsPerRequest)}`);
  }
  if (tagsPerRequest > MAX_TAGS_PER_REQUEST) {
    throw new RangeError(
      `tagsPerRequest ${tagsPerRequest} exceeds the transport's ${MAX_TAGS_PER_REQUEST}-tag ceiling`,
    );
  }
  const out: number[][] = [];
  for (let i = 0; i < pool.length; i += tagsPerRequest) {
    out.push(pool.slice(i, i + tagsPerRequest));
  }
  return out;
}

/** What one batch actually produced. */
export interface BatchResult {
  /** Position of this batch in the plan. */
  index: number;
  /** How many tags the batch carried. */
  tags: number;
  /** Notes this batch surfaced that no earlier batch had. */
  found: number;
  /** Wall time for register + sync. */
  ms: number;
  /** True when the batch returned at or near the transport's per-request cap. */
  saturated: boolean;
  /** Set when the batch threw; the rest of the plan still runs. */
  error?: string;
}

export interface FetchResult {
  /** Batches executed, in order. */
  batches: BatchResult[];
  /** Requests issued — equal to the number of batches that ran without error. */
  requests: number;
  /** Every distinct note id recovered, across all batches. */
  noteIds: string[];
  /** Convenience: `noteIds.length`. */
  total: number;
  /** Wall time for the whole fetch. */
  totalMs: number;
  /** Batches that hit the cap. Non-zero means the fetch is lossy and cannot be fixed by retrying. */
  saturatedBatches: number;
}

export interface FetchPoolOptions {
  /** Tags per batch. Defaults to 32. */
  tagsPerRequest?: number;
  /** Cap to test saturation against. Defaults to the measured 500. */
  cap?: number;
  /** Called after each batch, for progress reporting in the demo and harness. */
  onBatch?: (b: BatchResult) => void;
  /**
   * Unregister each batch's tags once its notes are in the client store.
   *
   * Off by default. Whether this is safe — i.e. whether `tags.remove` preserves
   * notes already synced — is a property of the client, not of this module, and
   * Stage 5 measured it rather than assuming it. See `fetch.batchRetain` there.
   */
  removeAfterBatch?: boolean;
  /** Hard stop after this many batches, for a bounded run. */
  maxBatches?: number;
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

const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240);

/**
 * Fetch every note filed in `pool`, batch by batch, and dedup.
 *
 * The client is expected to hold no accounts — this is the receiver's own view,
 * so its registered tag set is the whole of what it can see. Callers that hold
 * accounts get those accounts' tags mixed in, which only adds notes.
 */
export async function fetchPool(
  client: unknown,
  pool: number[],
  opts: FetchPoolOptions = {},
): Promise<FetchResult> {
  const tc = client as any;
  const cap = opts.cap ?? TRANSPORT_NOTE_CAP;
  const plan = planFetch(pool, opts.tagsPerRequest ?? DEFAULT_TAGS_PER_REQUEST);
  const t0 = performance.now();

  const seen = new Set<string>();
  const batches: BatchResult[] = [];
  let requests = 0;
  let saturatedBatches = 0;

  const limit = opts.maxBatches === undefined ? plan.length : Math.min(plan.length, opts.maxBatches);

  for (let i = 0; i < limit; i++) {
    const tags = plan[i];
    const bt = performance.now();
    const before = new Set(seen);
    let error: string | undefined;

    try {
      for (const tag of tags) await tc.tags.add(tag);
      await tc.sync();
      requests++;

      const listed = await tc.notes.list();
      for (const n of listed) seen.add(noteIdHex(n));

      if (opts.removeAfterBatch) {
        for (const tag of tags) await tc.tags.remove(tag);
      }
    } catch (e) {
      error = E(e);
    }

    let found = 0;
    for (const id of seen) if (!before.has(id)) found++;
    // Exactly the cap, not above it. A batch returning more than `cap` is proof
    // the transport did not apply a cap at all — which is what the mock does —
    // so `>=` would report saturation for the opposite of the reason.
    const saturated = found === cap;
    if (saturated) saturatedBatches++;

    const b: BatchResult = {
      index: i,
      tags: tags.length,
      found,
      ms: Math.round(performance.now() - bt),
      saturated,
      ...(error ? { error } : {}),
    };
    batches.push(b);
    opts.onBatch?.(b);
  }

  return {
    batches,
    requests,
    noteIds: Array.from(seen),
    total: seen.size,
    totalMs: Math.round(performance.now() - t0),
    saturatedBatches,
  };
}

/** The plan's shape without running it — what a caller is signing up for. */
export function describePlan(poolSize: number, tagsPerRequest = DEFAULT_TAGS_PER_REQUEST): {
  tags: number;
  batches: number;
  budget: number;
  seams: string;
} {
  const batches = Math.ceil(poolSize / tagsPerRequest);
  const budget = batches * TRANSPORT_NOTE_CAP;
  const single = TRANSPORT_NOTE_CAP;
  return {
    tags: poolSize,
    batches,
    budget,
    seams: `${poolSize} tags → ${batches} request(s) of ≤${tagsPerRequest} · ` +
      `${budget} notes of headroom vs ${single} in one request (${(budget / single).toFixed(1)}×)`,
  };
}

/** Guard used by callers who want the pool and the plan checked together. */
export function assertPoolCovered(pool: number[], plan: number[][]): void {
  const flat = plan.flat();
  if (flat.length !== pool.length) {
    throw new RangeError(`plan covers ${flat.length} tags but the pool has ${pool.length}`);
  }
  const a = new Set(flat);
  const b = new Set(pool);
  if (a.size !== b.size) throw new RangeError("plan does not cover the pool exactly once");
  for (const t of b) if (!a.has(t)) throw new RangeError(`plan is missing ${T.describeTag(t)}`);
}
