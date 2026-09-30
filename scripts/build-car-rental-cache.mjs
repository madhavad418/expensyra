import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSheet } from '../lib/xlsx.mjs';
import { normalizeCarRentalRows } from '../lib/car-rentals.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/build-car-rental-cache.mjs <workbook.xlsx>');
const sheetName = '2026 Car Rental Master Data';
const workbook = readSheet(fs.readFileSync(path.resolve(source)), sheetName);
const snapshot = {
  sheetName:workbook.sheetName,
  loadedAt:new Date().toISOString(),
  sourceFile:path.basename(source),
  rows:normalizeCarRentalRows(workbook.rows),
};
const target = path.join(root, 'data', 'car-rentals-2026.json');
fs.writeFileSync(target, `${JSON.stringify(snapshot)}\n`);
console.log(`Cached ${snapshot.rows.length} rows from "${snapshot.sheetName}" at ${target}`);