// Reads the "Reviews Log" tab, and for every row still awaiting a draft
// (Response Status is "pending" or blank), either:
//   - marks it "posted" with no API call, if the review already has a real
//     reply (nothing for the human to review), or
//   - calls Claude to write a suggested reply, writes it into "Draft
//     Response", and sets Response Status to "drafted".
//
// Reviews posted before DRAFT_CUTOFF are left alone entirely (no API call,
// stays "pending") — this is what keeps a large historical backlog from
// costing money on every run; only reviews from the cutoff forward get
// drafted.
//
// Human stays in the loop: drafts are for manual copy/paste into Google
// Business Profile, never auto-posted. This never touches any other column.
//
// Every new draft also gets a row in the separate "Approval Tracking" tab
// (Approval Status: Draft), so a human can move it through
// Draft -> Approved -> Sent/Skipped and see how long that takes. That tab
// is deliberately separate from "Reviews Log" rather than new columns on
// it — Reviews Log gets re-sorted newest-first on every hourly sync run,
// and that sort only reorders columns A-O (its existing width), so any
// data bolted onto new columns past O would stop following its row the
// next time a sort runs and end up attached to the wrong review.
//
// Each generated draft also runs through a simple guardrail check (links,
// promo/discount language, guarantees, profanity, ALL CAPS, competitor
// names). A draft that fails is still written to "Draft Response" for a
// human to see and fix, but its Approval Tracking row gets "Flagged"
// instead of "Draft", so it surfaces for a closer look instead of looking
// ready to copy/paste as-is.

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
  DRAFT_CUTOFF,
  PUSHOVER_TOKEN,
  PUSHOVER_USER,
  EMAIL_FROM,
  EMAIL_TO,
} = process.env;

const TAB = 'Reviews Log';
const APPROVAL_TAB = 'Approval Tracking';
const APPROVAL_HEADERS = ['Review ID', 'Date', 'Reviewer', 'Rating', 'Approval Status', 'Approval Status Updated'];
const COMPETITORS_TAB = 'Competitors';
const LAST_ROW = 100000;

const businessName = BUSINESS_NAME || 'S.O.S. Septic';
const businessPhone = BUSINESS_PHONE || '941-473-1767';
// Caps API calls on any single run — mostly a safety net now that
// DRAFT_CUTOFF keeps the historical backlog out of scope.
const maxDrafts = Number(MAX_DRAFTS_PER_RUN) || 25;
// Only reviews posted on/after this date get drafted. Reviews older than
// this are skipped with no API call and stay "pending" indefinitely — set
// this to "now" whenever you want to draw a line under the backlog.
const draftCutoff = DRAFT_CUTOFF ? new Date(DRAFT_CUTOFF) : null;

// Modeled on real replies the office has written (narrative, specific,
// technicians credited by name) rather than a generic template.
const SYSTEM_PROMPT = `
You are writing a public reply, posted from ${businessName} (a family-owned septic tank service company), to a customer's Google review. Match the voice the office actually uses: friendly, professional, conversational, and specific, with no corporate jargon. Never write a generic template that could apply to any business.

Two real examples of the house style, for calibration:

Example 1 (5-star):
"Thank you Sue for the 5 stars!

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
- For 1-2 star reviews (or any review describing a real problem): open acknowledging their frustration, then explain what actually happened using only details grounded in the review itself. Do not invent specifics (pricing, technician actions, cause) that aren't in the review text; if the review doesn't explain the issue in enough detail to address factually, give a brief genuine apology instead of guessing at facts. Stay factual and non-defensive, don't make excuses, and close by inviting them to call the office at ${businessPhone} to resolve it. Do not name a specific staff member to ask for.
- Never mention any other septic, plumbing, or sanitation company by name, even to compare or contrast.
- Never include a promo code, coupon, discount offer, "% off," or any link/URL.
- Never guarantee an outcome (refund, redo, warranty) or make a specific claim about pricing beyond what's already stated in the review itself — pricing and resolution aren't decided in a review reply.
- Never use profanity or write any word in ALL CAPS for emphasis.
- Do not add a signature line (no "– The Team", no name) — end naturally on the closing sentence, like both examples above.
- Never use emoji, even if the review itself uses them.
- Never use an em dash or double hyphen (— or --). Use a period, comma, semicolon, or the word "and" instead.
- Plain text only. No markdown, no subject line. This is the literal text that goes in the Google reply box.
- Under 120 words.
`.trim();

// Backstop for the prompt rules above — a simple keyword/pattern pass over
// each generated draft. Not exhaustive, just enough to catch an obvious
// slip and route it to a human instead of marking it ready to copy/paste.
const BANNED_PHRASES = ['guarantee', 'guaranteed', 'promo', 'coupon', 'discount code', '% off', 'percent off'];
const PROFANITY = ['fuck', 'shit', 'damn', 'bitch', 'asshole'];

function checkGuardrails(text, competitorNames) {
  const reasons = [];
  const lower = text.toLowerCase();

  if (/https?:\/\/|www\.[a-z0-9]/i.test(text)) reasons.push('contains a link');

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) reasons.push(`contains "${phrase}"`);
  }
  for (const word of PROFANITY) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) reasons.push('contains profanity');
  }
  if (/\b[A-Z]{4,}\b/.test(text)) reasons.push('contains an ALL CAPS word');

  for (const name of competitorNames) {
    if (name && lower.includes(name.toLowerCase())) reasons.push(`mentions competitor "${name}"`);
  }

  return reasons;
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

function columnLetter(index) {
  return String.fromCharCode(65 + index);
}

// Creates "Approval Tracking" with its header row only if it doesn't exist
// yet. If it already exists, this never touches it again — it's an
// append-only log the human can freely sort/filter/edit by hand.
async function ensureApprovalTab(accessToken, spreadsheetId) {
  const meta = await sheetsRequest(accessToken, `${spreadsheetId}?fields=sheets.properties(title,sheetId)`);
  const exists = meta.sheets?.some((s) => s.properties.title === APPROVAL_TAB);
  if (exists) return;

  await sheetsRequest(accessToken, `${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: APPROVAL_TAB } } }] }),
  });
  const range = encodeURIComponent(`${APPROVAL_TAB}!A1`);
  await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [APPROVAL_HEADERS] }),
  });
  console.log(`Created "${APPROVAL_TAB}" tab.`);
}

// Review IDs that already have an Approval Tracking row, so a re-run never
// appends a duplicate for the same review.
async function fetchExistingApprovalIds(accessToken, spreadsheetId) {
  const range = encodeURIComponent(`${APPROVAL_TAB}!A2:A${LAST_ROW}`);
  const { values = [] } = await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}`);
  return new Set(values.map((row) => (row[0] ?? '').toString().trim()).filter(Boolean));
}

// Best-effort: reuses the competitor list already maintained for
// competitor-gbp-tracker.js so the guardrail check knows their names.
// Missing tab or read error just means an empty list, not a failed run.
async function fetchCompetitorNames(accessToken, spreadsheetId) {
  try {
    const range = encodeURIComponent(`${COMPETITORS_TAB}!A2:A${LAST_ROW}`);
    const { values = [] } = await sheetsRequest(accessToken, `${spreadsheetId}/values/${range}`);
    return values.map((row) => (row[0] ?? '').toString().trim()).filter(Boolean);
  } catch {
    return [];
  }
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

  await ensureApprovalTab(accessToken, SHEETS_SPREADSHEET_ID);
  const existingApprovalIds = await fetchExistingApprovalIds(accessToken, SHEETS_SPREADSHEET_ID);
  const competitorNames = await fetchCompetitorNames(accessToken, SHEETS_SPREADSHEET_ID);

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
    reviewId: header.indexOf('Review ID'),
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
  let flagged = 0;
  let markedPosted = 0;
  let skippedCap = 0;
  let skippedOld = 0;
  const updates = [];
  const approvalRows = [];
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

    if (draftCutoff) {
      const reviewDate = row[col.date] ? new Date(row[col.date]) : null;
      if (!reviewDate || reviewDate < draftCutoff) {
        skippedOld++;
        continue;
      }
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

      const reviewId = row[col.reviewId];
      if (reviewId && !existingApprovalIds.has(reviewId)) {
        const flagReasons = checkGuardrails(draft, competitorNames);
        const approvalStatus = flagReasons.length ? 'Flagged' : 'Draft';
        if (flagReasons.length) {
          flagged++;
          console.warn(`Flagged draft for review ${reviewId}: ${flagReasons.join('; ')}`);
        }
        approvalRows.push([reviewId, row[col.date] ?? '', row[col.reviewer] ?? '', row[col.rating] ?? '', approvalStatus, new Date().toISOString()]);
        existingApprovalIds.add(reviewId);
      }
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

  if (approvalRows.length) {
    const appendRange = encodeURIComponent(`${APPROVAL_TAB}!A1`);
    await sheetsRequest(accessToken, `${SHEETS_SPREADSHEET_ID}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: approvalRows }),
    });
  }

  console.log(`Drafted ${drafted} new repl${drafted === 1 ? 'y' : 'ies'} (${approvalRows.length} added to Approval Tracking${flagged ? `, ${flagged} flagged for guardrail review` : ''}), marked ${markedPosted} already-replied row(s) as posted${skippedOld ? `, skipped ${skippedOld} pre-cutoff review(s)` : ''}${skippedCap ? `, ${skippedCap} more left pending for next run (hit the ${maxDrafts}-per-run cap)` : ''}.`);

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
