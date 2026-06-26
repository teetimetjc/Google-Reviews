import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getAccessToken, fetchAllReviews, starRatingToNumber } from './googleBusinessProfile.js';
import { loadState, saveState } from './state.js';
import { createTransport, sendDigest } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'state', 'notified.json');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'locations.json');

function escapeHtml(str = '') {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function daysSince(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000);
}

function buildHtml(sections) {
  if (!sections.length) {
    return '<p>No reviews below 5 stars are currently awaiting a response.</p>';
  }
  const body = sections
    .map(({ name, manageUrl, reviews }) => {
      const items = reviews
        .map(({ review, stars, outstandingDays }) => `
        <li style="margin-bottom:12px;">
          <strong>${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</strong>
          &mdash; ${escapeHtml(review.reviewer?.displayName || 'Anonymous')}
          (${new Date(review.createTime).toLocaleDateString()}, outstanding ${outstandingDays}d)<br/>
          <em>${escapeHtml(review.comment || '(no written comment)')}</em>
        </li>`)
        .join('\n');
      const link = manageUrl
        ? `<p><a href="${manageUrl}">Reply to reviews for ${escapeHtml(name)}</a></p>`
        : '';
      return `<h3>${escapeHtml(name)} &mdash; ${reviews.length} review(s) need a response</h3><ul>${items}</ul>${link}`;
    })
    .join('\n');
  return `<div>${body}</div>`;
}

function buildText(sections) {
  if (!sections.length) {
    return 'No reviews below 5 stars are currently awaiting a response.';
  }
  return sections
    .map(({ name, reviews }) => {
      const lines = reviews.map(
        ({ review, stars, outstandingDays }) =>
          `- [${stars}★] ${review.reviewer?.displayName || 'Anonymous'} (outstanding ${outstandingDays}d): ${review.comment || '(no written comment)'}`,
      );
      return `${name} — ${reviews.length} review(s) need a response\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

async function main() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
    EMAIL_FROM,
    EMAIL_TO,
    ALWAYS_SEND,
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN env vars');
  }
  if (!EMAIL_TO) {
    throw new Error('Missing EMAIL_TO env var');
  }

  const locations = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  if (!locations.length) {
    console.log('No locations configured in config/locations.json - nothing to do.');
    return;
  }

  const accessToken = await getAccessToken({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    refreshToken: GOOGLE_REFRESH_TOKEN,
  });

  const previousState = await loadState(STATE_PATH);
  const newState = {};
  const sections = [];
  let totalFlagged = 0;

  for (const location of locations) {
    const { name, accountId, locationId, manageUrl } = location;
    console.log(`Fetching reviews for ${name} (${accountId}/${locationId})...`);
    const reviews = await fetchAllReviews({ accessToken, accountId, locationId });

    const flagged = [];
    for (const review of reviews) {
      const stars = starRatingToNumber(review.starRating);
      if (stars === null || stars >= 5 || review.reviewReply) continue;

      const firstSeenAt = previousState[review.name]?.firstSeenAt ?? new Date().toISOString();
      newState[review.name] = { firstSeenAt, rating: review.starRating };
      flagged.push({ review, stars, outstandingDays: daysSince(firstSeenAt) });
    }

    if (flagged.length) {
      sections.push({ name, manageUrl, reviews: flagged });
      totalFlagged += flagged.length;
    }
  }

  await saveState(STATE_PATH, newState);

  if (!totalFlagged && ALWAYS_SEND !== 'true') {
    console.log('No unanswered reviews below 5 stars. No email sent.');
    return;
  }

  const transport = createTransport(process.env);
  await sendDigest({
    transport,
    from: EMAIL_FROM || EMAIL_TO,
    to: EMAIL_TO,
    subject: `Google Reviews needing a response (${totalFlagged})`,
    html: buildHtml(sections),
    text: buildText(sections),
  });

  console.log(`Sent digest for ${totalFlagged} review(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
