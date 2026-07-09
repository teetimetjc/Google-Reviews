export function reviewId(review) {
  return review.name ?? `${review.authorAttribution?.displayName ?? 'anon'}|${review.publishTime ?? ''}|${review.rating}`;
}

export function subjectFor({ name, newlyFlagged, criteriaLabel }) {
  return newlyFlagged.length > 0
    ? `⭐ ${name}: ${newlyFlagged.length} new review(s) ${criteriaLabel}`
    : `✅ ${name}: no new reviews ${criteriaLabel}`;
}

export function buildHtml({ name, place, reviews, flagged, newlyFlagged, criteriaLabel }) {
  const newIds = new Set(newlyFlagged.map(reviewId));
  const rows = flagged.map((review) => `
    <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0;">
      <strong>${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)} (${review.rating}/5)</strong>
      ${newIds.has(reviewId(review)) ? '<span style="color:#c00;font-weight:bold;"> NEW</span>' : '<span style="color:#666;"> (already flagged previously)</span>'}
      — ${escapeHtml(review.authorAttribution?.displayName ?? 'Anonymous')}
      <span style="color:#666;">(${escapeHtml(review.relativePublishTimeDescription ?? review.publishTime ?? '')})</span>
      <p style="margin:8px 0 0;">${escapeHtml(review.text?.text ?? review.originalText?.text ?? '(no comment left)')}</p>
    </div>`).join('');

  return `
    <h2>${escapeHtml(name)} — review scan</h2>
    <p>Overall rating: <strong>${place.rating}★</strong> across ${place.userRatingCount} ratings.</p>
    <p>Checked the ${reviews.length} most recent reviews Google exposes:
      <strong>${flagged.length}</strong> ${criteriaLabel}, <strong>${newlyFlagged.length}</strong> new since the last scan.</p>
    ${rows || '<p>Nothing needs attention right now. 🎉</p>'}
    <p><a href="${escapeHtml(place.googleMapsUri ?? 'https://business.google.com/reviews')}">Open the listing on Google Maps</a>
      &middot; <a href="https://business.google.com/reviews">Reply to reviews</a></p>
    <p style="color:#666;font-size:12px;">Note: the Places API only exposes the 5 most recent
      reviews, so older unanswered reviews won't appear here.</p>`;
}

export function buildText({ name, place, reviews, flagged, newlyFlagged, criteriaLabel }) {
  const newIds = new Set(newlyFlagged.map(reviewId));
  const lines = [
    `${name} — review scan`,
    `Overall rating: ${place.rating} stars across ${place.userRatingCount} ratings.`,
    `Checked the ${reviews.length} most recent reviews; ${flagged.length} ${criteriaLabel}, ${newlyFlagged.length} new since the last scan.`,
    '',
  ];
  for (const review of flagged) {
    lines.push(`${review.rating}/5${newIds.has(reviewId(review)) ? ' [NEW]' : ' [already flagged]'} — ${review.authorAttribution?.displayName ?? 'Anonymous'} (${review.relativePublishTimeDescription ?? review.publishTime ?? ''})`);
    lines.push(review.text?.text ?? review.originalText?.text ?? '(no comment left)');
    lines.push('');
  }
  if (flagged.length === 0) lines.push('Nothing needs attention right now.');
  lines.push(`Reply to reviews: https://business.google.com/reviews`);
  return lines.join('\n');
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
