// One-off: writes a real competitor list into the "Competitors" tab,
// replacing the two placeholder rows the tracker creates on first run.
// Safe to re-run — it always overwrites the same fixed range (A2:E16)
// with this same list, never touching anything below row 16.

import { getAccessToken } from '../src/sheetsSync.js';

const { SHEETS_SPREADSHEET_ID, GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY } = process.env;

if (!SHEETS_SPREADSHEET_ID || !GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY) {
  console.error('Set SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY env vars first.');
  process.exit(1);
}

const TAB = 'Competitors';

// [Competitor Name, GBP Place ID (or CID), Website URL, Service Area, Notes]
// Website URL left blank (not provided); address/phone folded into Notes
// since those aren't columns in this tab's schema.
const COMPETITORS = [
  ['Southern Sanitary Systems Inc.', 'ChIJlbNrg0pBw4gR8CoSRbt9yS4', '', 'Sarasota', 'Address: 4561 Ashton Rd, Sarasota, FL 34233 | Phone: 941-925-7867'],
  ['Martin Septic Service Inc', 'ChIJQW-ZTaGt3IgRKv9sACPg3zc', '', 'North Port / Englewood', 'Address: 2308 Tropicaire Blvd, North Port, FL 34286 | Phone: 941-429-6842'],
  ['Septic Tank Man (North Port)', 'ChIJZV1XUuOr3IgRVokFKd59n_w', '', 'North Port', 'Address: 2563 Toledo Blade Blvd ste 3, North Port, FL 34288 | Phone: 941-297-3166'],
  ['Septic Tank Man (Port Charlotte)', 'ChIJMwrncb-r3IgRNw5hG1iHL9Y', '', 'Port Charlotte', 'Address: 19190 Cochran Blvd Unit 381210, Port Charlotte, FL 33948 | Phone: 941-255-8888'],
  ['Seaside Septic Services', 'ChIJuYVJdMOs3IgRIlqWGfxxp7s', '', 'North Port', 'Address: 4170 Calatrava Ave, North Port, FL 34286 | Phone: 941-716-7750'],
  ['Waters Septic Tank Service, Inc.', 'ChIJ_____3NBw4gR6YrDGiCCzbk', '', 'Sarasota', 'Address: 6760 28th St Cir E, Sarasota, FL 34243 | Phone: 941-355-8670'],
  ['Billings Septic Services', 'ChIJ3zeRL--t3IgRWFbPVp-BC4g', '', 'North Port', 'Address: 4190 Weidman Ave, North Port, FL 34286 | Phone: 941-705-4521'],
  ['Blue Septic', 'ChIJ1wYCfRI-w4gRv81xZKQYe-w', '', 'Bradenton', 'Address: 6119 17th St E, Bradenton, FL 34203 | Phone: 941-758-0674'],
  ['Port Charlotte Septic Inc', 'ChIJWRjKq4JX24gRv5khQkpskD8', '', 'Punta Gorda', 'Address: 614 Rio Villa Dr, Punta Gorda, FL 33950 | Phone: 941-639-5055'],
  ['Elrod Septic Service', 'ChIJycnamzup3IgR2vCUg0xKD6I', '', 'Port Charlotte', 'Address: 3475 Drance St, Port Charlotte, FL 33980 | Phone: 941-626-1857'],
  ['John C Cascio Septic Service', 'ChIJH7c0sfDxlqoRzfyxfy5Xgl4', '', 'Englewood', 'Address: 1460 S McCall Rd Ste 2D 12, Englewood, FL 34223 | Phone: 941-218-0333'],
  ['Amberjack Sanitation Inc', 'ChIJqwJ-m3ipxIgRWgulejJVajg', '', 'Englewood', 'Address: 2830 Avenue of the Americas, Englewood, FL 34224 | Phone: 941-473-5419'],
  ['Englewood Environmental', 'ChIJVx2e-oGpxIgRy_CHy2Gsi2s', '', 'Englewood', 'Address: 2901 Avenue of the Americas, Englewood, FL 34224 | Phone: 941-475-3011'],
  ['Blue Septic Tank Services Inc', 'ChIJVVVVVcU5w4gRevnG3psiuZg', '', 'Bradenton', 'Address: Bradenton, FL 34202 | Phone: 941-485-9599'],
  ['AAA Port Charlotte Septic', 'ChIJ76bsZGapxIgR-O3fttq6hB0', '', 'Englewood', 'Address: 5061 Placida Rd Unit B, Englewood, FL 34224'],
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
const lastRow = 1 + COMPETITORS.length;
const range = encodeURIComponent(`${TAB}!A2:E${lastRow}`);
await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values/${range}?valueInputOption=RAW`, {
  method: 'PUT',
  body: JSON.stringify({ values: COMPETITORS }),
});

console.log(`Wrote ${COMPETITORS.length} competitors to "${TAB}"!A2:E${lastRow}.`);
