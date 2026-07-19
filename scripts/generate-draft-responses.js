// Reads the "Reviews Log" tab, and for every row still awaiting a draft
// (Response Status is "pending" or blank), either:
//   - marks it "posted" with no API call, if the review already has a real
//     reply (nothing for the human to review), or
//   - calls Claude to write a suggested reply, writes it into "Draft
//     Response", and sets Response Status to "drafted".
//
// Human stays in the loop: drafts are for manual copy/paste into Google
// Business Profile, never auto-posted. This never touches any other column.

import Anthropic from '@anthropic-ai/sdk';
import { getAccessToken } from '../src/sheetsSync.js';

const {
  SHEETS_SPREADSHEET_ID,
  GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY,
  ANTHROPIC_API_KEY,
  BUSINESS_NAME,
  MAX_DRAFTS_PER_RUN,
  PUSHOVER_TOKEN,
  PUSHOVER_USER,
} = process.env;

if (!SHEETS_SPREADSHEET_ID || !GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY) {
  console.error('Set SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY env vars first.');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY env var first.');
  process.exit(1);
}

const TAB = 'Reviews Log';
const businessName = BUSINESS_NAME || 'S.O.S. Septic';
// Caps API calls on any single run (mainly matters the first time this runs
// against a sheet with years of backfilled reviews) — the rest get picked
// up on the next scheduled run. Raise via env var if a bigger batch is fine.
const maxDrafts = Number(MAX_DRAFTS_PER_RUN) || 25;

const SYSTEM_PROMPT = `
You are writing a public reply, posted from ${businessName} (a family-owned septic tank service company), to a customer's Google review. Write in ${businessName}'s voice: warm, plain-spoken, and genuinely appreciative — like a local business owner who knows their customers, not a corporate script.

Rules:
- Address the reviewer by first name if one is given, otherwise "there".
- Reference at least one specific detail from their review (what they mentioned about the service, the technician, timing, price, etc.). Never write something generic that could apply to any business.
- For 4-5 star reviews: keep it short (2-4 sentences), thank them specifically for what they mentioned, and invite them back for future service.
- For 3 star reviews: thank them, acknowledge the specific concern they raised without being defensive, and briefly note it's noted for next time.
- For 1-2 star reviews: open with a genuine, specific apology (not "sorry you feel that way"), acknowledge exactly what went wrong per their review, don't argue details or make excuses in public, and invite them to call the office directly so it can be made right. Do not promise a specific outcome (refund, redo, discount) — that isn't decided in a review reply.
- Sign off as "– The ${businessName} Team", never an individual's name.
- Plain text only. No markdown, no emojis, no subject line — this is the literal text that goes in the Google reply box.
- Under 120 words.
`.trim();

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

function columnLetter(index) {
  return String.fromCharCode(65 + index);
}

async function draftReply(client, { reviewer, rating, comment, date }) {
  const dateStr = date ? new Date(date).toLocaleDateString() : 'an unknown date';
  const userMessage = [
    `Reviewer: ${reviewer || 'Anonymous'}`,
    `Rating: ${rating} out of 5 stars`,
    `Date posted: ${dateStr}`,
    `Review text: ${comment ? `"${comment}"` : '(no written comment, star rating only)'}`,
    '',
    'Write the reply.',
  ].join('\n');

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock?.text?.trim() ?? '';
}

async function notifyPushover(count) {
  if (!PUSHOVER_TOKEN || !PUSHOVER_USER) return;
  await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: PUSHOVER_TOKEN,
      user: PUSHOVER_USER,
      title: 'Google review draft replies ready',
      message: `${count} new draft ${count === 1 ? 'reply is' : 'replies are'} ready for review in the Reviews Log sheet.`,
    }),
  });
}

const accessToken = await getAccessToken(GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY);
const range = encodeURIComponent(`${TAB}!A1:Z100000`);
const { values = [] } = await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values/${range}`);

if (values.length < 2) {
  console.log('No review rows found, nothing to do.');
  process.exit(0);
}

const [header, ...rows] = values;
const col = {
  date: header.indexOf('Date'),
  rating: header.indexOf('Rating'),
  review: header.indexOf('Review'),
  reviewer: header.indexOf('Reviewer'),
  replied: header.indexOf('Replied?'),
  responseStatus: header.indexOf('Response Status'),
  draftResponse: header.indexOf('Draft Response'),
};
for (const [name, index] of Object.entries(col)) {
  if (index === -1) {
    console.error(`Column "${name}" not found in header row — run the review-check workflow first so the sheet schema is up to date.`);
    process.exit(1);
  }
}

const responseStatusCol = columnLetter(col.responseStatus);
const draftResponseCol = columnLetter(col.draftResponse);

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

let drafted = 0;
let markedPosted = 0;
let skippedCap = 0;
const updates = [];

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const status = (row[col.responseStatus] ?? '').toString().trim().toLowerCase();
  if (status && status !== 'pending') continue;

  const rowNumber = i + 2;
  const alreadyReplied = (row[col.replied] ?? '').toString().trim() === 'Yes';

  if (alreadyReplied) {
    updates.push({
      range: `${TAB}!${responseStatusCol}${rowNumber}`,
      values: [['posted']],
    });
    markedPosted++;
    continue;
  }

  if (drafted >= maxDrafts) {
    skippedCap++;
    continue;
  }

  const draft = await draftReply(client, {
    reviewer: row[col.reviewer],
    rating: row[col.rating],
    comment: row[col.review],
    date: row[col.date],
  });

  updates.push({
    range: `${TAB}!${responseStatusCol}${rowNumber}:${draftResponseCol}${rowNumber}`,
    values: [['drafted', draft]],
  });
  drafted++;
}

if (updates.length) {
  await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
  });
}

console.log(`Drafted ${drafted} new repl${drafted === 1 ? 'y' : 'ies'}, marked ${markedPosted} already-replied row(s) as posted${skippedCap ? `, ${skippedCap} more left pending for next run (hit the ${maxDrafts}-per-run cap)` : ''}.`);

if (drafted > 0) {
  await notifyPushover(drafted);
}
