# PaisaTrack's server

A Cloudflare Worker that holds your data and adds two optional extras:

- **Your records** — every expense, card, loan and bill, in a D1 database in
  your own Cloudflare account. This is not optional: without it the app has
  nothing to show.
- **Server OCR** — reads a scan the on-device engine cannot manage, using a
  vision model on Cloudflare's GPUs. Opt-in, per file.
- **Due-payment reminders** — a push notification while the app is closed.
  Opt-in.

The last two have their own switches in Settings. Setting up the server does
not turn either of them on.

**Cost: ₹0. No credit card at any point.** Everything below is inside
Cloudflare's free plan.

---

## Why it is shaped like this

Workers Free allows **10ms of CPU per request**. That is not a speed limit that
can be traded for patience — it is a budget for time spent executing, and
exceeding it terminates the request. Running Tesseract here would be impossible
at any speed, however long you were willing to wait.

Cloudflare does not count time spent *waiting*, though, so everything this
Worker does is I/O-bound on purpose:

| Work | Where it happens | CPU cost here |
| --- | --- | --- |
| Reading every record | D1, returned as stored text | a wait, plus string joins |
| Base64-encoding the image | The browser, before upload | none |
| Reading the page | Cloudflare's GPUs, via the AI binding | a wait, not work |
| Signing a push | One ECDSA signature | well under 1ms |

## What the server learns

**Your records:** all of them. That is the point — it is the database.

They are stored as the JSON the app sent, in one table, in your account. The
Worker never parses a record and has no idea what a rupee is; it stores and
returns text. Every figure you see is computed in your browser from these rows.

**The token is the lock on all of it.** While the data was local, the trust
boundary was your device — it was as safe as your unlocked phone. It is
reachable at a URL now, and `API_TOKEN` is the only thing between a stranger
and your complete financial history. Generate it, do not invent it, and never
commit it.

**Server OCR:** the page you pressed the button on. It is held in memory for one
request and written nowhere. This is the only thing in PaisaTrack that uploads a
document, it is never automatic, and the button says so.

**Reminders:** a list of **dates**. Not amounts, not payees, not which card.
The push itself carries no payload at all — a bodiless push wakes the service
worker, which shows a generic line, and the app fills in the detail from the
local database after you tap. So Cloudflare can learn that your device has
*something* due on the 18th. It cannot learn that it is ₹24,500 to an HDFC card.

---

## Setup

### 1. A Cloudflare account

<https://dash.cloudflare.com/sign-up> — free, no card.

```bash
cd worker
npm install
npx wrangler login
```

### 2. The database, and a KV namespace for push subscriptions

```bash
npx wrangler d1 create paisatrack
```

```bash
npx wrangler kv namespace create PUSH
```

Each prints an id. Paste them into `wrangler.toml` over
`REPLACE_WITH_YOUR_D1_DATABASE_ID` and `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

There is no migration step: the Worker creates its own table on first use.

### 3. Secrets

A shared token, and it is now the password to your finances rather than a quota
guard. Generate it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```bash
npx wrangler secret put API_TOKEN
```

Anyone holding this can read and write your entire financial history from
anywhere in the world. Use the generated value; do not pick something memorable.

Then the push keys. Run this **once** — regenerating invalidates every existing
subscription:

```bash
node ../scripts/gen-vapid.mjs
```

It prints two values and the command for each:

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_JWK
```

### 4. Your email address

Edit `VAPID_SUBJECT` in `wrangler.toml`. The push spec requires a contact
address so a push service has somewhere to report abuse. It is not shown to
anyone using the app.

### 5. Deploy

```bash
npx wrangler deploy
```

Note the URL it prints — something like
`https://paisatrack.your-name.workers.dev`. Check it:

```bash
curl https://paisatrack.your-name.workers.dev/health
```

Expect `{"ok":true,"ai":true,"push":true,"db":true}`. If `push` is `false` the
VAPID secrets did not take; if `db` is `false` the D1 id in `wrangler.toml` is
wrong.

### 6. Allow the origin in PaisaTrack's CSP

**This step is not optional and is the easiest one to miss.** PaisaTrack ships a
Content Security Policy in a `<meta>` tag, so the browser decides what the page
may talk to before any of its code runs. A Worker URL the build did not know
about is blocked before the request is sent — your Worker's logs will show
nothing at all, because nothing arrived.

Set a repository variable so the deploy workflow bakes it in:

```bash
gh variable set VITE_WORKER_ORIGIN --body "https://paisatrack.your-name.workers.dev"
```

Then re-run the Pages deploy. (Building locally: prefix the same variable onto
`npm run build`.)

The alternative was allowing `https://*.workers.dev`, which would have let the
page talk to every Worker anyone has ever deployed. Naming one origin keeps the
policy as tight as it was before the Worker existed.

PaisaTrack's Settings screen compares what you type against what the build
permits and says so plainly if they disagree.

### 7. Switch it on

**Settings → Your server.** Paste the URL and the token, press **Save**, then
**Test connection**. The app loads as soon as it can reach the Worker.

If you used PaisaTrack before this change, it will offer to move the records
sitting in your browser to the server. It copies rather than moves — the old
local database is left untouched until you choose to delete it.

OCR and reminders stay off until you switch them on. They have separate toggles
because they have genuinely different consequences: one uploads statements and
the other uploads dates.

---

## Quotas, and what happens at the edge of them

| | Free allowance | What this uses it for |
| --- | --- | --- |
| D1 storage | 5 GB | A few MB. Years of records. |
| D1 row writes | 100,000/day | One per change. Perhaps fifty. |
| D1 row reads | 5,000,000/day | One per record per app open. |
| Requests | 100,000/day | One per change, one per app open, one per push |
| Workers AI | 10,000 neurons/day | Roughly 50–150 statement pages |
| KV reads | 100,000/day | One per subscription per daily cron |
| KV writes | 1,000/day | One per schedule change, one per notification sent |
| Cron triggers | included | One daily sweep |

The AI allowance is the only one a single person could plausibly reach, and
reaching it means OCR returns an error for the rest of the day. The on-device
engine is unaffected — it has no quota, because it is your own CPU.

Cloudflare does **not** auto-upgrade you or ask for a card when you run out. The
request fails and the allowance resets.

---

## Operating it

```bash
npx wrangler tail                    # live logs
npx wrangler kv key list --binding PUSH   # who is subscribed
npx wrangler deploy                  # redeploy after a change
```

```bash
npx wrangler d1 execute paisatrack --remote --command "SELECT tbl, COUNT(*) FROM records GROUP BY tbl"
```

## Before you delete anything

```bash
npx wrangler delete
```

**This destroys your data.** The database goes with the Worker and no device
holds a replica — that is the trade this architecture made. Take
**Settings → Download backup** first; it writes a JSON file you keep, and it is
the only copy that does not depend on Cloudflare. Restoring it needs nothing but
a new Worker and **Settings → Restore from file**.
