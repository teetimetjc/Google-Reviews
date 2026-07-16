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

function buildHtml(sections, emptyMessage) {
  if (!sections.length) {
    return `<p>${escapeHtml(emptyMessage)}</p>`;
  }
  const body = sections
    .map(({ name, manageUrl, reviews }) => {
      const items = reviews
        .map(({ review, stars, outstandingDays, isNew }) => `
        <li style="margin-bottom:12px;">
          <strong>${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</strong>
          ${isNew ? '<span style="color:#c00;font-weight:bold;"> NEW</span>' : ''}
          &mdash; ${escapeHtml(review.reviewer?.displayName || 'Anonymous')}
          (${new Date(review.createTime).toLocaleDateString()}, outstanding ${outstandingDays}d)<br/>
          <em>${escapeHtml(review.comment || '(no written comment)')}</em>
        </li>`)
        .join('\n');
      const link = manageUrl
        ? `<p><a href="${manageUrl}">Reply to reviews for ${escapeHtml(name)}</a></p>`
        : '';
      return `<h3>${escapeHtml(name)} &mdash; ${reviews.length} review(s)</h3><ul>${items}</ul>${link}`;
    })
    .join('\n');
  return `<div>${body}</div>`;
}

function buildText(sections, emptyMessage) {
  if (!sections.length) {
    return emptyMessage;
  }
  return sections
    .map(({ name, reviews }) => {
      const lines = reviews.map(
        ({ review, stars, outstandingDays, isNew }) =>
          `- [${stars}★]${isNew ? ' [NEW]' : ''} ${review.reviewer?.displayName || 'Anonymous'} (outstanding ${outstandingDays}d): ${review.comment || '(no written comment)'}`,
      );
      return `${name} — ${reviews.length} review(s)\n${lines.join('\n')}`;
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
    ONLY_FLAG_BELOW_5,
    NOTIFY_ONLY_NEW,
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN env vars');
  }
  if (!EMAIL_TO) {
    throw new Error('Missing EMAIL_TO env var');
  }

  // Production default: only below-5-star reviews without a reply, resent
  // every day until resolved. Set ONLY_FLAG_BELOW_5=false + NOTIFY_ONLY_NEW=true
  // to instead get a one-time alert for every new review of any rating,
  // as soon as it appears — useful for confirming the pipeline is alive
  // without waiting for a genuinely low review to show up.
  const onlyBelow5 = ONLY_FLAG_BELOW_5 !== 'false';
  const onlyNew = NOTIFY_ONLY_NEW === 'true';
  const emptyMessage = onlyBelow5
    ? 'No reviews below 5 stars are currently awaiting a response.'
    : 'No new reviews since the last check.';

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
      if (stars === null) continue;
      if (onlyBelow5 && (stars >= 5 || review.reviewReply)) continue;

      const isNew = !previousState[review.name];
      const firstSeenAt = previousState[review.name]?.firstSeenAt ?? new Date().toISOString();
      newState[review.name] = { firstSeenAt, rating: review.starRating };

      if (onlyNew && !isNew) continue;

      flagged.push({ review, stars, outstandingDays: daysSince(firstSeenAt), isNew });
    }

    if (flagged.length) {
      sections.push({ name, manageUrl, reviews: flagged });
      totalFlagged += flagged.length;
    }
  }

  await saveState(STATE_PATH, newState);

  if (!totalFlagged && ALWAYS_SEND !== 'true') {
    console.log(emptyMessage, 'No email sent.');
    return;
  }

  const transport = createTransport(process.env);
  await sendDigest({
    transport,
    from: EMAIL_FROM || EMAIL_TO,
    to: EMAIL_TO,
    subject: onlyBelow5
      ? `Google Reviews needing a response (${totalFlagged})`
      : `Google Reviews: ${totalFlagged} new review(s)`,
    html: buildHtml(sections, emptyMessage),
    text: buildText(sections, emptyMessage),
  });

  console.log(`Sent digest for ${totalFlagged} review(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
