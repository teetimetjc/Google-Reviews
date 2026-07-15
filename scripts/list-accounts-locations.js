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
const accountsBody = await accountsRes.json();
const { accounts = [] } = accountsBody;
console.log(`Found ${accounts.length} account(s). Raw response:`);
console.log(JSON.stringify(accountsBody, null, 2));

for (const account of accounts) {
  const accountId = account.name.split('/')[1];
  console.log(`\nAccount: ${account.accountName} (accountId: ${accountId}, type: ${account.type}, role: ${account.role})`);

  const locationsRes = await fetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title&pageSize=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!locationsRes.ok) {
    console.error(`  Failed to list locations: ${locationsRes.status} ${await locationsRes.text()}`);
    continue;
  }
  const locationsBody = await locationsRes.json();
  console.log('  Raw locations response:');
  console.log(JSON.stringify(locationsBody, null, 2));

  const { locations = [] } = locationsBody;
  for (const location of locations) {
    const locationId = location.name.split('/')[1];
    console.log(`  Location: ${location.title} (locationId: ${locationId})`);
  }
}
