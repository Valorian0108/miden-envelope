# v3 — Live note-transport reconnaissance (testnet, 2026-10-22)

All measurements below were taken against the **real deployed testnet transport** on
2026-10-22, with no keys, no account, no authentication and no SDK — raw `fetch()` and a
schemaless protobuf walk. Tooling: `tools/live-transport.mjs`, `tools/pb-dump.mjs`,
`tools/cursor-probe.mjs`. Raw captures in `capture/live/`.

Chain tip advanced 31747 → 31756 across the session, so the chain was live throughout.

---

## 1. Transport is reachable from plain HTTP/1.1

`GET https://transport.testnet.miden.io/` →

```
HTTP 200
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: *
Grpc-Status: 12
Content-Type: application/grpc
Content-Length: 0
```

CORS is fully open, so **a browser page can call the transport directly** — no proxy, no
backend. The demo can therefore show real network traffic, not a mock.

`application/grpc-web+proto` over HTTP/1.1 works. HTTP/2 is not required. (PowerShell 5.1
cannot do HTTP/2, which is why gRPC-Web was the route; Node `fetch` has no CORS at all.)

Request framing: `00` + big-endian u32 length + protobuf message. Response: same framing,
plus a trailing frame with flag `0x80` carrying `grpc-status:N`.

## 2. Deployed method surface vs. documented surface

Service FQN confirmed from the WASM binary and by routing behaviour:
`miden.note_transport.v1.NoteTransportService`

| Method | Documented | Live grpc-status | Verdict |
|---|---|---|---|
| `FetchNotes` | yes | **0 OK** | implemented |
| `SendNoteWithProof` | yes | **3 INVALID_ARGUMENT** (on empty) | implemented, validates |
| `Stats` | yes (`total_notes`, `total_tags`) | **12 UNIMPLEMENTED** | **not deployed** |
| `StreamNotes` | yes (single tag, 500 ms poll) | **12 UNIMPLEMENTED** | **not deployed** |
| `GetStats` | (guess) | 12 UNIMPLEMENTED | absent |

`Stats` never appears in the client WASM either (0 hits; `FetchNotes` 30 hits), so the
absence is consistent across client and server. **`total_notes` / `total_tags` cannot be
read from the service** — §4 measures the equivalent directly instead.

Control: `miden.node.v1.NodeService/Status` on `https://rpc.testnet.miden.io` → grpc-status 0,
decodes to version `0.18.0`, state `connected`. So the RPC node speaks gRPC-Web too.

## 3. `FetchNotesRequest` — the documented proto is wrong for 0.18

Documented shape: `{ repeated fixed32 tags = 1; fixed64 cursor = 2; }`

Measured:

| Encoding tried | grpc-status | Meaning |
|---|---|---|
| `tags` as `repeated fixed32` (field 1, wt 5) | **0** | ✅ correct |
| `tags` as packed varint | 13 INTERNAL | ✗ |
| `tags` as unpacked varint | 13 INTERNAL | ✗ |
| field 2 as `fixed64` (the documented cursor) | **13 INTERNAL** | ✗ not fixed64 |
| field 2 as varint | 13 INTERNAL | ✗ |
| field 2 as empty message | **9 FAILED_PRECONDITION** | parsed, then rejected semantically |
| field 2 = `msg{ f1 fixed64 = 0 }` | 9 FAILED_PRECONDITION | ✗ |
| field 2 = `msg{ f1 fixed64 = note seq }` | 9 FAILED_PRECONDITION | ✗ |
| field 2 = `msg{ f1 fixed64 = block number }` | 9 FAILED_PRECONDITION | ✗ |
| **field 2 = `msg{ f1 fixed64 = <current tip hash> }`** | **0 OK** | ✅ |
| field 2 omitted entirely | **0 OK** | ✅ |

Field 2 is a **chain-tip assertion**, not a cursor. It is optional; when present it must
equal the tip hash that the response itself returns in its own field 2. There is **no offset,
no page token, no pagination parameter of any kind** in the deployed request.

Response shape (measured):

```
FetchNotesResponse {
  1: repeated TransportNote {      // 338 B each in the samples
       1: header  { 1: metadata { 1: varint, 2: AccountId(u128 as 2×fixed64),
                                  3: note_type, 4: fixed32 tag, 5: 16 B, 6: {32 B hash} },
                    2: {32 B hash} }
       2: details { 1: {… assets …}, 2: {… recipient, attachment, serial …} }
       4: { 1: fixed32 seq }        // transport-side SQLite sequence
     }
  2: { 1: fixed64 tipHash }         // the value field 2 of the request must echo
  4: { 1: fixed64 tipHash, 2: fixed64 blockNumber }
}
```

An empty request returns **zero notes** plus the tip: 31 bytes, block 31748, hash
`ad655aa337439c57`. That is the baseline every other measurement is compared against.

## 4. The whole default-shaped tag space is enumerable in 128 requests

Default-shaped tags are `k << 18` for `k` in `0..16383` (low 18 bits zero). That is the
entire space the chain shares between accounts — 2^14 = 16,384 tags — and the per-request
limit is 128 tags, so **128 requests cover 100% of it**.

`hunt 128` (128 sequential POSTs, no auth):

```
TOTAL notes: 31,287        response bytes: 10,747,995
batches hitting the 500-note cap: 1
note-type tally (metadata f3): {"1": 31287}
(f1,f3) pair tally:            {"f1=1 f3=1": 31287}
notes with a zero in f1 or f3: 0
```

Every note came back with **full details** (`detailsBytes = 199` on the sampled ones) and a
**readable sender account ID**. Example, five notes on tag `0x89380000`, four distinct senders:

```
seq=93067  type=1 tag=0x89380000 sender=00819f84eebe7a1011d79136504354a8  header=127B details=199B
seq=93408  type=1 tag=0x89380000 sender=000fa5b7e5e08667d19fdb0b3a85b46d  header=127B details=199B
seq=183217 type=1 tag=0x89380000 sender=0093e41adaa9b46851f8ab7b7b058742  header=127B details=199B
seq=183679 type=1 tag=0x89380000 sender=000fa5b7e5e08667d19fdb0b3a85b46d  header=127B details=199B
```

Note details include attachments in the clear — one sampled attachment's bytes begin with the
ASCII string `MASTER`.

## 5. Nothing lives outside the default-shaped space

| Query | Notes |
|---|---|
| `0x00000FEE` (the documented TX_FEE tag) | **0** |
| 2,560 random arbitrary u32 tags (20 × 128) | **0** (every reply was the 56-byte empty baseline) |

So fee notes are not in the transport, and the transport's entire contents sit in the
default-shaped tag space. Combined with §4, the transport is **fully drained** by 128 requests.

## 6. The 500-note cap serves the OLDEST notes, per request, with no way past it

Scanning the capped batch tag-by-tag (`scan 12032 12159`):

```
tags with notes: 84
 k=12108 tag=0xbd300000 notes= 500 CAPPED seq 64191..154316
 k=12130 tag=0xbd880000 notes=  25        seq 41669..172870
 k=12081 tag=0xbcc40000 notes=  13        seq 19801..449805
 k=12055 tag=0xbc5c0000 notes=   8        seq 26191..388298
 k=12115 tag=0xbd4c0000 notes=   7        seq 55943..448361
 total notes across these tags (per-tag queries): 752
 capped tags: 1
```

Two conclusions:

1. **Ordering is seq-ascending and truncation is from the newest end.** The capped tag's
   highest returned seq is 154,316 while sibling tags in the same batch return seqs up to
   449,805. Notes with a higher seq under `0xbd300000` are not returned, and because §3
   established there is no cursor, **they cannot be requested at all**. They only become
   reachable as older notes age out of retention (default 30 days).
2. **The cap is per-request, aggregating across all tags in it.** These 128 tags hold 752
   notes when queried one at a time, but returned exactly 500 as a single batched request.

Consequences:

- **Tag flooding is a denial-of-service on note delivery.** Any account can push notes at any
  tag. Once a tag passes 500 notes, that receiver's *newest* notes — including a payment just
  sent to them — are unreachable until retention prunes the backlog. The receiver cannot
  detect or bypass this.
- **A blinded tag pool makes truncation more likely, not less.** Querying a 128-tag pool in one
  request aggregates 128 tags' worth of traffic against a single 500-note budget. `miden-envelope`
  must fetch the pool in **small batches or per-tag**, never as one 128-tag request.
- If the SDK batches all tracked tags into one `FetchNotes`, this affects it directly: the
  Phase A harness registered 24 auto + 160 added = 184 tags on one client.

## 7. What this does and does not prove about `MIDEN-010`

**Not confirmed live:** no `noteType = 0` (Private) note was found anywhere — not in the full
16,384-tag default sweep (31,287 notes, all type 1), not at `0xFEE`, not in 2,560 random tags.
The live transport currently carries only public notes, whose details are on-chain anyway.
The likely cause is the SDK default: `send`/`mint` default `type` to **PUBLIC** unless
`NoteVisibility.Private` is passed explicitly.

So the private-content half of `MIDEN-010` rests on the **mock-transport** measurement from
v2 (Phase C: keyless observer read `noteType() = 0` and `amount 100n`). Nothing here
contradicts it, and nothing here upgrades it. **Confidence stays medium.**

**Newly confirmed live, and stronger than the mock evidence:**

- the transport is unauthenticated and fully enumerable — 128 requests for the whole space;
- sender account IDs and note details are readable by a keyless caller;
- `Stats`/`StreamNotes` are documented but not deployed;
- the documented `FetchNotesRequest` proto is wrong, and there is no pagination;
- the 500-note cap truncates newest-first and aggregates per request.

## 8. Reproducing

```
node tools/live-transport.mjs stats            # method availability table
node tools/live-transport.mjs rpcstatus        # NodeService/Status decode
node tools/live-transport.mjs fetch 0x89380000 --full
node tools/live-transport.mjs hunt 128         # full 16,384-tag sweep
node tools/live-transport.mjs rand 20          # 2,560 arbitrary tags
node tools/live-transport.mjs scan 12032 12159 # per-tag counts + seq ranges
node tools/cursor-probe.mjs                    # field-2 encoding sweep
node tools/pb-dump.mjs capture/live/fetchnotes-tag8938.bin
```

`hunt 128` transfers ~10.7 MB in 128 requests. Be deliberate about running it repeatedly
against a shared testnet.
