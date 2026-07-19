// One-off cleanup: removes stale "Reviews Log" rows left behind by the
// column-migration bug (rows written before the sheet expanded from 8 to
// 13 columns; their Review ID ended up misaligned into a different
// column, and the Review ID column itself was left blank on those rows).
// Every real review has exactly one blank-ID row and one correct row, so
// this just drops any row with a blank Review ID and leaves the rest
// untouched. Safe to run more than once — it's a no-op once clean.

import { getAccessToken } from '../src/sheetsSync.js';

const { SHEETS_SPREADSHEET_ID, GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY } = process.env;

if (!SHEETS_SPREADSHEET_ID || !GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY) {
  console.error('Set SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY env vars first.');
  process.exit(1);
}

const TAB = 'Reviews Log';

async function sheetsRequest(accessToken, pathAndQuery, options = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${pathAndQuery}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Sheets API request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const accessToken = await getAccessToken(GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY);

const range = encodeURIComponent(`${TAB}!A1:M100000`);
const { values = [] } = await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values/${range}`);

if (values.length === 0) {
  console.log('Sheet is empty, nothing to clean.');
  process.exit(0);
}

const [header, ...rows] = values;
const lastColIndex = header.length - 1; // Review ID is always the last column
const goodRows = rows.filter((row) => (row[lastColIndex] ?? '').toString().trim() !== '');
const staleCount = rows.length - goodRows.length;

console.log(`Total data rows: ${rows.length}. Stale (blank Review ID) rows: ${staleCount}. Keeping: ${goodRows.length}.`);

if (staleCount === 0) {
  console.log('No cleanup needed.');
  process.exit(0);
}

const clearRange = encodeURIComponent(`${TAB}!A2:M100000`);
await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values/${clearRange}:clear`, {
  method: 'POST',
  body: JSON.stringify({}),
});

const writeRange = encodeURIComponent(`${TAB}!A1`);
await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values/${writeRange}?valueInputOption=RAW`, {
  method: 'PUT',
  body: JSON.stringify({ values: [header, ...goodRows] }),
});

console.log(`Removed ${staleCount} stale rows. ${goodRows.length} clean rows remain.`);
