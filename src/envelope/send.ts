/**
 * miden-envelope · send
 *
 * The one-call send path. Stage 2 proved the sequence by hand, one note at a
 * time, inside a harness page. This is that sequence lifted into the library so
 * a caller can say "pay this account privately" and get blinding for free.
 *
 * What it does that a plain SDK send does not:
 *
 *   1. Picks a **tag** → the label deciding whose mailbox a note is filed under →
 *      at random from the receiver's pool, instead of using the one tag that
 *      names them. The note still reaches them, because their client listens for
 *      the whole pool. It just stops naming them.
 *   2. Draws a **fresh serial** for every note via `NoteRecipient.fromScript`.
 *      Reusing a recipient gives two notes one nullifier and the client's dedup
 *      silently collapses them — the defect that made harness v2's counts wrong.
 *   3. Relays the note details to the transport, which is the only channel that
 *      carries private note contents at all.
 *
 * What it does NOT do: hide the sender. `NoteMetadata` carries the sender's full
 * account id and anyone who reads the note can see it. Blinding de-attributes the
 * **receiver**, never the sender. Stage 4 asserts this rather than leaving it
 * implied, so nobody over-claims it later.
 */

import * as SDK from "@miden-sdk/miden-sdk";
import * as T from "./tags";

/** The decisions made before anything touches the chain. Pure, so testable. */
export interface EnvelopePlan {
  /** The tag the note will actually be filed under. */
  tag: number;
  /** Tag length used — how many account-id bits the tag encodes. */
  k: number;
  /** How many tags share this prefix: the width of the receiver's cover. */
  poolSize: number;
  /** The tag a legacy sender would have used, for comparison. */
  defaultTag: number;
  /** True when the random draw happened to land on the receiver's own tag. */
  landedOnDefault: boolean;
  /** Normalised receiver id. */
  receiverId: string;
}

export interface PlanOptions {
  /** Tag length. Defaults to 7 — the coarsest that still fits one request. */
  k?: number;
  /** Randomness source. Pass a seeded one for a reproducible run. */
  rng?: T.Rng;
  /**
   * Use this tag instead of drawing one at random.
   *
   * The escape hatch that makes the library testable and the demo honest: pass
   * the receiver's own `defaultTag` and the note goes out exactly as a plain SDK
   * send would, which is the "blinding off" half of a side-by-side. Refuses any
   * tag that is not inside the receiver's pool — a tag outside it would mean a
   * note nobody can ever collect.
   */
  tag?: number;
}

/**
 * Decide how a payment to `receiverId` will be labelled, without sending it.
 *
 * Split out from {@link sendEnvelope} so the choice can be inspected, logged and
 * unit-tested on its own — and so a caller can plan a batch and see the spread
 * before committing anything to the chain.
 */
export function planEnvelope(receiverId: string, opts: PlanOptions = {}): EnvelopePlan {
  const id = T.normalizeId(receiverId);
  const k = opts.k ?? T.MIN_K_ONE_REQUEST;
  const poolSize = T.poolSize(k);
  const defaultTag = T.defaultTag(id);

  let tag: number;
  if (opts.tag === undefined) {
    tag = T.blindedTag(id, k, opts.rng ?? Math.random);
  } else {
    tag = opts.tag >>> 0;
    if (!T.poolContains(id, k, tag)) {
      throw new RangeError(
        `tag ${T.describeTag(tag)} is not in ${T.describeTag(defaultTag)}'s ${poolSize}-tag pool — ` +
          `a note filed there would never reach ${id.slice(0, 8)}…`,
      );
    }
  }

  return { tag, k, poolSize, defaultTag, landedOnDefault: tag === defaultTag, receiverId: id };
}

export interface SendEnvelopeOptions extends PlanOptions {
  /** A `MidenClient` — mock or live. Typed loosely so the library does not pin a version. */
  client: unknown;
  /** Sender account id. */
  from: string;
  /** Receiver account id. */
  to: string;
  /** What to send. `token` is the faucet or asset account id. */
  assets: { token: string; amount: bigint }[];
  /** `"private"` (default) or `"public"`. */
  noteType?: "private" | "public";
  /**
   * File the note details with the transport after settling. Default true.
   * Without this a private note exists on chain as a commitment and nothing more
   * — the receiver can never read it, because contents only travel by relay.
   */
  relay?: boolean;
  /** `proveBlock()` + `sync()` after submitting. Default true. */
  settle?: boolean;
}

export interface SentEnvelope extends EnvelopePlan {
  /** The note's id, as hex. */
  noteId: string;
  /** The fresh serial drawn for this note, as hex. Distinct per note by construction. */
  serial: string;
  /** Whether the relay step ran and succeeded. */
  relayed: boolean;
  /** Set when `relay` was asked for but failed; the send itself still succeeded. */
  relayError?: string;
  /** Milliseconds for the whole call. */
  ms: number;
}

const E = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300);

/**
 * Send a payment filed under a random member of the receiver's tag pool.
 *
 * One call replaces the twelve-step sequence a raw SDK send needs, and the tag
 * choice — the part that decides whether the payment names its receiver — stops
 * being something the caller has to remember to do.
 */
export async function sendEnvelope(o: SendEnvelopeOptions): Promise<SentEnvelope> {
  const t0 = performance.now();
  const {
    NoteTag, NoteType, Note, NoteMetadata, NoteArray,
    NoteRecipient, AccountId, createP2IDNote, wordToBigInt,
  } = SDK as any;
  for (const [name, v] of Object.entries({
    NoteTag, NoteType, Note, NoteMetadata, NoteArray,
    NoteRecipient, AccountId, createP2IDNote, wordToBigInt,
  })) {
    if (!v) throw new Error(`@miden-sdk/miden-sdk does not export ${name}`);
  }

  const client = o.client as any;
  const from = T.normalizeId(o.from);
  const to = T.normalizeId(o.to);
  const priv = (o.noteType ?? "private") === "private";
  const plan = planEnvelope(to, { k: o.k, rng: o.rng, tag: o.tag });

  if (!Array.isArray(o.assets) || o.assets.length === 0) {
    throw new RangeError("sendEnvelope needs at least one asset");
  }
  for (const a of o.assets) {
    if (typeof a.amount !== "bigint" || a.amount <= 0n) {
      throw new RangeError(`asset amount must be a positive bigint, got ${String(a.amount)}`);
    }
    T.normalizeId(a.token);
  }

  // A P2ID note, then rebuilt with our own metadata and a fresh recipient. The
  // base note gives us the right script and storage; we discard its serial and
  // its tag, which are the two things that would otherwise identify or collide.
  const base = createP2IDNote({
    from: "0x" + from,
    to: "0x" + to,
    assets: o.assets.map((a) => ({ token: "0x" + T.normalizeId(a.token), amount: a.amount })),
    type: priv ? "private" : "public",
  });
  const br = base.recipient();
  const fresh = NoteRecipient.fromScript(br.script(), br.storage());
  const md = new NoteMetadata(
    AccountId.fromHex("0x" + from),
    priv ? NoteType.Private : NoteType.Public,
    new NoteTag(plan.tag),
  );
  const note = Note.withAttachments(base.assets(), md, fresh, base.attachments());

  // The tag has to survive the rebuild. If a future SDK version drops it here the
  // note would silently go out under the receiver's default tag, and every
  // privacy claim this library makes would be false while still passing.
  const got = note.metadata().tag().asU32() >>> 0;
  if (got !== plan.tag) {
    throw new Error(
      `tag did not survive Note.withAttachments: wanted ${T.describeTag(plan.tag)}, got ${T.describeTag(got)}`,
    );
  }

  const noteId = note.id().toHex ? note.id().toHex() : String(note.id());
  const serial = "0x" + wordToBigInt(fresh.serialNum()).toString(16);

  const builder = await client.feeAwareTransactionRequestBuilder("0x" + from);
  const request = builder.withOwnOutputNotes(new NoteArray([note])).build();
  await client.transactions.submit("0x" + from, request);

  if (o.settle !== false) {
    await client.proveBlock();
    await client.sync();
  }

  let relayed = false;
  let relayError: string | undefined;
  if (o.relay !== false && priv) {
    try {
      await client.notes.sendPrivateOutput({ noteId: noteId as any, to: "0x" + to });
      relayed = true;
    } catch (e) {
      relayError = E(e);
    }
  }

  return { ...plan, noteId, serial, relayed, relayError, ms: performance.now() - t0 };
}

/**
 * Plan a batch without sending it — how spread out would `n` payments to this
 * receiver be? Useful for the demo's dial and for checking that blinding is not
 * accidentally degenerate at some k.
 */
export function planBatch(
  receiverId: string,
  n: number,
  opts: PlanOptions = {},
): EnvelopePlan[] {
  const out: EnvelopePlan[] = [];
  for (let i = 0; i < n; i++) out.push(planEnvelope(receiverId, opts));
  return out;
}
