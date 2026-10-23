/**
 * demo · a faithful in-memory stand-in for `@miden-sdk/miden-sdk`
 *
 * The SDK is a WASM binary with no Windows build, so on this machine the send and
 * fetch paths of the library cannot run against it. This module implements exactly
 * the surface `send.ts` and `fetch.ts` touch — nothing more — over an in-memory
 * chain, so the *library* code under test is real and only the chain is simulated.
 *
 * Vite swaps it in with `pnpm dev:mock`, which aliases `@miden-sdk/miden-sdk` to
 * this file. Nothing else in the repository imports it.
 *
 * What it models, and deliberately all of it:
 *   • a chain store of submitted notes, each with the tag it was filed under
 *   • a per-client registered tag set; `sync()` copies matching notes into the store
 *   • `notes.list()` returning what the store holds
 *   • `sendPrivateOutput` marking a note relayed
 *
 * What it does NOT model: proofs, state, assets moving, consensus. Notes are
 * recorded, not executed.
 */

let noteSeq = 0;
let serialSeq = 1n;

/** The in-memory chain. Module-global so every client sees the same notes. */
export interface ChainNote {
  id: string;
  tag: number;
  sender: string;
  serial: bigint;
  relayed: boolean;
}
const CHAIN: ChainNote[] = [];

/** Wipe the chain, for a fresh run of the demo. */
export function resetChain(): void {
  CHAIN.length = 0;
  noteSeq = 0;
  serialSeq = 1n;
}

/** How many notes are on the chain right now. */
export function chainSize(): number {
  return CHAIN.length;
}

export class AccountId {
  constructor(public hex: string) {}
  static fromHex(hex: string): AccountId {
    return new AccountId(hex);
  }
  toString(): string {
    return this.hex;
  }
}

export class NoteTag {
  constructor(private readonly u: number) {}
  asU32(): number {
    return this.u >>> 0;
  }
}

export const NoteType = { Private: "private", Public: "public" } as const;

export class NoteMetadata {
  private readonly t: NoteTag;
  constructor(
    public sender: AccountId,
    public noteType: string,
    tag: NoteTag,
  ) {
    this.t = tag;
  }
  tag(): NoteTag {
    return this.t;
  }
}

export class NoteRecipient {
  constructor(
    private readonly s: bigint,
    private readonly sc: string,
    private readonly st: string,
  ) {}
  static fromScript(script: string, storage: string): NoteRecipient {
    serialSeq += 7919n;
    return new NoteRecipient((serialSeq * 2654435761n) % (1n << 64n), script, storage);
  }
  serialNum(): bigint {
    return this.s;
  }
  script(): string {
    return this.sc;
  }
  storage(): string {
    return this.st;
  }
}

export class Note {
  readonly idHex: string;
  constructor(
    private readonly assetsV: unknown[],
    private readonly md: NoteMetadata,
    private readonly rec: NoteRecipient,
    private readonly att: unknown,
  ) {
    this.idHex = "0x" + (++noteSeq).toString(16).padStart(64, "0");
  }
  static withAttachments(
    assets: unknown[],
    md: NoteMetadata,
    rec: NoteRecipient,
    att: unknown,
  ): Note {
    return new Note(assets, md, rec, att);
  }
  metadata(): NoteMetadata {
    return this.md;
  }
  recipient(): NoteRecipient {
    return this.rec;
  }
  assets(): unknown[] {
    return this.assetsV;
  }
  attachments(): unknown {
    return this.att;
  }
  id(): { toHex(): string } {
    return { toHex: () => this.idHex };
  }
}

export class NoteArray {
  constructor(public items: Note[]) {}
}

export function wordToBigInt(word: bigint): bigint {
  return word;
}

/**
 * A P2ID note as the SDK would build it. The tag here is a placeholder: `send.ts`
 * discards it and rebuilds the note with the blinded one, which is the whole point.
 */
export function createP2IDNote(o: {
  from: string;
  to: string;
  assets: { token: string; amount: bigint }[];
  type: string;
}): Note {
  return new Note(
    o.assets,
    new NoteMetadata(AccountId.fromHex(o.from), o.type, new NoteTag(0)),
    NoteRecipient.fromScript("p2id", "[]"),
    { to: o.to },
  );
}

interface PendingRequest {
  notes: Note[];
}

export class MockClient {
  readonly registered = new Set<number>();
  readonly store = new Map<string, ChainNote>();

  tags = {
    add: async (tag: number): Promise<void> => {
      this.registered.add(tag >>> 0);
    },
    remove: async (tag: number): Promise<void> => {
      this.registered.delete(tag >>> 0);
    },
  };

  transactions = {
    submit: async (_from: string, req: PendingRequest): Promise<void> => {
      for (const n of req.notes) {
        CHAIN.push({
          id: n.idHex,
          tag: n.metadata().tag().asU32(),
          sender: n.metadata().sender.hex,
          serial: n.recipient().serialNum(),
          relayed: false,
        });
      }
    },
  };

  feeAwareTransactionRequestBuilder = async (_from: string) => ({
    withOwnOutputNotes: (arr: NoteArray) => ({
      build: (): PendingRequest => ({ notes: arr.items }),
    }),
  });

  proveBlock = async (): Promise<void> => {};

  sync = async (): Promise<void> => {
    for (const n of CHAIN) if (this.registered.has(n.tag)) this.store.set(n.id, n);
  };

  notes = {
    list: async (): Promise<{ id(): { toHex(): string } }[]> =>
      Array.from(this.store.values()).map((n) => ({ id: () => ({ toHex: () => n.id }) })),
    sendPrivateOutput: async (o: { noteId: string; to: string }): Promise<void> => {
      const n = CHAIN.find((c) => c.id === o.noteId);
      if (n) n.relayed = true;
    },
  };
}
