// Schemaless gRPC-Web / protobuf wire dumper.
// Usage: node tools/pb-dump.mjs <file.bin> [--max-depth N] [--full]
//
// Strips gRPC-Web framing, then walks the wire format with no .proto:
// we only know field numbers and wire types, so nested messages are
// detected heuristically (a length-delimited field is retried as a
// message and kept only if it parses cleanly end-to-end).

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const maxDepth = (() => {
  const i = args.indexOf('--max-depth');
  return i >= 0 ? Number(args[i + 1]) : 12;
})();
const FULL = args.includes('--full');
const HEXCHARS = 48;

const WT = { 0: 'varint', 1: 'fixed64', 2: 'len', 5: 'fixed32' };

function readVarint(b, i) {
  let result = 0n;
  let shift = 0n;
  let p = i;
  for (;;) {
    if (p >= b.length) return null;
    const byte = b[p++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) return null;
  }
  return { value: result, end: p };
}

// Parse a buffer as a protobuf message. Returns array of fields, or null if
// the bytes are not a well-formed message that consumes the whole buffer.
function tryParse(b, depth) {
  if (b.length === 0) return [];
  const out = [];
  let i = 0;
  while (i < b.length) {
    const key = readVarint(b, i);
    if (!key) return null;
    const fieldNum = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (fieldNum === 0 || fieldNum > 536870911) return null;
    i = key.end;
    if (wire === 0) {
      const v = readVarint(b, i);
      if (!v) return null;
      i = v.end;
      out.push({ fieldNum, wire, kind: 'varint', value: v.value });
    } else if (wire === 1) {
      if (i + 8 > b.length) return null;
      const raw = b.subarray(i, i + 8);
      i += 8;
      let le = 0n;
      for (let k = 7; k >= 0; k--) le = (le << 8n) | BigInt(raw[k]);
      out.push({ fieldNum, wire, kind: 'fixed64', value: le, raw });
    } else if (wire === 5) {
      if (i + 4 > b.length) return null;
      const raw = b.subarray(i, i + 4);
      i += 4;
      out.push({ fieldNum, wire, kind: 'fixed32', value: raw.readUInt32LE(0), raw });
    } else if (wire === 2) {
      const len = readVarint(b, i);
      if (!len) return null;
      i = len.end;
      const n = Number(len.value);
      if (n < 0 || i + n > b.length) return null;
      const sub = b.subarray(i, i + n);
      i += n;
      const nested = depth < maxDepth ? tryParse(sub, depth + 1) : null;
      out.push({ fieldNum, wire, kind: 'len', bytes: sub, nested, len: n });
    } else {
      return null; // groups / unknown wire types
    }
  }
  return out;
}

function hex(b, limit = HEXCHARS) {
  const s = Buffer.from(b).toString('hex');
  return FULL || s.length <= limit * 2 ? s : s.slice(0, limit * 2) + `…(${b.length}B)`;
}

function printable(b) {
  const s = Buffer.from(b).toString('latin1');
  const clean = s.replace(/[^\x20-\x7e]/g, '.');
  const ratio = (s.match(/[\x20-\x7e]/g) || []).length / Math.max(1, s.length);
  return ratio > 0.75 ? `  "${FULL || clean.length <= 64 ? clean : clean.slice(0, 64) + '…'}"` : '';
}

function walk(fields, indent, depth) {
  const lines = [];
  for (const f of fields) {
    const pad = '  '.repeat(indent);
    if (f.kind === 'varint') {
      const v = f.value;
      const extra = v > 0n && v < 0x100000000n ? ` (u32 0x${v.toString(16)})` : '';
      lines.push(`${pad}f${f.fieldNum} varint = ${v}${extra}`);
    } else if (f.kind === 'fixed64') {
      lines.push(`${pad}f${f.fieldNum} fixed64 = 0x${f.value.toString(16).padStart(16, '0')} (${f.value})`);
    } else if (f.kind === 'fixed32') {
      lines.push(`${pad}f${f.fieldNum} fixed32 = 0x${f.value.toString(16).padStart(8, '0')} (${f.value})`);
    } else {
      const asMsg = f.nested && f.nested.length > 0;
      if (asMsg) {
        lines.push(`${pad}f${f.fieldNum} msg (${f.len}B) {`);
        lines.push(...walk(f.nested, indent + 1, depth + 1));
        lines.push(`${pad}}`);
      } else {
        lines.push(`${pad}f${f.fieldNum} bytes (${f.len}B) = ${hex(f.bytes)}${printable(f.bytes)}`);
        if (f.nested && f.nested.length === 0) lines.push(`${pad}  (empty)`);
      }
    }
  }
  return lines;
}

const buf = readFileSync(file);
console.log(`# ${file}  (${buf.length} bytes)`);

let offset = 0;
let idx = 0;
while (offset + 5 <= buf.length) {
  const flags = buf[offset];
  const len = buf.readUInt32BE(offset + 1);
  offset += 5;
  if (offset + len > buf.length) {
    console.log(`! truncated frame at ${offset}`);
    break;
  }
  const payload = buf.subarray(offset, offset + len);
  offset += len;
  if (flags & 0x80) {
    console.log(`\n## trailer frame: ${JSON.stringify(payload.toString('latin1').trim())}`);
  } else {
    console.log(`\n## message frame #${++idx} (${len}B)`);
    const parsed = tryParse(payload, 0);
    if (!parsed) console.log('  ! not valid protobuf: ' + hex(payload, 120));
    else if (parsed.length === 0) console.log('  (empty message)');
    else console.log(walk(parsed, 1, 1).join('\n'));
  }
}
if (offset < buf.length) console.log(`\n! ${buf.length - offset} trailing bytes`);
