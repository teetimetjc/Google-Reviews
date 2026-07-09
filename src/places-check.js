// On-demand review scan using the Google Places API.
//
// Unlike src/index.js (which needs approved Business Profile API access),
// this works with any Google Cloud project that has the Places API (New)
// enabled and an API key. Limitations: Places only returns the 5 most
// recent reviews and can't see whether the owner has replied.

import { createTransport, sendDigest } from './email.js';
import { loadState, saveState } from './state.js';
import { reviewId, subjectFor, buildHtml, buildText } from './placesFormat.js';

const {
  PLACES_API_KEY,
  PLACE_ID,
  BUSINESS_NAME = 'your business',
  EMAIL_FROM,
  EMAIL_TO,
  ALWAYS_SEND,
  STATE_PATH = 'state/places-notified.json',
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

const state = await loadState(STATE_PATH);
const newlyFlagged = flagged.filter((review) => !state[reviewId(review)]);

console.log(`${name}: overall ${place.rating}★ across ${place.userRatingCount} ratings.`);
console.log(`Checked the ${reviews.length} most recent reviews; ${flagged.length} below 5 stars (${newlyFlagged.length} new since last run).`);

// Remember every currently-flagged review so re-runs don't re-notify on it,
// and drop reviews that have aged out of the top 5 so the file doesn't grow forever.
const nextState = {};
for (const review of flagged) {
  nextState[reviewId(review)] = state[reviewId(review)] ?? new Date().toISOString();
}
await saveState(STATE_PATH, nextState);

if (newlyFlagged.length === 0 && ALWAYS_SEND !== 'true') {
  console.log('No new reviews to flag — skipping email.');
  process.exit(0);
}

const transport = createTransport(process.env);
await sendDigest({
  transport,
  from: EMAIL_FROM,
  to: EMAIL_TO,
  subject: subjectFor({ name, newlyFlagged }),
  html: buildHtml({ name, place, reviews, flagged, newlyFlagged }),
  text: buildText({ name, place, reviews, flagged, newlyFlagged }),
});
console.log(`Emailed results to ${EMAIL_TO}.`);
