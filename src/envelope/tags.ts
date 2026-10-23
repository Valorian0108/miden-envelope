/**
 * miden-envelope · tag arithmetic
 *
 * The library's first real module. Deliberately SDK-independent: it takes account
 * IDs as hex strings and returns plain numbers, so the capture tool, the demo and
 * any future Node-side test all share one implementation.
 *
 * It never replaces a Miden feature it could call. `NoteTag.withCustomAccountTarget`
 * already builds a coarse tag, and the client already tracks tag sets. What Miden
 * ships nothing for is the *receiver-side pool* and *sender-side blinding*, and
 * those are what this module adds.
 *
 * The model, measured rather than assumed (336/336 predictions in harness v1,
 * re-validated in stage 3):
 *
 *     tag(id, k) = (top k bits of the 120-bit account id) << (32 - k)
 *
 * Bits 0..17 of every default-shaped tag are reserved and always zero, so a tag
 * carries only 14 bits of information and the whole default tag space is
 * 2^14 = 16,384 values.
 */

/** Miden account IDs are 15 bytes = 120 bits, rendered as 30 hex characters. */
export const ID_BITS = 120;
export const ID_HEX_CHARS = ID_BITS / 4;

/** How many account-ID bits a default tag encodes. The anonymity dial. */
export const DEFAULT_TAG_LEN = 14;

/** Tag bits 0..17 are reserved by the protocol and always zero. */
export const RESERVED_LOW_BITS = 18;

/** The only tag bits that carry information. */
export const TAG_MASK = 0x3ffff;

/** Every default-shaped tag that can exist. */
export const TAG_SPACE = 1 << DEFAULT_TAG_LEN;

/** The note transport's per-request ceiling on `FetchNotesRequest.tags`. */
export const MAX_TAGS_PER_REQUEST = 128;

/**
 * The coarsest tag length whose pool still fits in one transport request.
 * 2^(14-7) = 128. Below this a receiver needs several requests, not fewer tags.
 */
export const MIN_K_ONE_REQUEST = DEFAULT_TAG_LEN - Math.log2(MAX_TAGS_PER_REQUEST);

/** A source of uniform floats in [0, 1). Pass a seeded one for reproducibility. */
export type Rng = () => number;

// ── account ids ────────────────────────────────────────────────────────────

/** Strips `0x`, lowercases, and checks the ID is exactly 120 bits wide. */
export function normalizeId(id: string): string {
  const s = id.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(s)) {
    throw new RangeError(`account id is not hex: ${JSON.stringify(id)}`);
  }
  if (s.length !== ID_HEX_CHARS) {
    throw new RangeError(
      `account id must be ${ID_HEX_CHARS} hex chars (${ID_BITS} bits), got ${s.length}: 0x${s}`,
    );
  }
  return s;
}

/** The account ID as 120 characters of '0' and '1', most significant first. */
export function accountIdBits(id: string): string {
  const s = normalizeId(id);
  let bin = "";
  for (const c of s) bin += parseInt(c, 16).toString(2).padStart(4, "0");
  return bin;
}

/**
 * The top k bits of an account ID as a number. These are the bits a tag encodes,
 * so this is also the value that decides which accounts share a pool.
 */
export function accountIdPrefix(id: string, k: number): number {
  assertK(k);
  return parseInt(accountIdBits(id).slice(0, k), 2);
}

// ── tags ───────────────────────────────────────────────────────────────────

function assertK(k: number): void {
  if (!Number.isInteger(k) || k < 1 || k > DEFAULT_TAG_LEN) {
    throw new RangeError(`tag length k must be an integer in 1..${DEFAULT_TAG_LEN}, got ${k}`);
  }
}

/** True when a tag has the reserved low 18 bits clear, i.e. looks like a real one. */
export function isDefaultShaped(tag: number): boolean {
  return ((tag & TAG_MASK) >>> 0) === 0;
}

/**
 * The receiver's own tag: what a standard Miden client computes for them, and
 * what every legacy sender will therefore use. Equals
 * `NoteTag.withAccountTarget(id).asU32()`.
 */
export function defaultTag(id: string): number {
  return coarseTag(id, DEFAULT_TAG_LEN);
}

/**
 * A tag encoding only the top k account-ID bits. Coarser k means a bigger pool,
 * which means more senders look alike and less of the account ID is published.
 * Equals `NoteTag.withCustomAccountTarget(id, k).asU32()`.
 */
export function coarseTag(id: string, k: number): number {
  assertK(k);
  const prefix = accountIdPrefix(id, k);
  return ((prefix << (32 - k)) >>> 0);
}

/** How many tags a receiver must track at tag length k. */
export function poolSize(k: number): number {
  assertK(k);
  return 1 << (DEFAULT_TAG_LEN - k);
}

/**
 * How many transport requests a pool at tag length k needs. The client itself
 * has no ceiling — it accepted 160 tags in one run and 455 in another — the 128
 * is the note-transport node's per-request cap.
 */
export function requestsForPool(k: number): number {
  return Math.ceil(poolSize(k) / MAX_TAGS_PER_REQUEST);
}

/**
 * The receiver-side pool: every default-shaped tag sharing the account's top k
 * bits. This is the piece Miden does not ship.
 *
 * It is **self-assembling** — it needs no coordination, no shared secret and no
 * epoch, because any account whose ID starts with the same k bits is already a
 * member and will be reached by the same tag. The receiver's own default tag is
 * always one of them, so adopting a pool can never orphan a legacy sender.
 */
export function poolFor(id: string, k: number): number[] {
  assertK(k);
  const fillBits = DEFAULT_TAG_LEN - k;
  const prefix = accountIdPrefix(id, k);
  const size = 1 << fillBits;
  const out = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    out[i] = ((((prefix << fillBits) | i) << RESERVED_LOW_BITS) >>> 0);
  }
  return out;
}

/**
 * Sender-side blinding: pick one tag from the receiver's pool at random instead
 * of using their default tag. The note still reaches them — their client tracks
 * the whole pool — but it no longer names them, and consecutive payments to the
 * same receiver stop carrying an identical tag.
 *
 * This is also the second piece Miden does not ship. Blinding cannot make a
 * private note's contents unreadable; the transport serves those to anyone who
 * names the tag. It makes them **unattributable**.
 */
export function blindedTag(id: string, k: number, rng: Rng = Math.random): number {
  assertK(k);
  const fillBits = DEFAULT_TAG_LEN - k;
  const prefix = accountIdPrefix(id, k);
  const fill = Math.floor(rng() * (1 << fillBits));
  if (fill < 0 || fill >= 1 << fillBits) {
    throw new RangeError(`rng produced out-of-range fill ${fill} for ${fillBits} bits`);
  }
  return ((((prefix << fillBits) | fill) << RESERVED_LOW_BITS) >>> 0);
}

/** The top k bits of a tag — the account prefix it was built from, if any. */
export function tagPrefix(tag: number, k: number): number {
  assertK(k);
  return (tag >>> (32 - k)) & ((1 << k) - 1);
}

/** True when `tag` is a member of the pool for `id` at tag length `k`. */
export function poolContains(id: string, k: number, tag: number): boolean {
  return isDefaultShaped(tag) && tagPrefix(tag, k) === accountIdPrefix(id, k);
}

/** Human-readable rendering, for logs and the demo's inspector. */
export function describeTag(tag: number): string {
  const u = tag >>> 0;
  return `0x${u.toString(16).padStart(8, "0")}`;
}

/**
 * How many tags a pair of accounts share a pool over, at tag length k.
 * Two IDs agreeing on their top k bits land in each other's pool, so this is the
 * whole of the accidental-junk calculation: at k = 7 the chance is 1 in 128.
 */
export function sharesPool(a: string, b: string, k: number): boolean {
  assertK(k);
  return accountIdPrefix(a, k) === accountIdPrefix(b, k);
}
