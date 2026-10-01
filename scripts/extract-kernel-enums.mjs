// Regenerate resources/kernel-enums.json from an AOS metadata assembly.
//
// The built-in enums ship as `AxEnum_<Name>.xml` documents embedded in
// Microsoft.Dynamics.AX.Metadata.dll (namespace
// Microsoft.Dynamics.AX.Metadata.Static.Models.AxEnum). This script walks
// PE -> CLI -> ManifestResource to pull them out, so the data can be refreshed
// whenever a new AOS build is available - the extension itself carries the
// resulting JSON and never needs the assembly at runtime.
//
//   node scripts/extract-kernel-enums.mjs <path to AOS bin folder or the dll>
//   node scripts/extract-kernel-enums.mjs "C:\Program Files\Microsoft Dynamics 365\FO\7.0.7036.7422\AosService\bin"
//
// Omitting the path writes the file back unchanged (a no-op check of the reader).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DLL = 'Microsoft.Dynamics.AX.Metadata.dll';
const OUT = path.join(__dirname, '..', 'resources', 'kernel-enums.json');
const RESOURCE = /\.Static\.Models\.AxEnum\.AxEnum_.+\.xml$/i;

function findDll(target) {
  if (!fs.statSync(target).isDirectory()) {
    return target;
  }
  for (const c of [target, path.join(target, 'bin'), path.join(target, 'WebRoot', 'bin')]) {
    const p = path.join(c, DLL);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  throw new Error(`no ${DLL} under ${target}`);
}

/** PE -> CLI header -> metadata streams. */
function readCli(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('not PE\\');
  const coff = peOff + 4;
  const opt = coff + 20;
  const optSize = buf.readUInt16LE(coff + 16);
  const plus = buf.readUInt16LE(opt) === 0x20b;
  const cliRva = buf.readUInt32LE(opt + (plus ? 112 : 96) + 14 * 8);
  if (!cliRva) throw new Error('not a managed assembly');
  const secOff = opt + optSize;
  const secs = [];
  for (let i = 0, n = buf.readUInt16LE(coff + 2); i < n; i++) {
    const s = secOff + i * 40;
    secs.push({
      vsize: buf.readUInt32LE(s + 8),
      vaddr: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      raw: buf.readUInt32LE(s + 20),
    });
  }
  const toOff = (rva) => {
    for (const s of secs) {
      if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) return s.raw + (rva - s.vaddr);
    }
    return rva;
  };
  const cli = toOff(cliRva);
  const md = toOff(buf.readUInt32LE(cli + 8));
  if (buf.readUInt32LE(md) !== 0x424a5342) throw new Error('bad metadata signature');
  const versionLen = buf.readUInt32LE(md + 12);
  let p = md + 16 + ((versionLen + 3) & ~3) + 2;
  const n = buf.readUInt16LE(p);
  p += 2;
  const streams = {};
  for (let i = 0; i < n; i++) {
    const off = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    p += 8;
    let e = p;
    while (buf[e] !== 0) e++;
    streams[buf.toString('latin1', p, e)] = { off: md + off, size };
    p = (e + 1 + 3) & ~3;
  }
  const tbl = streams['#~'] || streams['#-'];
  const strHeap = streams['#Strings'];
  if (!tbl || !strHeap) throw new Error('no table or strings heap');

  const heap = buf.readUInt8(tbl.off + 6);
  const strW = (heap & 1) !== 0, guidW = (heap & 2) !== 0, blobW = (heap & 4) !== 0;
  const valid = buf.readBigUInt64LE(tbl.off + 8);
  const rows = new Array(64).fill(0);
  let q = tbl.off + 24;
  for (let t = 0; t < 64; t++) {
    if (((valid >> BigInt(t)) & 1n) === 1n) { rows[t] = buf.readUInt32LE(q); q += 4; }
  }
  const s = () => (strW ? 4 : 2);
  const g = () => (guidW ? 4 : 2);
  const b = () => (blobW ? 4 : 2);
  const ti = (t) => (rows[t] < 0x10000 ? 2 : 4);
  const coded = {};
  const cw = (n) => {
    const [bits, list] = coded[n];
    let max = 0;
    for (const t of list) if (t >= 0 && rows[t] > max) max = rows[t];
    return max < 1 << (16 - bits) ? 2 : 4;
  };
  Object.assign(coded, {
    TypeDefOrRef: [2, [0x02, 0x01, 0x1b]],
    HasConstant: [2, [0x04, 0x08, 0x17]],
    HasCustomAttribute: [5, [0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14,
      0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b]],
    HasFieldMarshal: [1, [0x04, 0x08]],
    HasDeclSecurity: [2, [0x02, 0x06, 0x20]],
    MemberRefParent: [3, [0x02, 0x01, 0x1a, 0x06, 0x1b]],
    HasSemantics: [1, [0x14, 0x17]],
    MethodDefOrRef: [1, [0x06, 0x0a]],
    MemberForwarded: [1, [0x04, 0x06]],
    Implementation: [2, [0x26, 0x23, 0x27]],
    CustomAttributeType: [3, [-1, -1, 0x06, 0x0a, -1]],
    ResolutionScope: [2, [0x00, 0x1a, 0x23, 0x01]],
    TypeOrMethodDef: [1, [0x02, 0x06]],
  });
  const size = new Array(64).fill(0);
  const S = {
    0x00: 2 + s() + g() * 3, 0x01: cw('ResolutionScope') + s() * 2,
    0x02: 4 + s() * 2 + cw('TypeDefOrRef') + ti(0x04) + ti(0x06), 0x04: 2 + s() + b(),
    0x06: 4 + 4 + s() + b() + ti(0x08), 0x08: 4 + s(), 0x09: ti(0x02) + cw('TypeDefOrRef'),
    0x0a: cw('MemberRefParent') + s() + b(), 0x0b: 2 + cw('HasConstant') + b(),
    0x0c: cw('HasCustomAttribute') + cw('CustomAttributeType') + b(), 0x0d: cw('HasFieldMarshal') + b(),
    0x0e: 2 + cw('HasDeclSecurity') + b(), 0x0f: 6 + ti(0x02), 0x10: 4 + ti(0x04),
    0x11: b(), 0x12: ti(0x02) + ti(0x14), 0x13: ti(0x14), 0x14: 2 + s() + cw('TypeDefOrRef'),
    0x15: ti(0x02) + ti(0x17), 0x16: ti(0x17), 0x17: 2 + s() + b(),
    0x18: 2 + ti(0x06) + cw('HasSemantics'), 0x19: ti(0x02) + cw('MethodDefOrRef') * 2,
    0x1a: s(), 0x1b: b(), 0x1c: 2 + cw('MemberForwarded') + s() + ti(0x1a), 0x1d: 4 + ti(0x04),
    0x20: 16 + b() + s() + s(), 0x21: 4, 0x22: 12, 0x23: 12 + b() + s() + s() + b(),
    0x24: 4 + ti(0x23), 0x25: 12 + ti(0x23), 0x26: 4 + s() + b(),
    0x27: 8 + s() * 2 + cw('Implementation'), 0x28: 8 + s() + cw('Implementation'),
    0x29: ti(0x02) * 2, 0x2a: 4 + cw('TypeOrMethodDef') + s(), 0x2b: cw('MethodDefOrRef') + b(),
    0x2c: ti(0x2a) + cw('TypeDefOrRef'),
  };
  for (const k of Object.keys(S)) size[Number(k)] = S[k];
  const off = new Array(64).fill(0);
  let cur = q;
  for (let t = 0; t < 64; t++) {
    if (!rows[t]) continue;
    if (!size[t]) throw new Error('unknown table 0x' + t.toString(16));
    off[t] = cur;
    cur += rows[t] * size[t];
  }
  return {
    buf, rows, off, size, strW, resRva: buf.readUInt32LE(cli + 24), toOff,
    str: (i) => {
      const at = strHeap.off + i;
      let e = at;
      while (buf[e] !== 0) e++;
      return buf.toString('utf8', at, e);
    },
  };
}

function extract(dll) {
  const m = readCli(dll);
  const out = {};
  const resBase = m.toOff(m.resRva);
  for (let r = 0; r < m.rows[0x28]; r++) {
    const at = m.off[0x28] + r * m.size[0x28];
    const name = m.str(m.strW ? m.buf.readUInt32LE(at + 8) : m.buf.readUInt16LE(at + 8));
    if (!RESOURCE.test(name)) continue;
    const impl = m.strW ? m.buf.readUInt16LE(at + 12) : m.buf.readUInt16LE(at + 10);
    if ((impl >>> 2) !== 0) continue;
    const p = resBase + m.buf.readUInt32LE(at);
    const len = m.buf.readUInt32LE(p);
    const xml = m.buf.toString('utf8', p + 4, p + 4 + len).replace(/^\uFEFF/, '');
    const enumName = (xml.split('<EnumValues>')[0].match(/<Name>([^<]+)<\/Name>/) || [])[1];
    if (!enumName) continue;
    const values = [];
    for (const block of xml.match(/<AxEnumValue>[\s\S]*?<\/AxEnumValue>/g) || []) {
      const vn = (block.match(/<Name>([^<]*)<\/Name>/) || [])[1];
      if (vn === undefined || !vn.trim()) continue;
      // A value with no <Value> element is legitimate (it means the default) and is
      // kept, so a built-in enum reads exactly like one backed by an AxEnum file.
      const vv = (block.match(/<Value>([^<]*)<\/Value>/) || [])[1];
      const vl = (block.match(/<Label>([^<]*)<\/Label>/) || [])[1];
      const entry = { name: vn.trim() };
      if (vv && vv.trim()) entry.value = vv.trim();
      if (vl && vl.trim()) entry.label = vl.trim();
      values.push(entry);
    }
    if (!values.length) continue;
    out[enumName.trim()] = {
      id: (xml.match(/<Id>([^<]*)<\/Id>/) || [])[1]?.trim(),
      values,
    };
  }
  return out;
}

const target = process.argv[2];
if (!target) {
  console.log(`usage: node scripts/extract-kernel-enums.mjs <AOS bin folder | ${DLL}>`);
  process.exit(2);
}
const dll = findDll(target);
const t0 = Date.now();
const enums = extract(dll);
const names = Object.keys(enums).sort((a, b) => a.localeCompare(b));
const members = names.reduce((n, k) => n + enums[k].values.length, 0);
const ordered = {};
for (const n of names) ordered[n] = enums[n];
const doc = {
  note: 'Values for the enums the platform builds in. These are the AOT enums with no AxEnum file in ' +
    'PackagesLocalDirectory - on 10.0.2645.32, 47 of them, carrying 55% of all enum references, NoYes ' +
    'among them. The AOS ships each one as an AxEnum_<Name>.xml document embedded in ' +
    'Microsoft.Dynamics.AX.Metadata.dll, so this file is generated from that assembly by ' +
    'scripts/extract-kernel-enums.mjs and checked in, keeping the extension self-contained. ' +
    'A label that starts with @ is a label id (@sys####); it is shown only once it resolves. ' +
    'A missing enum means the value list is unknown rather than empty.',
  enums: ordered,
};
fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
console.log(`${dll}`);
console.log(`extracted ${names.length} enums / ${members} members in ${Date.now() - t0} ms`);
console.log(`-> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
