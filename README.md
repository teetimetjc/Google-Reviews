# Google Reviews Automation

Pulls reviews from a company's Google Business Profile, flags every review that
isn't 5 stars and hasn't been replied to yet, and emails a digest so the
company knows what needs a response.

## How it works

- `src/index.js` runs on a schedule (GitHub Actions cron, daily by default).
- It authenticates to the Google Business Profile API using a stored OAuth
  refresh token.
- For each location configured in `config/locations.json`, it fetches every
  review and filters to the ones with `starRating < 5` and no `reviewReply`.
- If any are found, it emails a digest (rating, reviewer, comment, days
  outstanding, link to reply) to `EMAIL_TO`.
- It tracks the "first flagged" date per review in `state/notified.json`
  (committed back to the repo by the workflow) so a review stays in every
  digest until it's answered, and the email can show how long it's been
  waiting.

## One-time setup

### 1. Get access to the Google Business Profile API

Google requires explicit approval to call the Business Profile APIs. Request
access at https://developers.google.com/my-business/content/prereqs if you
haven't already — approval can take a few days.

### 2. Create OAuth credentials

In Google Cloud Console, for the project tied to your Business Profile access:

- Enable the **My Business Account Management API** and **My Business
  Business Information API** (used by `scripts/list-accounts-locations.js`),
  and the legacy **Google My Business API** (`mybusiness.googleapis.com`,
  used for reading/replying to reviews — still required as of 2025 since
  reviews haven't moved to the newer API family).
- Create an OAuth 2.0 Client ID of type **Desktop app** (this allows the
  loopback redirect used during one-time setup).
- Note the Client ID and Client Secret.

### 3. Get a refresh token

Sign in with an account that has owner/manager access to the company's
Google Business Profile:

```
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npm run get-refresh-token
```

Open the printed URL, approve access, and the script will print a refresh
token. Save it — you'll need it for the `GOOGLE_REFRESH_TOKEN` secret.

### 4. Find the account/location IDs

```
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy GOOGLE_REFRESH_TOKEN=zzz npm run list-locations
```

This prints every account and location the authenticated user can manage,
along with the IDs you need for the next step.

### 5. Configure `config/locations.json`

```json
[
  {
    "name": "Acme Auto Repair",
    "accountId": "1234567890",
    "locationId": "9876543210",
    "manageUrl": "https://business.google.com/reviews"
  }
]
```

Add one entry per location/company to monitor. `manageUrl` is optional —
point it at wherever the company actually replies to reviews.

### 6. Set up email sending

Any SMTP provider works (Gmail App Password, SendGrid, Postmark, etc).

### 7. Add GitHub repository secrets

Settings → Secrets and variables → Actions:

| Secret | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | From step 3 |
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | e.g. `587` |
| `SMTP_SECURE` | `true` if using port 465 |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password / app password |
| `EMAIL_FROM` | From address |
| `EMAIL_TO` | Who gets the digest (comma-separated for multiple recipients) |

### 8. Done

The **Google Reviews Check** workflow
(`.github/workflows/review-check.yml`) runs daily at 13:00 UTC and can also
be triggered manually from the Actions tab — use that to test it end to end
before waiting for the schedule.

## Running locally

```
npm install
cp .env.example .env   # fill in the values, then export them
export $(grep -v '^#' .env | xargs)
npm start
```

## Notes / limitations

- Uses the legacy `mybusiness.googleapis.com/v4` Reviews endpoint, which is
  still required for reading/replying to reviews even though most other
  Business Profile resources have moved to newer APIs.
- No email is sent when there's nothing to flag, unless `ALWAYS_SEND=true`.
- A flagged review stays in the digest every day until it gets a reply or
  its rating becomes 5★ — so missing a day's email won't cause anything to
  be missed.
