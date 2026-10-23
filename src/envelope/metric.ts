/**
 * miden-envelope · metric
 *
 * The reconstruction metric: the one number the whole library exists to move.
 *
 * Everything before this module was mechanism — what a tag is, how a pool
 * assembles itself, how a send gets blinded, how a fetch gets batched. This
 * module turns that mechanism into the measurement an observer would actually
 * report: **of the notes on the wire, how many can be pinned on one receiver?**
 *
 * Two observers, because they see different things and the gap between them is
 * the whole point of the library:
 *
 *   • The **tag-only observer** has the wire and nothing else. It can group
 *     notes only by identical tags, so its power is the *link rate* — how many
 *     of one receiver's notes repeat a label. Blinding attacks this directly.
 *   • The **directory observer** also holds the list of account ids. Miden
 *     publishes those: ids sit in block commitments, and `MIDEN-011` measured
 *     the live transport handing a note's sender id to anyone who names the
 *     tag. Given an id and a tag length k it can recompute that account's whole
 *     pool, so it does not need repeated labels to group anything. Its power is
 *     the *attribution rate* — how many notes narrow to exactly one account.
 *
 * Both are pure arithmetic over ids and tags here. Nothing in this file touches
 * the SDK, so the harness, the demo and the spy's mood dial all read the same
 * numbers out of the same code.
 *
 * The structural fact that makes the arithmetic closed-form: pools at width k
 * **partition** the 16,384-tag space into 2^k blocks of 2^(14-k) tags. Two
 * accounts' pools are either identical or disjoint — they never partly overlap.
 * So a tag names a block, the candidate set is exactly the directory members
 * standing in that block, and *which* tag inside the block a sender drew makes
 * no difference at all. Blinding hides the label; it cannot hide the block.
 *
 * That last clause is the metric's honest limit, and it is why the attribution
 * rate is a function of k and of how crowded the directory is, not of how many
 * notes anyone sends.
 */

import * as T from "./tags";

/** The widths worth reporting: the whole usable range, coarsest first. */
export const CURVE_KS: number[] = [7, 8, 9, 10, 11, 12, 13, 14];

// ── the analytic prediction ────────────────────────────────────────────────

/**
 * What uniform top bits predict for the attribution rate, with no measurement
 * involved: the receiver is named outright only if none of the other N−1
 * directory members landed in its block.
 *
 * This is the sample-independent form of the result. Measuring one directory
 * tells you about that directory; this tells you what any directory of size N
 * does, and Stage 6's job is to check the measurement against it.
 */
export function predictedUniqueRate(k: number, n: number): number {
  if (n <= 1) return 1;
  return Math.pow(1 - Math.pow(2, -k), n - 1);
}

/** Expected number of directory pairs sharing a block, under uniform top bits. */
export function predictedPairs(k: number, n: number): number {
  return (n * (n - 1)) / 2 / Math.pow(2, k);
}

/**
 * Expected number of a receiver's notes that repeat a tag, if the sender draws
 * fills uniformly from a pool of `poolTags`.
 *
 * Counted as notes minus expected singletons rather than by the birthday pair
 * count, because at `poolTags = 1` — the legacy default-tag case — every note
 * shares its label with every other and the pair form under-reports by one.
 */
export function predictedLinked(notes: number, poolTags: number): number {
  if (notes === 0) return 0;
  if (poolTags <= 1) return notes;
  return notes - notes * Math.pow(1 - 1 / poolTags, notes - 1);
}

// ── the directory ──────────────────────────────────────────────────────────

/** One row of the attribution curve: what a given width k buys and costs. */
export interface CensusRow {
  /** Tag length — how many account-id bits the tag encodes. */
  k: number;
  /** Tags in one pool at this width: 2^(14−k). */
  poolTags: number;
  /** Blocks the tag space splits into: 2^k. */
  blocks: number;
  /** Directory size, N. */
  accounts: number;
  /** Blocks holding at least one directory member. */
  occupiedBlocks: number;
  /** Widest block — the best cover anyone in this directory has. */
  largestBlock: number;
  /** Accounts standing alone in their block. */
  alone: number;
  /** `alone / accounts` — the directory observer's attribution rate. */
  uniqueRate: number;
  /** {@link predictedUniqueRate} for the same k and N. */
  predicted: number;
  /** Mean block occupancy, counted per account, including the account itself. */
  meanSet: number;
  /** Directory pairs an observer at this width would confuse. Measured. */
  pairs: number;
  /** {@link predictedPairs} for the same k and N. */
  expectedPairs: number;
}

function blockCounts(directory: string[], k: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const raw of directory) {
    const p = T.accountIdPrefix(T.normalizeId(raw), k);
    m.set(p, (m.get(p) ?? 0) + 1);
  }
  return m;
}

function blockIndex(directory: string[], k: number): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const raw of directory) {
    const id = T.normalizeId(raw);
    const p = T.accountIdPrefix(id, k);
    const arr = m.get(p);
    if (arr) arr.push(id);
    else m.set(p, [id]);
  }
  return m;
}

/**
 * Sweep the directory once per width and report how much cover each width buys.
 *
 * This is a census, not a sample — every account is counted, so the only noise
 * in it is which ids the SDK happened to generate.
 */
export function census(directory: string[], ks: number[] = CURVE_KS): CensusRow[] {
  if (!Array.isArray(directory) || directory.length === 0) {
    throw new RangeError("census needs a non-empty directory");
  }
  const n = directory.length;
  const rows: CensusRow[] = [];
  for (const k of ks) {
    const occ = blockCounts(directory, k);
    let alone = 0;
    let largest = 0;
    let sumSquares = 0;
    let pairs = 0;
    for (const c of occ.values()) {
      if (c === 1) alone++;
      if (c > largest) largest = c;
      sumSquares += c * c;
      pairs += (c * (c - 1)) / 2;
    }
    rows.push({
      k,
      poolTags: T.poolSize(k),
      blocks: 1 << k,
      accounts: n,
      occupiedBlocks: occ.size,
      largestBlock: largest,
      alone,
      uniqueRate: alone / n,
      predicted: predictedUniqueRate(k, n),
      meanSet: sumSquares / n,
      pairs,
      expectedPairs: predictedPairs(k, n),
    });
  }
  return rows;
}

/** How many directory members share `id`'s block at width k, `id` included. */
export function occupancyOf(directory: string[], id: string, k: number): number {
  const p = T.accountIdPrefix(T.normalizeId(id), k);
  let n = 0;
  for (const raw of directory) if (T.accountIdPrefix(T.normalizeId(raw), k) === p) n++;
  return n;
}

/** The directory members a note filed under `tag` could possibly belong to. */
export function candidatesForTag(directory: string[], tag: number, k: number): string[] {
  if (!T.isDefaultShaped(tag)) return [];
  const p = T.tagPrefix(tag >>> 0, k);
  return blockIndex(directory, k).get(p) ?? [];
}

/**
 * The tags a keyless observer has to ask the transport for.
 *
 * It cannot know which tags are in use, so it takes every block its directory
 * occupies at the coarsest width it is willing to assume. k = 7 is the natural
 * floor: it is the widest pool one transport request can carry, so any note
 * blinded at any k ≥ 7 lands inside one of these blocks.
 *
 * Blocks partition the space, so the union has no duplicates and its size is
 * simply `occupiedBlocks × poolSize(k)`.
 */
export function sweepTags(directory: string[], k: number = T.MIN_K_ONE_REQUEST): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of directory) {
    const id = T.normalizeId(raw);
    const p = T.accountIdPrefix(id, k);
    if (seen.has(p)) continue;
    seen.add(p);
    for (const t of T.poolFor(id, k)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/** How much of the 16,384-tag space a sweep actually has to cover. */
export function sweepCoverage(tags: number[]): number {
  return tags.length / T.TAG_SPACE;
}

// ── the tag-only observer ──────────────────────────────────────────────────

export interface LinkProfile {
  /** Notes measured. */
  notes: number;
  /** Distinct labels they carry. */
  distinctTags: number;
  /** Notes whose label is shared with at least one other note in the set. */
  linked: number;
  /** `linked / notes` — how much of one receiver's traffic the observer can cluster. */
  linkRate: number;
  /** {@link predictedLinked} for the same note count and pool width. */
  expectedLinked: number;
  /** Pool width the expectation assumes: 2^(14−k). */
  poolTags: number;
}

/**
 * How much of one receiver's traffic a tag-only observer can group together.
 *
 * This is the number blinding moves most violently. At the legacy width every
 * payment to an account carries the same 32-bit label, so the rate is 1.0 and
 * the observer does not even need the directory. At k = 7 the same payments
 * scatter over 128 labels and the rate collapses to birthday-collision noise.
 */
export function linkProfile(tags: number[], k: number = T.DEFAULT_TAG_LEN): LinkProfile {
  const counts = new Map<number, number>();
  for (const t of tags) counts.set(t >>> 0, (counts.get(t >>> 0) ?? 0) + 1);
  let linked = 0;
  for (const c of counts.values()) if (c > 1) linked += c;
  const poolTags = T.poolSize(k);
  return {
    notes: tags.length,
    distinctTags: counts.size,
    linked,
    linkRate: tags.length ? linked / tags.length : 0,
    expectedLinked: predictedLinked(tags.length, poolTags),
    poolTags,
  };
}

// ── the directory observer ─────────────────────────────────────────────────

export interface NoteVerdict {
  noteId: string;
  tag: number;
  /** Directory members this note could belong to. */
  candidates: number;
  /** True when exactly one: the observer names the receiver outright. */
  unique: boolean;
  /** The account named, when the note is unique. */
  receiver?: string;
}

export interface AttributionReport {
  k: number;
  notes: number;
  /** Notes narrowing to one account. */
  unique: number;
  rate: number;
  /** Mean candidate-set size over the notes. */
  meanSet: number;
  perNote: NoteVerdict[];
}

/**
 * Run the directory observer over notes it has actually fetched.
 *
 * `notes` are what the wire gave back — an id and the tag the note was filed
 * under, both read off `NoteMetadata` by the harness. No account keys, no
 * chain access, nothing the transport does not already hand out.
 */
export function attributeNotes(
  directory: string[],
  notes: { noteId: string; tag: number }[],
  k: number,
): AttributionReport {
  const idx = blockIndex(directory, k);
  const perNote: NoteVerdict[] = [];
  let unique = 0;
  let sum = 0;
  for (const n of notes) {
    const tag = n.tag >>> 0;
    const cands = T.isDefaultShaped(tag) ? (idx.get(T.tagPrefix(tag, k)) ?? []) : [];
    const v: NoteVerdict = {
      noteId: n.noteId,
      tag,
      candidates: cands.length,
      unique: cands.length === 1,
      ...(cands.length === 1 ? { receiver: cands[0] } : {}),
    };
    if (v.unique) unique++;
    sum += cands.length;
    perNote.push(v);
  }
  return {
    k,
    notes: notes.length,
    unique,
    rate: notes.length ? unique / notes.length : 0,
    meanSet: notes.length ? sum / notes.length : 0,
    perNote,
  };
}

// ── the headline number ────────────────────────────────────────────────────

/** Everything the demo's dial needs at one width. */
export interface ReconstructionMetric {
  k: number;
  /** Labels one receiver's payments can be spread across. */
  poolTags: number;
  /** Transport requests that pool costs: 1 at k ≥ 7, more below. */
  requests: number;
  /** Directory the observer is assumed to hold. */
  accounts: number;
  /** Directory observer, over the directory: fraction of accounts named outright. */
  attribution: number;
  /** {@link predictedUniqueRate} for the same k and N. */
  predicted: number;
  /** Mean accounts a note is narrowed to. */
  meanSet: number;
  /** Directory observer, over the notes actually measured. */
  observedAttribution: number;
  /** Tag-only observer, over the notes actually measured. */
  link: number;
  /** One line for a log or a readout. */
  reads: string;
}

/**
 * The reconstruction metric at width k.
 *
 * `tagsByReceiver` maps a receiver id to the tags its notes were filed under —
 * the traffic the observer caught. Pass an empty object to get the curve from
 * the directory alone, which is what the demo does while the dial is dragging
 * and no traffic has been measured yet.
 *
 * Two rates come back and they are not the same claim. `attribution` is what
 * any payment in this population can expect; `observedAttribution` is what
 * happened to the payments actually on the wire, which for a single receiver is
 * either 0 or 1 because the candidate set is fixed by the block.
 */
export function reconstruction(
  directory: string[],
  tagsByReceiver: Record<string, number[]> = {},
  k: number = T.MIN_K_ONE_REQUEST,
): ReconstructionMetric {
  const row = census(directory, [k])[0];
  const poolTags = row.poolTags;

  let observedNotes = 0;
  let observedUnique = 0;
  let linked = 0;
  for (const [recv, tags] of Object.entries(tagsByReceiver)) {
    const occ = occupancyOf(directory, recv, k);
    observedNotes += tags.length;
    if (occ === 1) observedUnique += tags.length;
    linked += linkProfile(tags, k).linked;
  }

  const attribution = row.uniqueRate;
  const link = observedNotes ? linked / observedNotes : row.uniqueRate;
  const pct = (x: number) => (x * 100).toFixed(1) + "%";

  return {
    k,
    poolTags,
    requests: T.requestsForPool(k),
    accounts: row.accounts,
    attribution,
    predicted: row.predicted,
    meanSet: row.meanSet,
    observedAttribution: observedNotes ? observedUnique / observedNotes : attribution,
    link,
    reads:
      `k=${String(k).padStart(2)} · pool ${String(poolTags).padStart(3)} tag(s) · ` +
      `directory observer names ${pct(attribution)} of receivers outright ` +
      `(predicted ${pct(row.predicted)}, mean set ${row.meanSet.toFixed(2)}) · ` +
      `tag-only observer clusters ${pct(link)} of the traffic`,
  };
}

/** The whole curve, for a table or a chart. */
export function curve(
  directory: string[],
  tagsByReceiver: Record<string, number[]> = {},
  ks: number[] = CURVE_KS,
): ReconstructionMetric[] {
  return ks.map((k) => reconstruction(directory, tagsByReceiver, k));
}
