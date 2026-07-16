// Logs every review to a single Google Sheet tab using a service account
// (no OAuth user consent needed, no expiry — unlike the business.manage
// refresh token, this can run unattended indefinitely).
//
// One row per review, upserted in place — a new review gets appended, an
// existing one (e.g. once it gets a reply) gets its row updated. Column H
// (Review ID) is an internal key used to match rows on re-runs; the rest
// are meant to be read directly.

import { createSign } from 'node:crypto';

const TAB_NAME = 'Reviews Log';
const HEADERS = ['Date', 'Rating', 'Review', 'Reviewer', 'Replied?', 'Reply Text', 'Status', 'Review ID'];

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getAccessToken(serviceAccountKeyJson) {
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

async function ensureTabAndHeaders(accessToken, spreadsheetId) {
  const meta = await sheetsRequest(accessToken, `${spreadsheetId}?fields=sheets.properties.title`);
  const exists = meta.sheets?.some((s) => s.properties.title === TAB_NAME);
  if (!exists) {
    await sheetsRequest(accessToken, `${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB_NAME } } }] }),
    });
  }
  const headerRange = encodeURIComponent(`${TAB_NAME}!A1:H1`);
  const headerRes = await sheetsRequest(accessToken, `${spreadsheetId}/values/${headerRange}`);
  if (!headerRes.values?.length) {
    const putRange = encodeURIComponent(`${TAB_NAME}!A1`);
    await sheetsRequest(accessToken, `${spreadsheetId}/values/${putRange}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [HEADERS] }),
    });
  }
}

// `rows` items are [date, rating, review, reviewer, repliedYesNo, replyText, status, reviewId]
export async function syncReviewsToSheet({ spreadsheetId, serviceAccountKeyJson, rows }) {
  const accessToken = await getAccessToken(serviceAccountKeyJson);
  await ensureTabAndHeaders(accessToken, spreadsheetId);

  const idRange = encodeURIComponent(`${TAB_NAME}!H2:H`);
  const idRes = await sheetsRequest(accessToken, `${spreadsheetId}/values/${idRange}`);
  const existingIds = (idRes.values ?? []).map((r) => r[0]);
  const idToRow = new Map(existingIds.map((id, i) => [id, i + 2])); // row 1 is the header

  const updates = [];
  const newRows = [];
  for (const row of rows) {
    const reviewId = row[7];
    const rowNumber = idToRow.get(reviewId);
    if (rowNumber) {
      updates.push({ range: `${TAB_NAME}!A${rowNumber}:H${rowNumber}`, values: [row] });
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
    const appendRange = encodeURIComponent(`${TAB_NAME}!A1`);
    await sheetsRequest(accessToken, `${spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: newRows }),
    });
  }

  return { updated: updates.length, added: newRows.length };
}
