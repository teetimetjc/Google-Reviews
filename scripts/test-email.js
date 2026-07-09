// Sends a sample digest using made-up reviews, so you can see exactly what
// a real alert will look like without waiting for an actual review to come
// in. Doesn't touch the Places API or any state file.

import { createTransport, sendDigest } from '../src/email.js';
import { subjectFor, buildHtml, buildText } from '../src/placesFormat.js';

const { BUSINESS_NAME = 'SOS Septic', EMAIL_FROM, EMAIL_TO } = process.env;

const place = {
  displayName: { text: BUSINESS_NAME },
  rating: 4.6,
  userRatingCount: 87,
  googleMapsUri: 'https://maps.google.com/?cid=0000000000000000000',
};

const reviews = [
  {
    name: 'fake-review-1',
    rating: 2,
    authorAttribution: { displayName: 'Jamie R.' },
    relativePublishTimeDescription: '3 days ago',
    text: { text: "Technician showed up late and didn't explain what was wrong. Still waiting to hear back about the follow-up visit." },
  },
  {
    name: 'fake-review-2',
    rating: 4,
    authorAttribution: { displayName: 'Morgan T.' },
    relativePublishTimeDescription: '1 week ago',
    text: { text: 'Good service overall, just wish scheduling had been easier.' },
  },
  {
    name: 'fake-review-3',
    rating: 5,
    authorAttribution: { displayName: 'Casey L.' },
    relativePublishTimeDescription: '2 weeks ago',
    text: { text: 'Fast, friendly, and fixed the issue on the first visit!' },
  },
];

const flagged = reviews.filter((review) => review.rating < 5);
const newlyFlagged = flagged; // pretend all of them are new, for the sample

const transport = createTransport(process.env);
await sendDigest({
  transport,
  from: EMAIL_FROM,
  to: EMAIL_TO,
  subject: `[TEST] ${subjectFor({ name: BUSINESS_NAME, newlyFlagged })}`,
  html: buildHtml({ name: BUSINESS_NAME, place, reviews, flagged, newlyFlagged }),
  text: buildText({ name: BUSINESS_NAME, place, reviews, flagged, newlyFlagged }),
});
console.log(`Sent a sample digest with fake reviews to ${EMAIL_TO}.`);
