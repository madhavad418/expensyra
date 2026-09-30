import assert from 'node:assert/strict';
import { buildCarRentalDashboard, normalizeCarRentalRows } from '../lib/car-rentals.mjs';

const sheet = [
  ['MONTH','PROJECT Name','RENTALCOMPANYNAME','Active &Inactive','Invoice','Amount In USD','Car Rental Code','PLATE NO(Vehicle Number)','RENTALDAYS'],
  [46054,'Project A','Hertz','🔴 Done','INVOICE COMPLETED',100,'C-1','ABC-123',10],
  [46054,'Project A','Hertz','🟢 Active','Invoice',50,'C-2','DEF-456',5],
  [46023,'Project B','Europcar','🔴 Done with No Invoice','Invoice',25,'C-3','GHI-789',3],
];
const rows = normalizeCarRentalRows(sheet);
assert.equal(rows.length, 3);
assert.equal(rows[0].monthKey, '2026-02');
assert.equal(rows[0].monthLabel, 'Feb-26');
const all = buildCarRentalDashboard(rows);
assert.deepEqual(all.summary, { totalCars:3, activeCars:1, totalInvoice:175, invoiceReceived:100, doneWithoutInvoice:25 });
assert.equal(all.vendorInvoices[0].label, 'Hertz');
assert.deepEqual(all.monthlyExpenses.map(month => month.key), ['2026-01','2026-02']);
const filtered = buildCarRentalDashboard(rows, { months:['2026-02'], companies:['Hertz'], projects:['Project A'] });
assert.equal(filtered.summary.totalCars, 2);
assert.equal(filtered.summary.activeCars, 1);
assert.equal(filtered.summary.totalInvoice, 150);
assert.equal(filtered.rows.length, 2);
assert.throws(() => normalizeCarRentalRows([['Wrong sheet'],['x']]), /missing required columns/);
console.log('PASS: target-sheet normalization, month decoding, KPI/status grouping, multi-filtering and invalid-sheet rejection');
