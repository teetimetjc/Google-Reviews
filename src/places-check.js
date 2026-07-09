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
  FLAG_ALL_REVIEWS,
  STATE_PATH = 'state/places-notified.json',
  PREVIEW_STATE_PATH = 'state/places-notified-preview.json',
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
const flagAllReviews = FLAG_ALL_REVIEWS === 'true';
const flagged = flagAllReviews ? reviews : reviews.filter((review) => review.rating < 5);
const criteriaLabel = flagAllReviews ? '(preview mode: all ratings)' : 'under 5 stars';
const name = place.displayName?.text ?? BUSINESS_NAME;

// Preview mode (FLAG_ALL_REVIEWS) uses its own state file so it can dedupe
// independently without touching the real under-5-stars tracking.
const activeStatePath = flagAllReviews ? PREVIEW_STATE_PATH : STATE_PATH;
const state = await loadState(activeStatePath);
const newlyFlagged = flagged.filter((review) => !state[reviewId(review)]);

console.log(`${name}: overall ${place.rating}★ across ${place.userRatingCount} ratings.`);
console.log(`Checked the ${reviews.length} most recent reviews; ${flagged.length} flagged ${criteriaLabel} (${newlyFlagged.length} new since last run).`);

// Remember every currently-flagged review so re-runs don't re-notify on it,
// and drop reviews that have aged out of the top 5 so the file doesn't grow forever.
const nextState = {};
for (const review of flagged) {
  nextState[reviewId(review)] = state[reviewId(review)] ?? new Date().toISOString();
}
await saveState(activeStatePath, nextState);

if (newlyFlagged.length === 0 && ALWAYS_SEND !== 'true') {
  console.log('No new reviews to flag — skipping email.');
  process.exit(0);
}

const transport = createTransport(process.env);
await sendDigest({
  transport,
  from: EMAIL_FROM,
  to: EMAIL_TO,
  subject: subjectFor({ name, newlyFlagged, criteriaLabel }),
  html: buildHtml({ name, place, reviews, flagged, newlyFlagged, criteriaLabel }),
  text: buildText({ name, place, reviews, flagged, newlyFlagged, criteriaLabel }),
});
console.log(`Emailed results to ${EMAIL_TO}.`);
