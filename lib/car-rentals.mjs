const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function clean(value) {
  return String(value ?? '').trim();
}

function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function monthValue(value) {
  let date;
  if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(EXCEL_EPOCH + Math.floor(value) * DAY_MS);
  } else {
    const text = clean(value);
    const iso = text.match(/^(\d{4})[-/](\d{1,2})/);
    const short = text.match(/^([A-Za-z]{3})[- /](\d{2,4})$/);
    if (iso) date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, 1));
    else if (short) {
      const month = MONTH_NAMES.findIndex(name => name.toLowerCase() === short[1].toLowerCase());
      let year = Number(short[2]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      if (month >= 0) date = new Date(Date.UTC(year, month, 1));
    }
  }
  if (!date || Number.isNaN(date.getTime())) return { key:'', label:'Unassigned' };
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return { key:`${year}-${String(month + 1).padStart(2, '0')}`, label:`${MONTH_NAMES[month]}-${String(year).slice(-2)}` };
}

function rentalStatus(value) {
  const status = clean(value).toLowerCase();
  if (status.includes('no invoice')) return 'Done with No Invoice';
  if (status.includes('active') && !status.includes('inactive')) return 'Active';
  if (status.includes('done')) return 'Invoice Received';
  return 'Unclassified';
}

export function normalizeCarRentalRows(sheetRows) {
  if (!Array.isArray(sheetRows) || !sheetRows.length) throw new Error('Car rental master-data sheet is empty');
  const headers = sheetRows[0].map(clean);
  const indices = new Map(headers.map((header, index) => [header, index]));
  const required = ['MONTH','PROJECT Name','RENTALCOMPANYNAME','Active &Inactive','Amount In USD'];
  const missing = required.filter(header => !indices.has(header));
  if (missing.length) throw new Error(`Car rental sheet is missing required columns: ${missing.join(', ')}`);
  const value = (row, header) => {
    const index = indices.get(header);
    return index == null ? null : row[index] ?? null;
  };

  return sheetRows.slice(1).filter(row => row.some(cell => cell !== null && cell !== '')).map(row => {
    const month = monthValue(value(row, 'MONTH'));
    return {
      monthKey:month.key,
      monthLabel:month.label,
      projectName:clean(value(row, 'PROJECT Name')) || 'Unassigned',
      rentalCompany:clean(value(row, 'RENTALCOMPANYNAME')) || 'Unassigned',
      rentalStatus:rentalStatus(value(row, 'Active &Inactive')),
      activeStatus:clean(value(row, 'Active &Inactive')) || 'Unclassified',
      invoiceStatus:clean(value(row, 'Invoice')) || 'Not recorded',
      amountUsd:numberValue(value(row, 'Amount In USD')),
      carCode:clean(value(row, 'Car Rental Code')) || '—',
      plateNumber:clean(value(row, 'PLATE NO(Vehicle Number)')) || '—',
      rentalDays:numberValue(value(row, 'RENTALDAYS')),
    };
  });
}

function options(rows, key) {
  return [...new Set(rows.map(row => row[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function roundedSum(rows) {
  return Math.round(rows.reduce((sum, row) => sum + row.amountUsd, 0) * 100) / 100;
}

function groupRows(rows, key, labelKey=key) {
  const groups = new Map();
  for (const row of rows) {
    const groupKey = row[key] || 'Unassigned';
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(row);
  }
  return [...groups].map(([keyValue, group]) => ({ key:keyValue, label:group[0][labelKey] || 'Unassigned', count:group.length, amount:roundedSum(group) }));
}

export function buildCarRentalDashboard(allRows, selected={}) {
  const monthOptions=options(allRows, 'monthKey').sort();
  const filters = {
    months:monthOptions,
    monthLabels:Object.fromEntries(monthOptions.map(key => [key, allRows.find(row => row.monthKey === key)?.monthLabel || key])),
    companies:options(allRows, 'rentalCompany'),
    projects:options(allRows, 'projectName'),
  };
  const months = new Set(selected.months || []);
  const companies = new Set(selected.companies || []);
  const projects = new Set(selected.projects || []);
  const rows = allRows.filter(row => (!months.size || months.has(row.monthKey))
    && (!companies.size || companies.has(row.rentalCompany))
    && (!projects.size || projects.has(row.projectName)))
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey) || a.rentalCompany.localeCompare(b.rentalCompany) || a.carCode.localeCompare(b.carCode));
  const vendorInvoices = groupRows(rows, 'rentalCompany').sort((a, b) => b.amount - a.amount);
  const invoiceStatuses = groupRows(rows, 'rentalStatus').sort((a, b) => b.amount - a.amount);
  const monthlyExpenses = groupRows(rows, 'monthKey', 'monthLabel').sort((a, b) => a.key.localeCompare(b.key));
  const activeCars = rows.filter(row => row.rentalStatus === 'Active').length;
  const invoiceReceived = rows.filter(row => row.rentalStatus === 'Invoice Received');
  const doneWithoutInvoice = rows.filter(row => row.rentalStatus === 'Done with No Invoice');
  return {
    filters,
    selected:{ months:[...months], companies:[...companies], projects:[...projects] },
    summary:{ totalCars:rows.length, activeCars, totalInvoice:roundedSum(rows), invoiceReceived:roundedSum(invoiceReceived), doneWithoutInvoice:roundedSum(doneWithoutInvoice) },
    vendorInvoices,
    invoiceStatuses,
    monthlyExpenses,
    rows,
  };
}
