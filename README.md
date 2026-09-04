# Field Budget

Expense logging for Pacific Discovery instructors in the field, against
per-programme budgets. Replaces the shared Google Sheet instructors maintained on
the ground in Peru and Ecuador.

Budgets are denominated in the currency instructors actually spend in (PEN, USD).
NZD is the account base and is attached at reconciliation from the bank
statement — never calculated per transaction, and never asked of an instructor.

**Stack:** Netlify (static app + Functions), Neon Postgres, Google Shared Drive
for receipts, Google Sign-In and emailed magic links for auth.

```
.
├── netlify.toml
├── package.json
├── .env.example
├── db/schema.sql                 Neon schema + Peru seed
├── netlify/functions/
│   ├── api.mjs                   all routes
│   └── lib/
│       ├── http.mjs              CORS, cookies, email normalisation
│       ├── db.mjs                Neon client
│       ├── auth.mjs              sessions, Google, magic links
│       └── drive.mjs             service account, Shared Drive upload
├── public/                       the instructor app (Netlify site root)
│   ├── index.html  app.css  app.js  sw.js
│   ├── manifest.webmanifest  icon-192.png  icon-512.png
│   └── .well-known/assetlinks.json
```

The admin side is **not here** — it lives in the dashboard repo as
`field-budget/` plus `netlify/functions/budget-admin.mjs`, and reads this same
database directly. See `FIELD-BUDGET.md` there.

## Where the admin side lives

In the dashboard repo, not here. It's a normal dashboard folder gated by Netlify
Identity, and its function queries this database directly.

That means there is **no cross-origin anything** between the two: no CORS, no
shared session cookie, no requirement that they sit on the same domain. The only
thing they share is the Neon connection string — the dashboard's
`FIELD_BUDGET_DATABASE_URL` must point at the same database as `DATABASE_URL`
here.

A custom domain for this site is still worth having for the APK, but it is no
longer required.

## Setup

### 1. Neon

Create a project, then run the schema against the **pooled** connection string:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

The pooled endpoint (the host with `-pooler`) is the right one here — Lambdas
cold-start unpredictably and the pooler absorbs that.

### 2. Google Cloud

Two separate things in the same project:

**Sign-In.** APIs & Services → Credentials → Create OAuth client ID → Web
application. Add `https://budget.pacificdiscovery.org` to Authorised JavaScript
origins. Copy the client ID to `GOOGLE_CLIENT_ID`.

**Drive service account.** Create a service account, no project IAM roles
needed. Create a JSON key. **Enable the Google Drive API** in the project —
nothing works until this is on. Then in Google Drive, open the Shared Drive for
receipts and add the service account's email as a **Content manager**.

The code requests the full `drive` scope rather than `drive.file`. `drive.file`
is per-file and only covers what the app itself created, so an admin-created
receipts folder is invisible to it and every call returns 404. What the service
account can actually reach is bounded by its Shared Drive membership, not by the
scope, so keep it a member of only the receipts drive.

A service account has no Drive storage quota of its own, so it cannot own files
in a personal My Drive — a Shared Drive is required, not just convenient. Copy the
receipts folder ID from its URL into `DRIVE_ROOT_FOLDER_ID`. The app creates one
subfolder per budget on first upload.

When pasting `GOOGLE_SA_PRIVATE_KEY` into Netlify, keep the `\n` escapes from the
JSON file rather than real newlines; the code unescapes them.

### 3. Resend

Create an API key and verify the sending domain. Magic links won't send without
this, though Google sign-in works independently.

### 4. Netlify

Point a site at this repo — publish `public`, functions `netlify/functions`, no
build command. Set every variable from `.env.example` under Site configuration →
Environment variables. Add the custom domain.

### 5. Admin side

Set `FIELD_BUDGET_DATABASE_URL` on the dashboard site to the same connection
string as `DATABASE_URL` here. Don't run the dashboard's
`MIGRATION-field-budget.sql` — step 1 already created these tables.

Anyone who needs to open receipt links from the dashboard must be a member of the
Shared Drive, or the link will 403.

### 6. Android via AirDroid

```bash
bubblewrap init --manifest https://budget.pacificdiscovery.org/manifest.webmanifest
bubblewrap build
```

Paste the signing cert SHA-256 into `public/.well-known/assetlinks.json`,
redeploy, then push the APK through AirDroid Business. Without the fingerprint the
app renders with a browser URL bar over it.

Icons are generated placeholders — replace before the fleet push.

## Local development

```bash
npm install
cp .env.example .env     # fill it in
npm run dev              # netlify dev, serves app + functions together
```

`/?demo=1` seeds a local budget with no backend at all, for showing the UI.

## Auth model

Both sign-in paths converge on one signed session cookie, so the rest of the API
only ever sees a verified email address.

- **Google** — the browser gets an ID token from Google Identity Services; the
  function verifies it against Google's JWKS and checks `aud` matches our client
  ID, which is what prevents a token minted for another site being replayed.
- **Magic link** — a single-use token, stored only as a SHA-256 hash, valid 20
  minutes, redeemed in one atomic `UPDATE` so it can't be used twice.

Either way the address must already be in `assignments` or `ADMIN_EMAILS`, or no
session is issued. The magic-link endpoint always reports success regardless, so
it can't be used to enumerate staff addresses.

Sessions last 30 days. Field devices go weeks between logins.

No passwords are stored, hashed, or handled anywhere.

## Receipts

Photo → compressed client-side to ~1200px → queued in IndexedDB → uploaded on its
own request → service account writes it into the Shared Drive → Drive file ID and
link stored on the entry.

Receipts upload separately from the ledger so a stuck photo on a bad uplink never
blocks a small taxi fare from syncing.

Reading a receipt goes back through `/api/receipts/:fileId`, which checks the
caller is assigned to that entry's budget before streaming it. The Shared Drive
stays private and a file someone drags to another folder still resolves by ID.

## Environment

| Name | Notes |
|---|---|
| `DATABASE_URL` | Neon pooled connection string |
| `SESSION_SECRET` | 32+ chars, `openssl rand -base64 48` |
| `GOOGLE_CLIENT_ID` | OAuth web client, for sign-in |
| `GOOGLE_SA_EMAIL` | service account, for Drive |
| `GOOGLE_SA_PRIVATE_KEY` | with `\n` escapes |
| `DRIVE_ROOT_FOLDER_ID` | receipts folder in the Shared Drive |
| `RESEND_API_KEY` | magic-link delivery |
| `MAIL_FROM` | verified sender |
| `APP_ORIGIN` | builds magic-link URLs |
| `COOKIE_DOMAIN` | optional; only for another cross-origin front end |
| `ALLOWED_ORIGINS` | optional; same |
| `ADMIN_EMAILS` | lets an admin sign in without a budget assignment |

## Deploying changes

`git push` deploys. Bump `SHELL` in `public/sw.js` whenever `app.js` or `app.css`
changes, or the service worker keeps serving the old files and your change will
appear not to have landed.

## Design decisions

**Integer minor units everywhere.** PEN 40.50 is `4050` with an explicit currency
code on the row. Postgres returns `bigint` as a string, so it's coerced once at
the API boundary rather than scattered through the app.

**`budget_amount` is frozen at entry.** Written once at the rate captured then,
never recalculated. Change a rate in April and February's balances stay put.

**Entries are append-only.** A mistake produces a `correction` row referencing the
original, not an edit. Sync is `ON CONFLICT DO NOTHING` on a device-generated
UUID, so a phone that resurfaces after eleven days offline can post its whole
outbox safely. Conflict resolution disappears, and finance gets an audit trail.

**Cash float is per instructor per currency**, because instructors hold PEN and
USD simultaneously. An exchange writes two rows sharing a `group_id`.

**NZD is determined at funding, not at spend.** Card charges land on the NZD
account at the bank's rate; cash was bought at a known cost at the ATM or exchange
counter. Programme cost in NZD is the sum of funding events, which is exact — not
the sum of expenses converted, which estimates a number you will later have
precisely.

## Known gaps

- **No correction UI.** The `correction` entry type exists but nothing writes one,
  so a mistyped amount has no in-app fix.
- **No unbudgeted-spend alert.** On the Peru leg roughly PEN 10,840 of replacement
  gear went through a category with no allocation. Nothing here flags that sooner.
- **One `default_rate` per budget** can't be right for more than one foreign
  currency. PEN per USD is 3.34; PEN per EUR is nearer 4.05. The save button shows
  the converted figure so a wrong rate is visible before saving, but a rates map
  per budget is the real fix.
- **Description is optional.** Blank descriptions fall back to the category name —
  the same ambiguity that made the sheet hard to reconcile.
- **Magic links need Resend.** Until that's configured, Google is the only way in.
- **Receipts route through a Function**, so they count against function invocation
  and bandwidth rather than going straight to storage. Fine at a few hundred per
  programme; worth revisiting if volume grows.
