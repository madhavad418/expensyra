// Minimal, dependency-free .xlsx reader — just enough to read a selected
// worksheet as rows of cell values. Keeps this
// build's "no third-party runtime dependencies" property. Supports stored and
// deflated zip entries, shared/inline strings, numbers and booleans; formulas
// are read as their cached value. Dates come back as Excel serial numbers.
import zlib from 'node:zlib';

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt .xlsx file (bad zip entry)');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, csize, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return name => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data.toString('utf8');
    if (e.method === 8) return zlib.inflateRawSync(data).toString('utf8');
    throw new Error(`Unsupported .xlsx compression method ${e.method}`);
  };
}

function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'amp') return '&';
    if (e === 'quot') return '"'; if (e === 'apos') return "'";
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}
const textRuns = xml => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('');

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); }
  return n - 1;
}

// Returns { sheetName, rows } for the requested worksheet; rows are arrays
// of string | number | boolean | null.
export function readSheet(buffer, requestedSheetName = null) {
  const get = unzip(buffer);
  const workbook = get('xl/workbook.xml');
  if (!workbook) throw new Error('Not an Excel workbook (xl/workbook.xml missing)');
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)];
  if (!sheets.length) throw new Error('Workbook has no worksheets');
  const sheet = requestedSheetName
    ? sheets.find(m => decodeXml(m[0].match(/\bname="([^"]*)"/)?.[1] || '') === requestedSheetName)
    : sheets[0];
  if (!sheet) throw new Error(`Worksheet "${requestedSheetName}" not found`);
  const sheetName = decodeXml(sheet[0].match(/\bname="([^"]*)"/)?.[1] || '');
  const relId = sheet[0].match(/\br:id="([^"]*)"/)?.[1];
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  let target = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(r => r.includes(`Id="${relId}"`))?.match(/Target="([^"]*)"/)?.[1] || 'worksheets/sheet1.xml';
  target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheetXml = get(target);
  if (!sheetXml) throw new Error(`Worksheet ${target} missing`);

  const sst = (get('xl/sharedStrings.xml') || '').match(/<si\b[^>]*\/>|<si\b[^>]*>[\s\S]*?<\/si>/g)?.map(textRuns) || [];

  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] || '';
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const idx = ref ? colIndex(ref) : row.length;
      const type = attrs.match(/\bt="([^"]*)"/)?.[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = null;
      if (type === 's') value = v != null ? (sst[Number(v)] ?? null) : null;
      else if (type === 'inlineStr') value = textRuns(body);
      else if (type === 'str' || type === 'e') value = v != null ? decodeXml(v) : null;
      else if (type === 'b') value = v === '1';
      else if (v != null) value = Number(v);
      row[idx] = value;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    rows.push(row);
  }
  return { sheetName, rows };
}

export function readFirstSheet(buffer) {
  return readSheet(buffer);
}
