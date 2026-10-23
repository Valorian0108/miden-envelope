// One-off: find the real encoding of FetchNotesRequest field 2 (the documented
// `fixed64 cursor = 2` returns INTERNAL on deployed 0.18, and an empty
// length-delimited field 2 returns FAILED_PRECONDITION -> so it is a message).
// Try plausible inner shapes alongside a known-good fixed32 tag.

const T = 'https://transport.testnet.miden.io/miden.note_transport.v1.NoteTransportService';
const TAG = Buffer.from([0x0d, 0x00, 0x00, 0x38, 0x89]); // field1 fixed32 = 0x89380000

function u64le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function lenField(fn, inner) {
  const out = []; let x = inner.length;
  do { let b = x & 0x7f; x >>>= 7; if (x) b |= 0x80; out.push(b); } while (x);
  return Buffer.concat([Buffer.from([(fn << 3) | 2]), Buffer.from(out), inner]);
}
const f64 = (fn, v) => Buffer.concat([Buffer.from([(fn << 3) | 1]), u64le(v)]);
const fvi = (fn, v) => Buffer.concat([Buffer.from([(fn << 3) | 0]), Buffer.from([v & 0x7f])]);

const TIP = Buffer.from('ad655aa337439c57', 'hex'); // tip hash as it appeared on the wire

const cands = {
  'msg{f1 fixed64=0}':            lenField(2, f64(1, 0)),
  'msg{f1 fixed64=tipHash}':      lenField(2, Buffer.concat([Buffer.from([0x09]), TIP])),
  'msg{f1 fixed64=seq93067}':     lenField(2, f64(1, 93067)),
  'msg{f1 varint=0}':             lenField(2, fvi(1, 0)),
  'msg{f1 varint=1}':             lenField(2, fvi(1, 1)),
  'msg{f1 fixed64=block31756}':   lenField(2, f64(1, 31756)),
  'msg{f1 fixed64=0,f2 fixed64=0}': lenField(2, Buffer.concat([f64(1, 0), f64(2, 0)])),
  'msg{f2 fixed64=0}':            lenField(2, f64(2, 0)),
  'CONTROL no-field-2':           Buffer.alloc(0),
};

for (const [name, cur] of Object.entries(cands)) {
  const m = Buffer.concat([TAG, cur]);
  const body = Buffer.alloc(5 + m.length);
  body.writeUInt32BE(m.length, 1);
  m.copy(body, 5);
  try {
    const r = await fetch(`${T}/FetchNotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    let notes = 0, trailers = '';
    let i = 0;
    while (i + 5 <= buf.length) {
      const flags = buf[i], len = buf.readUInt32BE(i + 1); i += 5;
      const p = buf.subarray(i, i + len); i += len;
      if (flags & 0x80) trailers = p.toString('latin1').trim();
      else { // count top-level field-1 occurrences (notes)
        let j = 0;
        while (j < p.length) {
          let v = 0n, s = 0n;
          for (;;) { const b = p[j++]; v |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; }
          const fn = Number(v >> 3n), wt = Number(v & 7n);
          if (wt !== 2) break;
          let l2 = 0n; s = 0n;
          for (;;) { const b = p[j++]; l2 |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; }
          if (fn === 1) notes++;
          j += Number(l2);
        }
      }
    }
    console.log(`  ${name.padEnd(32)} http ${r.status} gs-hdr ${String(r.headers.get('grpc-status')).padEnd(5)} len ${String(buf.length).padStart(6)} notes~${String(notes).padStart(4)} ${trailers}`);
  } catch (e) {
    console.log(`  ${name.padEnd(32)} EXC ${e.message}`);
  }
}
