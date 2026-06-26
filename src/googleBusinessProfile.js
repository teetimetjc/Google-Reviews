const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVIEWS_BASE = 'https://mybusiness.googleapis.com/v4';

const STAR_RATING_MAP = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export function starRatingToNumber(starRating) {
  return STAR_RATING_MAP[starRating] ?? null;
}

export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh access token: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

export async function fetchAllReviews({ accessToken, accountId, locationId }) {
  const reviews = [];
  let pageToken;
  do {
    const url = new URL(
      `${REVIEWS_BASE}/accounts/${accountId}/locations/${locationId}/reviews`,
    );
    url.searchParams.set('pageSize', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch reviews for ${accountId}/${locationId}: ${res.status} ${await res.text()}`,
      );
    }
    const data = await res.json();
    reviews.push(...(data.reviews ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return reviews;
}
