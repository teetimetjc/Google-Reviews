// On-demand review scan using the Google Places API.
//
// Unlike src/index.js (which needs approved Business Profile API access),
// this works with any Google Cloud project that has the Places API (New)
// enabled and an API key. Limitations: Places only returns the 5 most
// recent reviews and can't see whether the owner has replied.

import { createTransport, sendDigest } from './email.js';

const {
  PLACES_API_KEY,
  PLACE_ID,
  BUSINESS_NAME = 'your business',
  EMAIL_FROM,
  EMAIL_TO,
} = process.env;

if (!PLACES_API_KEY || !PLACE_ID) {
  console.error('Set PLACES_API_KEY and PLACE_ID env vars first.');
  process.exit(1);
}

const res = await fetch(`https://places.googleapis.com/v1/places/${PLACE_ID}`, {
  headers: {
    'X-Goog-Api-Key': PLACES_API_KEY,
    'X-Goog-FieldMask': 'displayName,rating,userRatingCount,googleMapsUri,reviews',
  },
});
if (!res.ok) {
  throw new Error(`Places API request failed: ${res.status} ${await res.text()}`);
}
const place = await res.json();

const reviews = place.reviews ?? [];
const flagged = reviews.filter((review) => review.rating < 5);
const name = place.displayName?.text ?? BUSINESS_NAME;

console.log(`${name}: overall ${place.rating}★ across ${place.userRatingCount} ratings.`);
console.log(`Checked the ${reviews.length} most recent reviews; ${flagged.length} below 5 stars.`);
for (const review of flagged) {
  console.log(`  ${review.rating}★ — ${review.authorAttribution?.displayName ?? 'Anonymous'} (${review.relativePublishTimeDescription ?? review.publishTime})`);
}

const subject = flagged.length > 0
  ? `⭐ ${name}: ${flagged.length} recent review(s) under 5 stars`
  : `✅ ${name}: no recent reviews under 5 stars`;

const transport = createTransport(process.env);
await sendDigest({
  transport,
  from: EMAIL_FROM,
  to: EMAIL_TO,
  subject,
  html: buildHtml({ name, place, reviews, flagged }),
  text: buildText({ name, place, reviews, flagged }),
});
console.log(`Emailed results to ${EMAIL_TO}.`);

function buildHtml({ name, place, reviews, flagged }) {
  const rows = flagged.map((review) => `
    <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0;">
      <strong>${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)} (${review.rating}/5)</strong>
      — ${escapeHtml(review.authorAttribution?.displayName ?? 'Anonymous')}
      <span style="color:#666;">(${escapeHtml(review.relativePublishTimeDescription ?? review.publishTime ?? '')})</span>
      <p style="margin:8px 0 0;">${escapeHtml(review.text?.text ?? review.originalText?.text ?? '(no comment left)')}</p>
    </div>`).join('');

  return `
    <h2>${escapeHtml(name)} — review scan</h2>
    <p>Overall rating: <strong>${place.rating}★</strong> across ${place.userRatingCount} ratings.</p>
    <p>Checked the ${reviews.length} most recent reviews Google exposes:
      <strong>${flagged.length}</strong> below 5 stars.</p>
    ${rows || '<p>Nothing needs attention right now. 🎉</p>'}
    <p><a href="${escapeHtml(place.googleMapsUri ?? 'https://business.google.com/reviews')}">Open the listing on Google Maps</a>
      &middot; <a href="https://business.google.com/reviews">Reply to reviews</a></p>
    <p style="color:#666;font-size:12px;">Note: the Places API only exposes the 5 most recent
      reviews, so older unanswered reviews won't appear here.</p>`;
}

function buildText({ name, place, reviews, flagged }) {
  const lines = [
    `${name} — review scan`,
    `Overall rating: ${place.rating} stars across ${place.userRatingCount} ratings.`,
    `Checked the ${reviews.length} most recent reviews; ${flagged.length} below 5 stars.`,
    '',
  ];
  for (const review of flagged) {
    lines.push(`${review.rating}/5 — ${review.authorAttribution?.displayName ?? 'Anonymous'} (${review.relativePublishTimeDescription ?? review.publishTime ?? ''})`);
    lines.push(review.text?.text ?? review.originalText?.text ?? '(no comment left)');
    lines.push('');
  }
  if (flagged.length === 0) lines.push('Nothing needs attention right now.');
  lines.push(`Reply to reviews: https://business.google.com/reviews`);
  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
