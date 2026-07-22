// One-off: writes the Summary tab's stat/helper formulas and the
// technician-mention tracking table. Creates the "Summary" tab if it
// doesn't exist yet; otherwise just writes into the specific cells below
// (won't touch anything else already on that tab). Safe to run again —
// it always overwrites the same fixed cells with the same formulas.

import { getAccessToken } from '../src/sheetsSync.js';

const { SHEETS_SPREADSHEET_ID, GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY } = process.env;

if (!SHEETS_SPREADSHEET_ID || !GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY) {
  console.error('Set SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY env vars first.');
  process.exit(1);
}

const TAB = 'Summary';
// Headroom above the current ~1,378 rows so the formulas keep working as
// more reviews come in, without going fully unbounded (which is slower
// and can hit Sheets limits on array formulas).
const LAST_ROW = 3000;

const TECHNICIANS = [
  'Marty', 'Rod', 'Vince', 'Robert', 'Knox', 'Ryan', 'Dennis', 'Matt',
  'Kerwing', 'Harc', 'Rey', 'Louis', 'Juan', 'Brandon', 'Jonny', 'Johnny',
  'Scott', 'Paul', 'Marvin', 'Tristan', 'George', 'Jamar', 'Mike', 'Russell', 'Terry',
];

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

const meta = await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}?fields=sheets.properties(title,sheetId)`);
const exists = meta.sheets?.some((s) => s.properties.title === TAB);
if (!exists) {
  await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB } } }] }),
  });
  console.log(`Created "${TAB}" tab.`);
}

const range = `'Reviews Log'!A2:A${LAST_ROW}`;
const rangeB = `'Reviews Log'!B2:B${LAST_ROW}`;
const rangeC = `'Reviews Log'!$C$2:$C$${LAST_ROW}`;
const rangeBAbs = `'Reviews Log'!$B$2:$B$${LAST_ROW}`;

const data = [
  // Helper columns: real date / real number, coerced from the text
  // values the reviews sync writes (ISO date strings, numeric-as-text
  // ratings) so AVERAGE/AVERAGEIFS/QUERY can actually operate on them.
  { range: `${TAB}!T1:U1`, values: [['Real Date', 'Numeric Rating']] },
  { range: `${TAB}!T2`, values: [[`=ARRAYFORMULA(IFERROR(DATEVALUE(LEFT(${range},10)),))`]] },
  { range: `${TAB}!U2`, values: [[`=ARRAYFORMULA(IFERROR(VALUE(${rangeB}),))`]] },

  // Stat cells (labels A1:A6 assumed already present from manual setup;
  // only the formulas that depended on real dates/numbers are rewritten).
  { range: `${TAB}!B2`, values: [['=AVERAGE(U2:U)']] },
  { range: `${TAB}!B3`, values: [['=AVERAGEIFS(U2:U, T2:T, ">="&(TODAY()-30))']] },
  { range: `${TAB}!B4`, values: [['=COUNTIFS(T2:T, ">="&EOMONTH(TODAY(),-1)+1, T2:T, "<="&TODAY())']] },

  // Monthly trend table, driven off the helper columns via a virtual
  // two-column range QUERY can run year()/month()/avg() against.
  { range: `${TAB}!A9`, values: [['=QUERY({T2:T,U2:U}, "select year(Col1), month(Col1), count(Col1), avg(Col2) where Col1 is not null group by year(Col1), month(Col1) order by year(Col1), month(Col1)", 0)']] },

  // Technician mention tracking.
  { range: `${TAB}!D1:F1`, values: [['Technician', 'Mentions', 'Avg Rating']] },
  { range: `${TAB}!D2:D${1 + TECHNICIANS.length}`, values: TECHNICIANS.map((name) => [name]) },
];

// Per-technician formulas (word-boundary match against the review text,
// weighted average of the numeric rating for rows that mention them).
for (let i = 0; i < TECHNICIANS.length; i++) {
  const row = i + 2;
  data.push({
    range: `${TAB}!E${row}:F${row}`,
    values: [[
      `=SUMPRODUCT(--REGEXMATCH(${rangeC}, "\\b"&D${row}&"\\b"))`,
      `=IFERROR(SUMPRODUCT(--REGEXMATCH(${rangeC}, "\\b"&D${row}&"\\b")*IFERROR(VALUE(${rangeBAbs}),0))/E${row}, "")`,
    ]],
  });
}

await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values:batchUpdate`, {
  method: 'POST',
  body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
});

console.log(`Wrote helper columns, fixed stat formulas, monthly trend query, and ${TECHNICIANS.length} technician rows to "${TAB}".`);
