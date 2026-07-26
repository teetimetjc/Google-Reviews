# Google Reviews Automation

Pulls reviews from a company's Google Business Profile and emails a digest
whenever a new one shows up, so the company knows what's been posted and can
respond quickly.

## How it works

- `src/index.js` runs on a schedule (GitHub Actions cron, hourly).
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
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY` | Full JSON key for the Sheets-logging service account (optional) |
| `ANTHROPIC_API_KEY` | For AI-drafted review replies (optional, see below) |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | For a push notification when new drafts are ready (optional) |

### 8. Done

The **Google Reviews Check** workflow
(`.github/workflows/review-check.yml`) runs hourly and can also be
triggered manually from the Actions tab — use that to test it end to end
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

## Google Sheets logging

If `SHEETS_SPREADSHEET_ID` and `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY` are set,
every run of `src/index.js` also syncs to a Google Sheet using a **service
account** (no OAuth expiry to worry about):

- **Reviews Log** — one row per review, upserted in place (matched by the
  Review ID in the last column) and kept sorted newest-first. This is
  current state, not history — a reply or edit updates the existing row.
- **Change Log** — append-only audit trail: every detected new review,
  reply, or edit gets its own row and is never overwritten.

Set up a Google Cloud service account with Sheets API access, share the
target Sheet with its `client_email` as an Editor, and put the full JSON key
in the `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY` secret.

## AI-drafted review replies

`scripts/generate-draft-responses.js` (**Generate Draft Review Replies**
workflow, runs 15 minutes after each hourly review check) reads the
**Reviews Log** tab and, for every row still in `Response Status: pending`:

- If the review already has a real reply, it's marked `posted` — no draft
  needed.
- Otherwise it calls the Claude API with the reviewer's name, star rating,
  review text, and date, and writes a suggested reply into
  `Draft Response`, setting `Response Status` to `drafted`.

**Nothing is ever posted automatically.** Drafts are for a human to review
and copy/paste into Google Business Profile — this is an interim step ahead
of full auto-reply once the separate Business Profile auto-reply API access
request is approved.

Requires an `ANTHROPIC_API_KEY` repo secret. `MAX_DRAFTS_PER_RUN` (default
25) caps how many Claude calls happen in a single run — mainly relevant the
first time this runs against a sheet with years of backfilled reviews;
anything past the cap is picked up on the next run. Optional
`PUSHOVER_TOKEN`/`PUSHOVER_USER` secrets send a push notification whenever
new drafts are ready.

## Competitor GBP tracking

`scripts/competitor-gbp-tracker.js` (**Competitor GBP Tracker** workflow,
runs weekly) tracks a hand-picked list of competitors' *public* Google
Business Profile listings — rating, review count, and how that's changed
since last week — in two new tabs on the same spreadsheet. It never reads
or writes the Reviews Log/Change Log tabs, and it's a completely separate
script from the one above.

The Business Profile Reviews API can only read locations *you* manage, so
competitor data comes from the **Places API (New)** instead (the same one
`src/places-check.js` already uses) — public listing data anyone can look
up, not the private review-management API.

- **Competitors** — hand-maintained by you: `Competitor Name`, `GBP Place
  ID (or CID)`, `Website URL`, `Service Area`, `Notes`. The script creates
  this tab with two placeholder rows the first time it runs, then never
  touches it again. Fill in a real Place ID to have a row tracked; rows
  with a blank Place ID (like the placeholders) are skipped. Find a
  competitor's Place ID with the same
  [Place ID Finder](https://developers.google.com/maps/documentation/javascript/examples/places-placeid-finder)
  used for the manual scan above.
- **Competitor_GBP_Snapshots** — one row appended per competitor per run:
  snapshot date, star rating, total review count, the change in review
  count since that competitor's last snapshot, photos count, and
  categories/services listed (all as currently exposed by the Places API).
  Append-only — past snapshots are never edited, so this becomes a
  week-over-week history per competitor.

Requires a `PLACES_API_KEY` repo secret (same key as the manual-scan
fallback above, if you already enabled the Places API (New) for that — one
key covers both). Failed lookups for one competitor (bad Place ID, rate
limit, etc.) are logged and skipped without stopping the rest of the run.

Individual competitor review text/snippets (a possible phase 2) isn't
built yet — the Places API only exposes up to 5 reviews per listing by
Google's own relevance ranking, so a richer source (e.g. SerpApi) would be
worth revisiting only if that level of detail becomes useful later.

## Competitor Yelp tracking (built, paused — not free)

`scripts/competitor-yelp-tracker.js` (**Competitor Yelp Tracker** workflow)
does the same thing as the GBP tracker above, but for Yelp — same
**Competitors** tab as the source list, a separate
**Competitor_Yelp_Snapshots** tab as the destination, and it never touches
Reviews Log/Change Log or the GBP tracker's own tab.

It appends exactly one new column to the existing **Competitors** tab —
`Yelp Business ID (or Alias)` in column F — and never rewrites columns
A–E. The first time it looks up a competitor with that column blank, it
resolves a Yelp business automatically via Yelp's Business Search API
(by name + service area) and writes the resolved ID back into that cell,
so every run after that looks the business up directly instead of
re-searching. If a search finds no match, that competitor is skipped and
logged as a failure rather than guessed at.

**Competitor_Yelp_Snapshots** columns: snapshot date, competitor name,
Yelp business ID, star rating, review count, the change in review count
since that competitor's last Yelp snapshot, categories, and the Yelp
listing URL. Append-only, same as the GBP snapshots tab.

**Currently paused, on purpose:** Yelp discontinued its free Fusion API.
The only thing actually free now is a 30-day trial (5,000 calls) — after
that it's a **monthly subscription starting at $229/month** (Base plan,
no review excerpts or photos; Enhanced is $299/mo, Premium is $643/mo)
plus per-call overages on top. Not pay-as-you-go, not a one-time cost —
a recurring bill regardless of how few competitors are tracked. So this
isn't wired up to run automatically —
`.github/workflows/competitor-yelp-tracker.yml` has no `schedule:`
trigger, same pattern as the paused manual Places scan above. The code is
fully built and works (needs a `YELP_API_KEY` repo secret to run manually
from the Actions tab), so it's ready to switch on later if Yelp ever
brings back a free tier or a subscription becomes worth it.

Other review sites were considered and deliberately left out:

- **Yahoo** doesn't have its own review platform anymore (Yahoo Local was
  shut down years ago) — there's nothing to pull.
- **BBB, Angi, Facebook Page reviews**, etc. don't offer a public,
  ToS-compliant API for this kind of automated pull. Scraping them isn't
  something this project does, regardless of how infrequently it would
  run — checking those manually now and then is the honest option until
  one of them offers a real API.

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
