// Weekly competitor GBP snapshot. Reads the manually-maintained
// "Competitors" tab and, for each competitor with a Place ID filled in,
// looks up their public Google Business Profile via the Places API (New)
// and appends one row to "Competitor_GBP_Snapshots" with their current
// rating, review count, and the change since their last snapshot.
//
// The Business Profile Reviews API (used by src/index.js) can only read
// reviews for locations *you* manage, so competitor data has to come from
// a public source instead — Places API here, same one already used as the
// fallback in src/places-check.js.
//
// This script only ever reads from "Competitors" and only ever appends to
// "Competitor_GBP_Snapshots" — it never touches the existing Reviews Log /
// Change Log tabs or the scripts that own them.

import { getAccessToken } from '../src/sheetsSync.js';

const { SHEETS_SPREADSHEET_ID, GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY, PLACES_API_KEY } = process.env;

const COMPETITORS_TAB = 'Competitors';
const COMPETITORS_HEADERS = ['Competitor Name', 'GBP Place ID (or CID)', 'Website URL', 'Service Area', 'Notes'];
// Left with a blank Place ID on purpose, so the tracker skips them
// automatically instead of trying to look up a fake place.
const COMPETITORS_PLACEHOLDERS = [
  ['Example Septic Co', '', 'https://example.com', 'Sarasota County', 'Placeholder row — replace with a real competitor and fill in their GBP Place ID to start tracking them.'],
  ['Another Septic Co', '', 'https://example.com', 'Charlotte County', 'Placeholder row — replace with a real competitor and fill in their GBP Place ID to start tracking them.'],
];

const SNAPSHOTS_TAB = 'Competitor_GBP_Snapshots';
const SNAPSHOTS_HEADERS = [
  'Snapshot Date', 'Competitor Name', 'Star Rating', 'Total Review Count',
  'Review Count Change', 'New Reviews Since Last Snapshot', 'Photos Count', 'Categories/Services Listed',
];
// Generous headroom for years of weekly snapshots across several competitors.
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

// Creates the tab with a header row (and optional placeholder rows) only
// if it doesn't exist yet. If it already exists, this leaves it completely
// alone — "Competitors" is hand-maintained, and "Competitor_GBP_Snapshots"
// is append-only, so neither should ever have existing rows rewritten.
async function ensureTabExists(accessToken, spreadsheetId, title, headers, placeholderRows = []) {
  const meta = await sheetsRequest(accessToken, `${spreadsheetId}?fields=sheets.properties(title,sheetId)`);
  const exists = meta.sheets?.some((s) => s.properties.title === title);
  if (exists) return;

  await sheetsRequest(accessToken, `${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });

  const rows = [headers, ...placeholderRows];
  const range = encodeURIComponent(`${title}!A1`);
  await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: rows }),
  });
  console.log(`Created "${title}" tab.`);
}

async function fetchCompetitors(accessToken, spreadsheetId) {
  const range = encodeURIComponent(`${COMPETITORS_TAB}!A2:E${LAST_ROW}`);
  const { values = [] } = await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}`);
  return values
    .map((row) => ({
      name: (row[0] ?? '').toString().trim(),
      placeId: (row[1] ?? '').toString().trim(),
      website: row[2] ?? '',
      serviceArea: row[3] ?? '',
      notes: row[4] ?? '',
    }))
    // Skip blank rows and placeholder rows (no Place ID filled in yet).
    .filter((c) => c.name && c.placeId);
}

// Most recent prior snapshot per competitor, so we can compute the review
// count change/velocity. Keyed by exact Competitor Name match against the
// Competitors tab.
async function fetchLastSnapshots(accessToken, spreadsheetId) {
  const range = encodeURIComponent(`${SNAPSHOTS_TAB}!A2:H${LAST_ROW}`);
  const { values = [] } = await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}`);
  const lastByName = new Map();
  for (const row of values) {
    const name = (row[1] ?? '').toString().trim();
    const date = row[0] ? new Date(row[0]) : null;
    const totalReviewCount = Number(row[3]);
    if (!name || !date || Number.isNaN(totalReviewCount)) continue;
    const existing = lastByName.get(name);
    if (!existing || date > existing.date) {
      lastByName.set(name, { date, totalReviewCount });
    }
  }
  return lastByName;
}

// Types that show up on almost every listing and add no useful signal.
const NOISE_TYPES = new Set(['point_of_interest', 'establishment']);

function categoriesFor(place) {
  if (place.primaryTypeDisplayName?.text) return place.primaryTypeDisplayName.text;
  return (place.types ?? []).filter((t) => !NOISE_TYPES.has(t)).join(', ');
}

async function fetchPlaceDetails(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': PLACES_API_KEY,
      'X-Goog-FieldMask': 'displayName,rating,userRatingCount,photos,types,primaryTypeDisplayName',
    },
  });
  if (!res.ok) {
    throw new Error(`Places API request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function run() {
  if (!SHEETS_SPREADSHEET_ID || !GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY) {
    throw new Error('Set SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY env vars first.');
  }
  if (!PLACES_API_KEY) {
    throw new Error('Set PLACES_API_KEY env var first (Places API (New) key from Google Cloud Console).');
  }

  const accessToken = await getAccessToken(GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY);

  await ensureTabExists(accessToken, SHEETS_SPREADSHEET_ID, COMPETITORS_TAB, COMPETITORS_HEADERS, COMPETITORS_PLACEHOLDERS);
  await ensureTabExists(accessToken, SHEETS_SPREADSHEET_ID, SNAPSHOTS_TAB, SNAPSHOTS_HEADERS);

  const competitors = await fetchCompetitors(accessToken, SHEETS_SPREADSHEET_ID);
  if (competitors.length === 0) {
    console.log(`No competitors configured yet — add rows with a GBP Place ID to the "${COMPETITORS_TAB}" tab.`);
    return;
  }

  const lastSnapshots = await fetchLastSnapshots(accessToken, SHEETS_SPREADSHEET_ID);
  const snapshotDate = new Date().toISOString();
  const snapshotRows = [];
  const failures = [];

  for (const competitor of competitors) {
    try {
      const place = await fetchPlaceDetails(competitor.placeId);
      const rating = place.rating ?? '';
      const totalReviewCount = place.userRatingCount ?? 0;
      const photosCount = (place.photos ?? []).length;
      const categories = categoriesFor(place);

      const previous = lastSnapshots.get(competitor.name);
      const reviewCountChange = previous ? totalReviewCount - previous.totalReviewCount : '';
      const newReviewsSinceLast = previous ? Math.max(totalReviewCount - previous.totalReviewCount, 0) : '';

      snapshotRows.push([
        snapshotDate, competitor.name, rating, totalReviewCount,
        reviewCountChange, newReviewsSinceLast, photosCount, categories,
      ]);
    } catch (err) {
      failures.push({ competitor: competitor.name, placeId: competitor.placeId, error: err.message });
    }
  }

  if (snapshotRows.length) {
    const appendRange = encodeURIComponent(`${SNAPSHOTS_TAB}!A1`);
    await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: snapshotRows }),
    });
  }

  console.log(`Snapshotted ${snapshotRows.length} of ${competitors.length} competitor(s)${failures.length ? `, ${failures.length} failed` : ''}.`);
  for (const failure of failures) {
    console.error(`Failed lookup for "${failure.competitor}" (Place ID ${failure.placeId || '(blank)'}): ${failure.error}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
