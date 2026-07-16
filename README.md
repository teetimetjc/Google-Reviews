# Google Reviews Automation

Pulls reviews from a company's Google Business Profile and emails a digest
whenever a new one shows up, so the company knows what's been posted and can
respond quickly.

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

There's also a secondary **Places API scan** (`src/places-check.js`, see
"Manual scan" below) that was built as a stopgap while the Business Profile
Reviews API was inaccessible. It's currently paused now that the real
digest above is working, but it's still there as a fallback.

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

## Manual scan (fallback — currently paused)

`src/places-check.js` / the **Manual Review Scan (Places API)** workflow
was built as a stopgap for when `mybusiness.googleapis.com` (the legacy
Reviews API `src/index.js` depends on) couldn't be enabled for this
project. That access issue turned out to be transient — enabling the API
via `gcloud services enable mybusiness.googleapis.com` eventually
succeeded after a retry — so the main digest is the working solution now,
and this fallback is paused (no `schedule:` trigger in
`.github/workflows/manual-review-scan.yml`).

Its limitations, if it's ever needed again: the Places API only returns
**up to 5 reviews**, chosen by Google's own "relevance" ranking — **not
necessarily the most recent ones**, with no documented way to change that.
It also doesn't expose whether the owner has replied.

Setup, if re-enabling it:

1. In Google Cloud Console, enable the **Places API (New)** and create an
   **API key** (APIs & Services → Credentials → Create credentials → API
   key). Restrict the key to the Places API. Billing must be enabled on the
   project (Places has a monthly free tier that easily covers this usage).
2. Find the business's **Place ID** with the
   [Place ID Finder](https://developers.google.com/maps/documentation/javascript/examples/places-placeid-finder)
   (search for the business by name).
3. Add two more repo secrets: `PLACES_API_KEY` and `PLACE_ID` (SMTP/email
   secrets are shared with the main workflow).
4. Add a `schedule:` trigger back to `.github/workflows/manual-review-scan.yml`,
   or trigger it manually from the **Actions** tab → *Manual Review Scan
   (Places API)* → **Run workflow**.

`state/places-notified.json` tracks which reviews have already been
emailed about, so re-running only sends an email when a *new* review shows
up (or nothing at all, if `ALWAYS_SEND` isn't set to `true`). By default it
notifies on a new review of **any** rating; set the `ONLY_FLAG_BELOW_5` env
var to `'true'` in the workflow to go back to only flagging reviews under
5 stars.

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
  Business Profile resources have moved to newer APIs. If this API ever
  shows `403 SERVICE_DISABLED` for a project, try enabling it via
  `gcloud services enable mybusiness.googleapis.com --project=<id>` in
  Cloud Shell — the Console's "Enable" page has been unreliable for this
  particular API, and the gcloud command may report a transient-looking
  "Regional Access Boundary" error before eventually succeeding; retry it.
- No email is sent when there's nothing to flag, unless `ALWAYS_SEND=true`.
- A flagged review stays in the digest every day until it gets a reply or
  its rating becomes 5★ — so missing a day's email won't cause anything to
  be missed.
