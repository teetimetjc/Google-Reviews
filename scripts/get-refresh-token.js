import http from 'node:http';
import { URL } from 'node:url';

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/business.manage';

const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars first.');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('scope', SCOPE);

console.log('Open this URL in a browser, sign in as the Business Profile owner/manager, and approve access:\n');
console.log(authUrl.toString());
console.log(`\nWaiting for the redirect to ${REDIRECT_URI} ...`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('You can close this tab and return to the terminal.');
  server.close();

  if (error || !code) {
    console.error('OAuth consent failed:', error || 'no authorization code returned');
    process.exit(1);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });
  const tokenData = await tokenRes.json();

  if (!tokenData.refresh_token) {
    console.error('No refresh_token returned. Response:', tokenData);
    process.exit(1);
  }

  console.log('\nRefresh token (store this as the GOOGLE_REFRESH_TOKEN repo secret):\n');
  console.log(tokenData.refresh_token);
});

server.listen(PORT);
