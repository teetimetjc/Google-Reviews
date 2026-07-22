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
import { createTransport } from '../src/email.js';

const {
  SHEETS_SPREADSHEET_ID,
  GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY,
  ANTHROPIC_API_KEY,
  BUSINESS_NAME,
  BUSINESS_PHONE,
  MAX_DRAFTS_PER_RUN,
  PUSHOVER_TOKEN,
  PUSHOVER_USER,
  EMAIL_FROM,
  EMAIL_TO,
} = process.env;

const TAB = 'Reviews Log';
const businessName = BUSINESS_NAME || 'S.O.S. Septic';
const businessPhone = BUSINESS_PHONE || '941-473-1767';
// Caps API calls on any single run (mainly matters the first time this runs
// against a sheet with years of backfilled reviews) — the rest get picked
// up on the next scheduled run. Raise via env var if a bigger batch is fine.
const maxDrafts = Number(MAX_DRAFTS_PER_RUN) || 25;

// Modeled on real replies the office has written (narrative, specific,
// technicians credited by name) rather than a generic template.
const SYSTEM_PROMPT = `
You are writing a public reply, posted from ${businessName} (a family-owned septic tank service company), to a customer's Google review. Match the voice the office actually uses: warm, conversational, and specific — never a generic template that could apply to any business.

Two real examples of the house style, for calibration:

Example 1 (5-star):
"Thank you Sue for the ⭐⭐⭐⭐⭐!

It means a great deal to have both of your recent visits recognized. Vince and Johnny did an excellent job installing the outlet T, filter, and risers, giving you easier access while keeping the area practical for your lawnmower.

We'll also be sure to let Robert and Matt know you appreciated the septic pumping they completed in June. Thank you for trusting SOS Septic with both projects and for recommending us to your friends and family!"

Example 2 (low rating / dispute):
"Hi Cynthia, we're sorry to hear you were unhappy with the experience.

When the appointment was scheduled, the standard septic pumping price of $400 was quoted. That price applies when the tank is accessible and within a normal depth. When our technician arrived, the tank was buried deeper than typical and the soil on the property is hard clay, which makes probing and locating the tank more difficult and time-consuming.

Our technician attempted to locate and expose the tank but explained that due to the depth and soil conditions it would require additional time and labor to complete the job. We understand that was frustrating, and we're sorry the visit didn't go as expected.

We do appreciate that you've used our company in the past, and if you'd like to discuss the situation further, please feel free to contact our office so we can review it with you."

Rules:
- Address the reviewer by first name if one is given, otherwise open without a name (skip "Anonymous" — just don't name anyone).
- Write 2-5 sentences across 1-3 short paragraphs, like the examples above — not a one-liner, not a wall of text.
- Reference the specifics from the review: what was done, timing, pricing, or anything else mentioned. If the review names a technician, credit that technician by name in the reply. Never write something generic.
- For 4-5 star reviews: thank them specifically for what they mentioned and the technician(s) named, and close with an invitation for future service or a thank-you for their trust/recommendation.
- For 3 star reviews: thank them, acknowledge the specific concern they raised without being defensive, and briefly note it for next time.
- For 1-2 star reviews (or any review describing a real problem): open acknowledging their frustration, then explain what actually happened using only details grounded in the review itself — do not invent specifics (pricing, technician actions, cause) that aren't in the review text; if the review doesn't explain the issue in enough detail to address factually, give a brief genuine apology instead of guessing at facts. Stay factual and non-defensive, don't make excuses, and close by inviting them to call the office at ${businessPhone} to resolve it. Do not name a specific staff member to ask for. Do not promise a specific outcome (refund, redo, discount) — that isn't decided in a review reply.
- Do not add a signature line (no "– The Team", no name) — end naturally on the closing sentence, like both examples above.
- Plain text only. No markdown, no subject line — this is the literal text that goes in the Google reply box. Emoji only if the review itself uses them heavily.
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

// Best-effort email alert on failure (credits ran out, bad key, Sheets
// error, etc). Reuses the SMTP setup already configured for the review
// digest, so no new notification service is required.
async function notifyFailure(error) {
  console.error(error);
  if (!EMAIL_TO) return;
  try {
    const transport = createTransport(process.env);
    await transport.sendMail({
      from: EMAIL_FROM || EMAIL_TO,
      to: EMAIL_TO,
      subject: 'Google Reviews: AI draft-reply run failed',
      text: [
        'The "Generate Draft Review Replies" workflow failed to complete:',
        '',
        error.message || String(error),
        '',
        'Common cause: Anthropic API credits ran out — check console.anthropic.com/settings/billing.',
        'Full logs: the Actions tab on the Google-Reviews GitHub repo.',
      ].join('\n'),
    });
  } catch (emailErr) {
    console.error('Also failed to send the failure notification email:', emailErr.message);
  }
}

async function run() {
  if (!SHEETS_SPREADSHEET_ID || !GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY) {
    throw new Error('Set SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY env vars first.');
  }
  if (!ANTHROPIC_API_KEY) {
    throw new Error('Set ANTHROPIC_API_KEY env var first.');
  }

  const accessToken = await getAccessToken(GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY);
  const range = encodeURIComponent(`${TAB}!A1:Z100000`);
  const { values = [] } = await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values/${range}`);

  if (values.length < 2) {
    console.log('No review rows found, nothing to do.');
    return;
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
      throw new Error(`Column "${name}" not found in header row — run the review-check workflow first so the sheet schema is up to date.`);
    }
  }

  const responseStatusCol = columnLetter(col.responseStatus);
  const draftResponseCol = columnLetter(col.draftResponse);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let drafted = 0;
  let markedPosted = 0;
  let skippedCap = 0;
  const updates = [];
  let draftingError = null;

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

    try {
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
    } catch (err) {
      // Stop drafting (further calls will likely fail the same way — out
      // of credits, bad key, etc) but keep whatever was already drafted
      // this run so it isn't lost.
      draftingError = err;
      break;
    }
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

  if (draftingError) {
    throw draftingError;
  }
}

run().catch(async (err) => {
  await notifyFailure(err);
  process.exitCode = 1;
});
