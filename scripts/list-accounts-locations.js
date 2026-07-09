import { getAccessToken } from '../src/googleBusinessProfile.js';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  console.error('Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN env vars first.');
  process.exit(1);
}

const accessToken = await getAccessToken({
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  refreshToken: GOOGLE_REFRESH_TOKEN,
});

const accountsRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
  headers: { Authorization: `Bearer ${accessToken}` },
});
if (!accountsRes.ok) {
  throw new Error(`Failed to list accounts: ${accountsRes.status} ${await accountsRes.text()}`);
}
const { accounts = [] } = await accountsRes.json();

for (const account of accounts) {
  const accountId = account.name.split('/')[1];
  console.log(`\nAccount: ${account.accountName} (accountId: ${accountId})`);

  const locationsRes = await fetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!locationsRes.ok) {
    console.error(`  Failed to list locations: ${locationsRes.status} ${await locationsRes.text()}`);
    continue;
  }
  const { locations = [] } = await locationsRes.json();
  for (const location of locations) {
    const locationId = location.name.split('/')[1];
    console.log(`  Location: ${location.title} (locationId: ${locationId})`);
  }
}
