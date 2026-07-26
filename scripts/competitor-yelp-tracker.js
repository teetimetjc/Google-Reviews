// Weekly competitor Yelp snapshot. Companion to competitor-gbp-tracker.js —
// same "Competitors" tab as the source list, but a separate destination tab
// so the two platforms never mix. Never touches Reviews Log/Change Log, and
// only ever appends a single new column (F) to "Competitors" — every
// existing column and row stays exactly as-is.
//
// Yelp Fusion API is free (no paid tier required): api.yelp.com/v3. First
// run for a competitor without a cached Yelp ID resolves one via Business
// Search (by name + service area) and writes it back into Competitors!F so
// future runs look the business up directly instead of re-searching.

import { getAccessToken } from '../src/sheetsSync.js';

const { SHEETS_SPREADSHEET_ID, GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY, YELP_API_KEY } = process.env;

const COMPETITORS_TAB = 'Competitors';
const YELP_ID_COL = 'F';
const YELP_ID_HEADER = 'Yelp Business ID (or Alias)';

const SNAPSHOTS_TAB = 'Competitor_Yelp_Snapshots';
const SNAPSHOTS_HEADERS = [
  'Snapshot Date', 'Competitor Name', 'Yelp Business ID', 'Star Rating', 'Review Count',
  'Review Count Change', 'New Reviews Since Last Snapshot', 'Categories', 'Yelp URL',
];
const LAST_ROW = 100000;

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

async function ensureTabExists(accessToken, spreadsheetId, title, headers) {
  const meta = await sheetsRequest(accessToken, `${spreadsheetId}?fields=sheets.properties(title,sheetId)`);
  const exists = meta.sheets?.some((s) => s.properties.title === title);
  if (exists) return;

  await sheetsRequest(accessToken, `${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  const range = encodeURIComponent(`${title}!A1`);
  await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers] }),
  });
  console.log(`Created "${title}" tab.`);
}

// Only ever writes this one header cell — never touches A1:E1.
async function ensureYelpIdColumnHeader(accessToken, spreadsheetId) {
  const range = encodeURIComponent(`${COMPETITORS_TAB}!${YELP_ID_COL}1`);
  await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [[YELP_ID_HEADER]] }),
  });
}

async function fetchCompetitors(accessToken, spreadsheetId) {
  const range = encodeURIComponent(`${COMPETITORS_TAB}!A2:F${LAST_ROW}`);
  const { values = [] } = await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}`);
  return values
    .map((row, i) => ({
      rowNumber: i + 2,
      name: (row[0] ?? '').toString().trim(),
      serviceArea: (row[3] ?? '').toString().trim(),
      yelpId: (row[5] ?? '').toString().trim(),
    }))
    .filter((c) => c.name);
}

async function fetchLastSnapshots(accessToken, spreadsheetId) {
  const range = encodeURIComponent(`${SNAPSHOTS_TAB}!A2:E${LAST_ROW}`);
  const { values = [] } = await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}`);
  const lastByName = new Map();
  for (const row of values) {
    const name = (row[1] ?? '').toString().trim();
    const date = row[0] ? new Date(row[0]) : null;
    const reviewCount = Number(row[4]);
    if (!name || !date || Number.isNaN(reviewCount)) continue;
    const existing = lastByName.get(name);
    if (!existing || date > existing.date) {
      lastByName.set(name, { date, reviewCount });
    }
  }
  return lastByName;
}

async function yelpRequest(pathAndQuery) {
  const res = await fetch(`https://api.yelp.com/v3/${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${YELP_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Yelp API request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function searchYelpBusiness(name, location) {
  const params = new URLSearchParams({ term: name, location: location || 'Sarasota, FL', limit: '1' });
  const { businesses = [] } = await yelpRequest(`businesses/search?${params}`);
  return businesses[0] ?? null;
}

function categoriesFor(business) {
  return (business.categories ?? []).map((c) => c.title).join(', ');
}

function cleanUrl(url) {
  return url ? url.split('?')[0] : '';
}

async function run() {
  if (!SHEETS_SPREADSHEET_ID || !GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY) {
    throw new Error('Set SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY env vars first.');
  }
  if (!YELP_API_KEY) {
    throw new Error('Set YELP_API_KEY env var first (free Yelp Fusion API key from fusion.yelp.com).');
  }

  const accessToken = await getAccessToken(GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY);

  await ensureYelpIdColumnHeader(accessToken, SHEETS_SPREADSHEET_ID);
  await ensureTabExists(accessToken, SHEETS_SPREADSHEET_ID, SNAPSHOTS_TAB, SNAPSHOTS_HEADERS);

  const competitors = await fetchCompetitors(accessToken, SHEETS_SPREADSHEET_ID);
  if (competitors.length === 0) {
    console.log(`No competitors found in "${COMPETITORS_TAB}" — add some there first (shared with the Google tracker).`);
    return;
  }

  const lastSnapshots = await fetchLastSnapshots(accessToken, SHEETS_SPREADSHEET_ID);
  const snapshotDate = new Date().toISOString();
  const snapshotRows = [];
  const idCacheUpdates = [];
  const failures = [];

  for (const competitor of competitors) {
    try {
      let business;
      let yelpId = competitor.yelpId;

      if (yelpId) {
        business = await yelpRequest(`businesses/${encodeURIComponent(yelpId)}`);
      } else {
        const match = await searchYelpBusiness(competitor.name, competitor.serviceArea);
        if (!match) {
          failures.push({ competitor: competitor.name, error: 'No Yelp match found for this business name' });
          continue;
        }
        business = match;
        yelpId = match.id;
        idCacheUpdates.push({ range: `${COMPETITORS_TAB}!${YELP_ID_COL}${competitor.rowNumber}`, values: [[yelpId]] });
      }

      const rating = business.rating ?? '';
      const reviewCount = business.review_count ?? 0;
      const categories = categoriesFor(business);
      const url = cleanUrl(business.url);

      const previous = lastSnapshots.get(competitor.name);
      const reviewCountChange = previous ? reviewCount - previous.reviewCount : '';
      const newReviewsSinceLast = previous ? Math.max(reviewCount - previous.reviewCount, 0) : '';

      snapshotRows.push([
        snapshotDate, competitor.name, yelpId, rating, reviewCount,
        reviewCountChange, newReviewsSinceLast, categories, url,
      ]);
    } catch (err) {
      failures.push({ competitor: competitor.name, error: err.message });
    }
  }

  if (idCacheUpdates.length) {
    await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data: idCacheUpdates }),
    });
  }
  if (snapshotRows.length) {
    const appendRange = encodeURIComponent(`${SNAPSHOTS_TAB}!A1`);
    await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: snapshotRows }),
    });
  }

  console.log(`Snapshotted ${snapshotRows.length} of ${competitors.length} competitor(s) on Yelp${idCacheUpdates.length ? `, resolved ${idCacheUpdates.length} new Yelp ID(s)` : ''}${failures.length ? `, ${failures.length} failed` : ''}.`);
  for (const failure of failures) {
    console.error(`Failed lookup for "${failure.competitor}": ${failure.error}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
