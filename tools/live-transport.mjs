// Live probe of the Miden testnet note transport, over gRPC-Web + HTTP/1.1.
// No auth, no SDK, no keys: raw fetch() and a schemaless protobuf walk.
//
// Usage:
//   node tools/live-transport.mjs stats
//   node tools/live-transport.mjs fetch <tagHex> [tagHex...] [--full] [--raw]
//   node tools/live-transport.mjs sweep <count> [--base <tagHex>]
//   node tools/live-transport.mjs rpcstatus

const TRANSPORT = 'https://transport.testnet.miden.io';
const RPC = 'https://rpc.testnet.miden.io';
const SVC = 'miden.note_transport.v1.NoteTransportService';
const NODE = 'miden.node.v1.NodeService';

// ---------- schemaless protobuf ----------
function readVarint(b, i) {
  let r = 0n, s = 0n, p = i;
  for (;;) {
    if (p >= b.length) return null;
    const by = b[p++];
    r |= BigInt(by & 0x7f) << s;
    if ((by & 0x80) === 0) break;
    s += 7n;
    if (s > 70n) return null;
  }
  return { value: r, end: p };
}

function tryParse(b, depth, maxDepth = 14) {
  if (b.length === 0) return [];
  const out = [];
  let i = 0;
  while (i < b.length) {
    const key = readVarint(b, i);
    if (!key) return null;
    const fn = Number(key.value >> 3n), wt = Number(key.value & 7n);
    if (fn === 0 || fn > 536870911) return null;
    i = key.end;
    if (wt === 0) {
      const v = readVarint(b, i); if (!v) return null; i = v.end;
      out.push({ fn, kind: 'varint', value: v.value });
    } else if (wt === 1) {
      if (i + 8 > b.length) return null;
      const raw = b.subarray(i, i + 8); i += 8;
      let le = 0n; for (let k = 7; k >= 0; k--) le = (le << 8n) | BigInt(raw[k]);
      out.push({ fn, kind: 'fixed64', value: le, raw });
    } else if (wt === 5) {
      if (i + 4 > b.length) return null;
      const raw = b.subarray(i, i + 4); i += 4;
      out.push({ fn, kind: 'fixed32', value: raw.readUInt32LE(0), raw });
    } else if (wt === 2) {
      const len = readVarint(b, i); if (!len) return null; i = len.end;
      const n = Number(len.value);
      if (n < 0 || i + n > b.length) return null;
      const sub = b.subarray(i, i + n); i += n;
      out.push({ fn, kind: 'len', bytes: sub, len: n, nested: depth < maxDepth ? tryParse(sub, depth + 1, maxDepth) : null });
    } else return null;
  }
  return out;
}

// Field accessors over a parsed message.
const all = (fs, n) => fs.filter((f) => f.fn === n);
const one = (fs, n) => fs.find((f) => f.fn === n) || null;
const asMsg = (f) => (f && f.nested ? f.nested : null);
const hex = (b) => Buffer.from(b || []).toString('hex');

// Recursively collect every fixed64 under a field (account IDs are wrapped u128s).
function collectFixed64(fields) {
  const out = [];
  for (const f of fields || []) {
    if (f.kind === 'fixed64') out.push(hex(f.raw));
    else if (f.kind === 'len' && f.nested) out.push(...collectFixed64(f.nested));
  }
  return out;
}

function frames(buf) {
  const out = []; let o = 0;
  while (o + 5 <= buf.length) {
    const flags = buf[o], len = buf.readUInt32BE(o + 1); o += 5;
    if (o + len > buf.length) break;
    out.push({ flags, payload: buf.subarray(o, o + len) }); o += len;
  }
  return out;
}

// ---------- gRPC-Web call ----------
async function call(base, svc, method, msgBytes) {
  const body = Buffer.alloc(5 + msgBytes.length);
  body.writeUInt32BE(msgBytes.length, 1);
  Buffer.from(msgBytes).copy(body, 5);
  const res = await fetch(`${base}/${svc}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const gsHeader = res.headers.get('grpc-status');
  const fr = frames(buf);
  const trailers = fr.filter((f) => f.flags & 0x80).map((f) => f.payload.toString('latin1').trim());
  const msgs = fr.filter((f) => !(f.flags & 0x80)).map((f) => f.payload);
  const tmap = {};
  for (const t of trailers) for (const line of t.split(/\r?\n/)) {
    const k = line.indexOf(':'); if (k > 0) tmap[line.slice(0, k).trim()] = line.slice(k + 1).trim();
  }
  return {
    http: res.status,
    grpcStatus: gsHeader ?? tmap['grpc-status'] ?? null,
    grpcMessage: tmap['grpc-message'] ?? res.headers.get('grpc-message'),
    msgs,
    raw: buf,
  };
}

// ---------- FetchNotes ----------
function encodeTags(tags) {
  const parts = [];
  for (const t of tags) {
    const b = Buffer.alloc(5);
    b[0] = 0x0d; // field 1, wiretype 5 (fixed32)
    b.writeUInt32LE(t >>> 0, 1);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

async function fetchNotes(tags) {
  const r = await call(TRANSPORT, SVC, 'FetchNotes', encodeTags(tags));
  if (r.grpcStatus !== '0') return { ...r, notes: [], tip: null };
  const parsed = r.msgs.map((m) => tryParse(m, 0)).filter(Boolean)[0] || [];
  const notes = all(parsed, 1).map((f) => asMsg(f)).filter(Boolean).map(readNote);
  const tipF = asMsg(one(parsed, 4));
  const tip = tipF ? { hash: hex(one(tipF, 1)?.raw), block: Number(one(tipF, 2)?.value ?? 0n) } : null;
  return { ...r, notes, tip, topLevel: parsed };
}

// Note shape (calibrated empirically against live 0.18 responses):
//   TransportNote { header=1, details=2, seq/block=4 }
function readNote(nf) {
  const header = asMsg(one(nf, 1)) || [];
  const detailsF = one(nf, 2);
  const details = asMsg(detailsF);
  const seqF = asMsg(one(nf, 4));

  // header: { metadata=1, ... }
  const md = asMsg(one(header, 1)) || [];
  const senderParts = collectFixed64(asMsg(one(md, 2)));
  const sender = senderParts.length ? senderParts.join('') : null;

  const tagF = one(md, 4);
  const noteType = one(md, 3)?.value;
  const flagF1 = one(md, 1)?.value;

  return {
    headerBytes: (asMsg(one(nf, 1)) ? one(nf, 1).len : 0),
    detailsBytes: detailsF ? detailsF.len : 0,
    seq: seqF ? Number(one(seqF, 1)?.value ?? 0n) : null,
    sender,
    tag: tagF && tagF.kind === 'fixed32' ? '0x' + tagF.value.toString(16).padStart(8, '0') : null,
    noteType: noteType === undefined ? null : Number(noteType),
    mdField1: flagF1 === undefined ? null : Number(flagF1),
    detailsFields: details ? all(details, 1).length && details.map((f) => f.fn) : null,
    detailsHex: detailsF ? hex(detailsF.bytes) : null,
    headerHex: hex(one(nf, 1)?.bytes),
  };
}

// ---------- CLI ----------
const [cmd, ...rest] = process.argv.slice(2);
const FULL = rest.includes('--full');
const RAW = rest.includes('--raw');
const positional = rest.filter((a) => !a.startsWith('--'));

function tagOf(s) {
  if (/^0x/i.test(s)) return parseInt(s, 16);
  if (/^\d+$/.test(s)) return Number(s);
  throw new Error(`bad tag: ${s}`);
}

if (cmd === 'rpcstatus') {
  const r = await call(RPC, NODE, 'Status', Buffer.alloc(0));
  console.log(`grpc-status ${r.grpcStatus}`);
  for (const m of r.msgs) console.log(JSON.stringify(tryParse(m, 0), (k, v) => (typeof v === 'bigint' ? v.toString() : v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v), 1));
} else if (cmd === 'stats') {
  for (const meth of ['Stats', 'GetStats', 'StreamNotes', 'FetchNotes', 'SendNoteWithProof']) {
    const r = await call(TRANSPORT, SVC, meth, Buffer.alloc(0));
    console.log(`${meth.padEnd(18)} http ${r.http}  grpc-status ${String(r.grpcStatus).padEnd(4)} msglen ${r.msgs.reduce((a, m) => a + m.length, 0)}`);
  }
} else if (cmd === 'fetch') {
  const tags = positional.map(tagOf);
  const r = await fetchNotes(tags);
  console.log(`tags: ${tags.map((t) => '0x' + t.toString(16).padStart(8, '0')).join(' ')}`);
  console.log(`grpc-status ${r.grpcStatus}${r.grpcMessage ? ' msg=' + r.grpcMessage : ''}  rawbytes ${r.raw.length}`);
  console.log(`chain tip: block ${r.tip?.block}  hash ${r.tip?.hash}`);
  console.log(`notes returned: ${r.notes.length}`);
  const byType = {};
  for (const n of r.notes) byType[n.noteType] = (byType[n.noteType] || 0) + 1;
  console.log(`note types: ${JSON.stringify(byType)}`);
  const withDetails = r.notes.filter((n) => n.detailsBytes > 0);
  console.log(`notes carrying details: ${withDetails.length}/${r.notes.length}`);
  const senders = [...new Set(r.notes.map((n) => n.sender).filter(Boolean))];
  console.log(`distinct senders: ${senders.length}`);
  for (const n of r.notes.slice(0, FULL ? 999 : 4)) {
    console.log(`\n  seq=${n.seq} type=${n.noteType} tag=${n.tag} md1=${n.mdField1}`);
    console.log(`    sender=${n.sender}`);
    console.log(`    header=${n.headerBytes}B details=${n.detailsBytes}B`);
    if (RAW || FULL) {
      console.log(`    detailsHex=${n.detailsHex}`);
      const d = tryParse(Buffer.from(n.detailsHex, 'hex'), 0);
      console.log('    detailsTree:\n' + render(d, 3));
    }
  }
} else if (cmd === 'sweep') {
  const count = Number(positional[0] || 8);
  const baseIdx = rest.indexOf('--base');
  const base = baseIdx >= 0 ? tagOf(rest[baseIdx + 1]) : 0x89380000;
  console.log(`sweeping ${count} tags from base 0x${base.toString(16)}`);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const tag = (base + (i << 18)) >>> 0;
    const r = await fetchNotes([tag]);
    const d = r.notes.filter((n) => n.detailsBytes > 0).length;
    total += r.notes.length;
    console.log(`  0x${tag.toString(16).padStart(8, '0')} gs=${r.grpcStatus} notes=${String(r.notes.length).padStart(4)} withDetails=${String(d).padStart(4)} bytes=${r.raw.length}`);
  }
  console.log(`TOTAL notes across ${count} tags: ${total}`);
} else if (cmd === 'hunt') {
  // Enumerate the default-shaped tag space (k << 18, k in 0..16383) in
  // 128-tag batches and tally what the transport hands back.
  const batches = Number(positional[0] || 1);
  const startK = positional[1] !== undefined ? Number(positional[1]) : 0;
  const BATCH = 128;
  const typeTally = {};
  const pairTally = {};
  let totalNotes = 0, totalBytes = 0, batchesCapped = 0;
  const privateOnes = [];
  for (let b = 0; b < batches; b++) {
    const tags = [];
    for (let j = 0; j < BATCH; j++) {
      const k = startK + b * BATCH + j;
      if (k > 16383) break;
      tags.push((k << 18) >>> 0);
    }
    if (!tags.length) break;
    const r = await fetchNotes(tags);
    totalBytes += r.raw.length;
    totalNotes += r.notes.length;
    if (r.notes.length >= 500) batchesCapped++;
    for (const n of r.notes) {
      typeTally[n.noteType] = (typeTally[n.noteType] || 0) + 1;
      const p = `f1=${n.mdField1} f3=${n.noteType}`;
      pairTally[p] = (pairTally[p] || 0) + 1;
      if (n.noteType === 0 || n.mdField1 === 0) privateOnes.push(n);
    }
    console.log(`  batch ${String(b).padStart(3)} k=${String(startK + b * BATCH).padStart(5)}..${String(startK + b * BATCH + tags.length - 1).padEnd(5)} gs=${r.grpcStatus} notes=${String(r.notes.length).padStart(4)} bytes=${String(r.raw.length).padStart(8)} tip=${r.tip?.block}`);
  }
  console.log(`\nTOTAL notes: ${totalNotes}   response bytes: ${totalBytes}   batches hitting the 500-note cap: ${batchesCapped}`);
  console.log(`note-type tally (metadata f3): ${JSON.stringify(typeTally)}`);
  console.log(`(f1,f3) pair tally:            ${JSON.stringify(pairTally)}`);
  console.log(`notes with a zero in f1 or f3: ${privateOnes.length}`);
  for (const n of privateOnes.slice(0, 5)) {
    console.log(`  PRIVATE-CANDIDATE type=${n.noteType} f1=${n.mdField1} tag=${n.tag} seq=${n.seq} details=${n.detailsBytes}B sender=${n.sender}`);
  }
} else if (cmd === 'rand') {
  // Sample arbitrary u32 tags (including non-default-shaped ones) hunting for
  // noteType=0. Deterministic xorshift so a run is reproducible.
  const batches = Number(positional[0] || 10);
  let seed = (positional[1] !== undefined ? Number(positional[1]) : 20261022) >>> 0 || 1;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
  const typeTally = {};
  let totalNotes = 0, totalBytes = 0, tagsTried = 0;
  const hits = [];
  for (let b = 0; b < batches; b++) {
    const tags = [];
    for (let j = 0; j < 128; j++) tags.push(rnd());
    tagsTried += tags.length;
    const r = await fetchNotes(tags);
    totalBytes += r.raw.length;
    totalNotes += r.notes.length;
    for (const n of r.notes) {
      typeTally[n.noteType] = (typeTally[n.noteType] || 0) + 1;
      if (n.noteType !== 1) hits.push(n);
    }
    console.log(`  batch ${String(b).padStart(3)} gs=${r.grpcStatus} notes=${String(r.notes.length).padStart(4)} bytes=${String(r.raw.length).padStart(8)} tip=${r.tip?.block}`);
  }
  console.log(`\nRANDOM SAMPLE: ${tagsTried} tags -> ${totalNotes} notes, ${totalBytes} bytes`);
  console.log(`note-type tally: ${JSON.stringify(typeTally)}`);
  console.log(`non-public notes: ${hits.length}`);
  for (const n of hits.slice(0, 8)) {
    console.log(`  type=${n.noteType} tag=${n.tag} seq=${n.seq} details=${n.detailsBytes}B sender=${n.sender}`);
  }
} else if (cmd === 'scan') {
  // Query one tag at a time across a k range to find note-heavy tags and see
  // how seq ordering behaves under the 500-note response cap.
  const kStart = Number(positional[0] ?? 12032);
  const kEnd = Number(positional[1] ?? 12159);
  const rows = [];
  for (let k = kStart; k <= kEnd; k++) {
    const tag = (k << 18) >>> 0;
    const r = await fetchNotes([tag]);
    if (!r.notes.length) continue;
    const seqs = r.notes.map((n) => n.seq).filter((x) => x != null).sort((a, b) => a - b);
    rows.push({ k, tag, n: r.notes.length, min: seqs[0], max: seqs[seqs.length - 1], capped: r.notes.length >= 500 });
  }
  rows.sort((a, b) => b.n - a.n);
  console.log(`tags with notes in k=${kStart}..${kEnd}: ${rows.length}`);
  console.log('  top 15 by note count:');
  for (const r of rows.slice(0, 15)) {
    console.log(`   k=${String(r.k).padStart(5)} tag=0x${r.tag.toString(16).padStart(8, '0')} notes=${String(r.n).padStart(4)}${r.capped ? ' CAPPED' : '      '} seq ${r.min}..${r.max}`);
  }
  const total = rows.reduce((a, r) => a + r.n, 0);
  console.log(`  total notes across these tags (uncapped, per-tag): ${total}`);
  console.log(`  capped tags: ${rows.filter((r) => r.capped).length}`);
} else {
  console.log('see header comment for usage');
}

function render(fields, indent) {
  if (!fields) return '';
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const f of fields) {
    if (f.kind === 'varint') lines.push(`${pad}f${f.fn} varint ${f.value}`);
    else if (f.kind === 'fixed64') lines.push(`${pad}f${f.fn} fixed64 0x${f.value.toString(16).padStart(16, '0')}`);
    else if (f.kind === 'fixed32') lines.push(`${pad}f${f.fn} fixed32 0x${f.value.toString(16).padStart(8, '0')}`);
    else if (f.nested && f.nested.length) { lines.push(`${pad}f${f.fn} msg(${f.len}B) {`); lines.push(render(f.nested, indent + 1)); lines.push(`${pad}}`); }
    else {
      const s = Buffer.from(f.bytes).toString('latin1');
      const pr = (s.match(/[\x20-\x7e]/g) || []).length / Math.max(1, s.length) > 0.75 ? ` "${s.replace(/[^\x20-\x7e]/g, '.')}"` : '';
      lines.push(`${pad}f${f.fn} bytes(${f.len}B) ${hex(f.bytes)}${pr}`);
    }
  }
  return lines.join('\n');
}
