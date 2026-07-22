// Logs reviews to a Google Sheet using a service account (no OAuth user
// consent needed, no expiry — unlike the business.manage refresh token,
// this can run unattended indefinitely).
//
// "Reviews Log" tab: one row per review, upserted in place and kept
// sorted newest-first — a new review gets appended, an existing one
// (e.g. once it gets a reply) gets its row updated. The last column
// (Review ID) is an internal key used to match rows on re-runs.
//
// "Change Log" tab: append-only history — every detected new review,
// reply, or edit gets its own row, sorted newest-first, and is never
// overwritten. This is the actual audit trail; the Reviews Log tab only
// ever shows current state.

import { createSign } from 'node:crypto';

const REVIEWS_TAB = 'Reviews Log';
const REVIEWS_HEADERS = [
  'Date', 'Rating', 'Review', 'Reviewer', 'Anonymous?', 'Reviewer Photo',
  'Edited?', 'Last Updated', 'Replied?', 'Reply Text', 'Reply Date',
  'Status', 'Response Status', 'Draft Response', 'Review ID',
];
const REVIEWS_LAST_COL = String.fromCharCode(64 + REVIEWS_HEADERS.length); // 'O'
// Columns through "Status" are owned by the review-check sync (src/index.js)
// and rewritten on every run. "Response Status"/"Draft Response" are owned
// by the draft-generation script (scripts/generate-draft-responses.js) —
// the review-check sync must never touch them, or it would stomp a drafted
// reply back to blank on the next hourly run. Review ID is never rewritten;
// it's only ever used to find the row.
const REVIEWS_CORE_HEADERS = ['Date', 'Rating', 'Review', 'Reviewer', 'Anonymous?', 'Reviewer Photo', 'Edited?', 'Last Updated', 'Replied?', 'Reply Text', 'Reply Date', 'Status'];
const REVIEWS_CORE_LAST_COL = String.fromCharCode(64 + REVIEWS_CORE_HEADERS.length); // 'L'

const CHANGE_LOG_TAB = 'Change Log';
const CHANGE_LOG_HEADERS = ['Detected At', 'Location', 'Change Type', 'Reviewer', 'Rating', 'Comment'];

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function getAccessToken(serviceAccountKeyJson) {
  const { client_email, private_key } = JSON.parse(serviceAccountKeyJson);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to get Sheets access token: ${res.status} ${await res.text()}`);
  }
  const { access_token } = await res.json();
  return access_token;
}

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

// Returns the tab's numeric sheetId (needed for sort requests), creating
// the tab if needed and always keeping row 1 in sync with `headers` (so a
// header-set change, like adding new columns, takes effect immediately
// instead of leaving stale headers from a previous version).
async function ensureTabAndHeaders(accessToken, spreadsheetId, title, headers) {
  const meta = await sheetsRequest(accessToken, `${spreadsheetId}?fields=sheets.properties(title,sheetId)`);
  let sheet = meta.sheets?.find((s) => s.properties.title === title);
  if (!sheet) {
    const created = await sheetsRequest(accessToken, `${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    });
    sheet = created.replies[0].addSheet;
  }

  const putRange = encodeURIComponent(`${title}!A1`);
  await sheetsRequest(accessToken, `${spreadsheetId}/values/${putRange}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers] }),
  });

  return sheet.properties.sheetId;
}

async function sortNewestFirst(accessToken, spreadsheetId, sheetId, columnCount, dataRowCount) {
  if (dataRowCount < 2) return; // nothing to sort
  await sheetsRequest(accessToken, `${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        sortRange: {
          range: {
            sheetId,
            startRowIndex: 1, // skip header
            endRowIndex: dataRowCount + 1,
            startColumnIndex: 0,
            endColumnIndex: columnCount,
          },
          sortSpecs: [{ dimensionIndex: 0, sortOrder: 'DESCENDING' }],
        },
      }],
    }),
  });
}

// `rows` items (matches REVIEWS_HEADERS order, Review ID always last):
//   [date, rating, review, reviewer, anonymous, photoUrl, edited, lastUpdated,
//    repliedYesNo, replyText, replyDate, status, responseStatus, draftResponse, reviewId]
// `changes` items: [detectedAt, location, changeType, reviewer, rating, comment]
export async function syncReviewsToSheet({ spreadsheetId, serviceAccountKeyJson, rows, changes }) {
  const accessToken = await getAccessToken(serviceAccountKeyJson);
  const reviewsSheetId = await ensureTabAndHeaders(accessToken, spreadsheetId, REVIEWS_TAB, REVIEWS_HEADERS);

  const idRange = encodeURIComponent(`${REVIEWS_TAB}!${REVIEWS_LAST_COL}2:${REVIEWS_LAST_COL}`);
  const idRes = await sheetsRequest(accessToken, `${spreadsheetId}/values/${idRange}`);
  const existingIds = (idRes.values ?? []).map((r) => r[0]);
  const idToRow = new Map(existingIds.map((id, i) => [id, i + 2])); // row 1 is the header

  const updates = [];
  const newRows = [];
  for (const row of rows) {
    const reviewId = row[row.length - 1];
    const rowNumber = idToRow.get(reviewId);
    if (rowNumber) {
      // Existing row: only rewrite the core columns (Date..Status), never
      // the Response Status / Draft Response columns — those are owned by
      // the draft-generation script.
      const coreValues = row.slice(0, REVIEWS_CORE_HEADERS.length);
      updates.push({ range: `${REVIEWS_TAB}!A${rowNumber}:${REVIEWS_CORE_LAST_COL}${rowNumber}`, values: [coreValues] });
    } else {
      newRows.push(row);
    }
  }

  if (updates.length) {
    await sheetsRequest(accessToken, `${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
    });
  }
  if (newRows.length) {
    const appendRange = encodeURIComponent(`${REVIEWS_TAB}!A1`);
    await sheetsRequest(accessToken, `${spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: newRows }),
    });
  }
  await sortNewestFirst(accessToken, spreadsheetId, reviewsSheetId, REVIEWS_HEADERS.length, existingIds.length + newRows.length);

  let changesLogged = 0;
  if (changes?.length) {
    const changeLogSheetId = await ensureTabAndHeaders(accessToken, spreadsheetId, CHANGE_LOG_TAB, CHANGE_LOG_HEADERS);
    const existingRange = encodeURIComponent(`${CHANGE_LOG_TAB}!A2:A`);
    const existingRes = await sheetsRequest(accessToken, `${spreadsheetId}/values/${existingRange}`);
    const existingCount = (existingRes.values ?? []).length;

    const appendRange = encodeURIComponent(`${CHANGE_LOG_TAB}!A1`);
    await sheetsRequest(accessToken, `${spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: changes }),
    });
    await sortNewestFirst(accessToken, spreadsheetId, changeLogSheetId, CHANGE_LOG_HEADERS.length, existingCount + changes.length);
    changesLogged = changes.length;
  }

  return { updated: updates.length, added: newRows.length, changesLogged };
}
