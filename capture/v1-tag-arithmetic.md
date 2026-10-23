# Harness v1 — note-tag arithmetic (measured 2026-10-22)

Mock chain (`MidenClient.createMock()`), browser WASM build of
`@miden-sdk/miden-sdk` 0.17.6. 24 freshly generated account ids.
Raw output preserved below; nothing here is inferred from docs.

## [1a] A tag is an arbitrary, unvalidated u32

```
new NoteTag(0x00000000).asU32() = 0x00000000
new NoteTag(0x00000fee).asU32() = 0x00000fee
new NoteTag(0xffffffff).asU32() = 0xffffffff
new NoteTag(0x12345678).asU32() = 0x12345678
new NoteTag(0xdeadbeef).asU32() = 0xdeadbeef
```

All round-trip exactly, including values that are not default-shaped. The
client performs no validation of a caller-supplied tag.

## [1b] The default tag is a 14-bit receiver fingerprint

24/24 default tags have the **low 18 bits zero**, and 24/24 are distinct
across 24 accounts. The default tag uniquely identifies the receiver.

```
id 0xe8d27ce3b26c8f011cd0b7c9c6ca4f → tag 0xe8d00000  11101000110100000000000000000000
id 0x14ec…                          → tag 0x14ec0000  00010100111011000000000000000000
id 0x1f80…                          → tag 0x1f800000  00011111100000000000000000000000
id 0x3858…                          → tag 0x38580000  00111000010110000000000000000000
```

Payload is 32 − 18 = **14 bits**, so the whole chain shares 2^14 = 16,384
possible default-shaped tags.

## [1c] `withCustomAccountTarget(id, tag_len)` is a working anonymity dial

Distinct tags across the same 24 accounts, by `tag_len`:

| tag_len | distinct | ratio | sample (id[0]) |
|---|---|---|---|
| 1 | 2 | 0.08 | `0x80000000` |
| 2 | 4 | 0.17 | `0xc0000000` |
| 3 | 8 | 0.33 | `0xe0000000` |
| 4 | 12 | 0.50 | `0xe0000000` |
| 5 | 15 | 0.63 | `0xe8000000` |
| 6 | 21 | 0.88 | `0xe8000000` |
| 7 | 23 | 0.96 | `0xe8000000` |
| 8 | 23 | 0.96 | `0xe8000000` |
| 9–32 | 24 | 1.00 | `0xe8800000` … `0xe8d27ce3` |

At `tag_len` 9 and above every account is already distinguishable. The useful
privacy range is roughly 1–8.

## Model, derived and checked by hand against the samples

```
tag(id, k) = (top k bits of the 120-bit account id) << (32 - k)
```

| k | top-k bits of `0xe8d27ce3…` | predicted | observed |
|---|---|---|---|
| 1 | `1` | `0x80000000` | `0x80000000` |
| 2 | `11` | `0xc0000000` | `0xc0000000` |
| 3 | `111` | `0xe0000000` | `0xe0000000` |
| 5 | `11101` = 29 | `0xe8000000` | `0xe8000000` |
| 14 | `11101000110100` = 14900 | `0xe8d00000` | `0xe8d00000` |

The default (`withAccountTarget`) is exactly `k = 14`.

## [1d] Shape vs. distribution — the important nuance

`tag_len ≤ 14` keeps the low 18 bits zero, so a coarse tag is
**default-shaped**: bit-for-bit a legal tag. `tag_len ≥ 15` does not, and
produces tags no default sender would ever emit.

But default-*shaped* is not default-*distributed*. A zero-filled coarse tag
has its low payload bits all zero, which happens with probability
2^−(14−k) for a genuine default tag. Against a default-dominated population a
coarse tag is therefore **detectable as a deviation** — the receiver is still
hidden to k bits, but the sender has revealed that it opted out.

This is the uniformity problem stated quantitatively, and it is what the
random-fill construction in harness v2 exists to solve.

## [1e] `client.tags`

Methods: `add`, `remove`, `list`. Creating an account **auto-registers its
tag** — a fresh client that created 24 accounts already tracks 24 tags.
`add` / `remove` both work.

## Phase 2 — envelope of a real private note

Mock chain, faucet → alice → bob, `type: NoteVisibility.Private`,
`returnNote: true`.

```
note.id()             = 0xc255202e55b1484145c3d66f3c5e0de125c3a43ea74df5b7fa1b7b47b5b38c98
metadata.sender()     = 0xa420bf80b17725010454ccda6a0201   ← alice, in full
metadata.noteType()   = 0                                  ← NoteType.Private = 0
metadata.tag()        = 0xf2300000                         ← bob's DEFAULT tag exactly
note.attachments()    = [1]
notes.listSent()      = 2   (mint + send; no fee note → mock base fee is zero)
```

Two things worth flagging:

1. The tag equals bob's default tag, so **the receiver is pinned to 14 bits of
   its account id** by an ordinary private send.
2. `metadata.sender()` returns alice's **full account id**. The SDK's own doc
   comment on the header accessor reads *"Returns the note sender, even when
   only header metadata is available."* Meanwhile the `NoteType` enum says a
   Private note has *"only their hash published to the network."*

   Those two statements cannot both be true. Whether the sender is actually
   public is the question harness v2 Phase C settles with keyless observers.

## Confirmed absent

`NoteMetadata` exposes only `sender`, `noteType`, `tag` — no `attachments()`,
no `aux()`. `NoteOptions` (`createP2IDNote`) and `SendOptions`
(`transactions.send`) have **no tag field**, so a custom tag is unreachable
through the high-level API and needs
`Note.withAttachments(assets, metadata, recipient, attachments)` plus
`TransactionRequestBuilder.withOwnOutputNotes`.
