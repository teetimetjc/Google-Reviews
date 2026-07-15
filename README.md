# Google Reviews Automation

Pulls reviews from a company's Google Business Profile and emails a digest
whenever a new one shows up, so the company knows what's been posted and can
respond quickly.

## How it works

The working, live solution is the **Places API scan**
(`src/places-check.js`) — see "Manual scan" below for full details. It runs
hourly via GitHub Actions, checks the reviews Google currently surfaces for
the listing, and emails only when something new appears.

`src/index.js` was the originally-planned scheduled digest via the
Business Profile Reviews API (`starRating < 5` and no `reviewReply`,
tracked in `state/notified.json`), but it's effectively retired — see the
"Manual scan" section for why.

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

## Manual scan (no Business Profile API approval needed)

While waiting for (or instead of) Business Profile API access, the **Manual
Review Scan (Places API)** workflow scans the listing on demand and emails
the results — flagged reviews or an "all clear."

Setup:

1. In Google Cloud Console, enable the **Places API (New)** and create an
   **API key** (APIs & Services → Credentials → Create credentials → API
   key). Restrict the key to the Places API. Billing must be enabled on the
   project (Places has a monthly free tier that easily covers this usage).
2. Find the business's **Place ID** with the
   [Place ID Finder](https://developers.google.com/maps/documentation/javascript/examples/places-placeid-finder)
   (search for the business by name).
3. Add two more repo secrets: `PLACES_API_KEY` and `PLACE_ID` (SMTP/email
   secrets are shared with the main workflow).
4. Trigger it any time from the **Actions** tab → *Manual Review Scan
   (Places API)* → **Run workflow** (works from the GitHub mobile app too).

Limitations: the Places API only returns **up to 5 reviews**, chosen by
Google's own "relevance" ranking — **not necessarily the most recent ones**,
and there's no documented way to change that. It also doesn't expose
whether the owner has replied. So this is a "here's what Google is
currently showing" check, not guaranteed-complete coverage of new or
outstanding reviews.

`src/index.js` (the scheduled digest via the legacy Business Profile
Reviews API) is effectively retired: Google no longer grants new projects
access to `mybusiness.googleapis.com`, the endpoint it depends on, even
with Business Profile API access approved. This Places-based scan is the
working solution.

It's safe to run this multiple times a day (it runs hourly by default) —
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

## Notes / limitations (src/index.js, retired)

- Uses the legacy `mybusiness.googleapis.com/v4` Reviews endpoint. As of
  this writing, Google no longer grants new Cloud projects access to this
  API, so this script can't run — kept in the repo in case that changes.
- No email is sent when there's nothing to flag, unless `ALWAYS_SEND=true`.
- A flagged review stays in the digest every day until it gets a reply or
  its rating becomes 5★ — so missing a day's email won't cause anything to
  be missed.
