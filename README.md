# Cold Call Follow-Up

Every weekday at **4:30pm Eastern**, pull the day's outbound calls from
[Allo](https://withallo.com) and push those people into a standing
[Smartlead](https://smartlead.ai) campaign as follow-up leads.

Call someone at 10am, and by end of day they're in the sequence with the call
date and Allo's AI summary attached as custom fields.

```
Allo /calls (today, OUTBOUND)
   -> join phone number to Allo contact for the email address
   -> dedupe by email, newest call wins
   -> POST /campaigns/{id}/leads on Smartlead
```

## Setup

### 1. Allo API key

Generate at [web.withallo.com/settings/api](https://web.withallo.com/settings/api)
with these scopes:

| Scope | Used for |
| --- | --- |
| `CONVERSATIONS_READ` | reading the call log and listing your numbers |
| `CONTACTS_READ` | reading contacts, which is where the email addresses live |

No write scopes are needed — this job never modifies anything in Allo.

### 2. Smartlead campaign

Create one campaign that stays running (e.g. "Cold Call Follow-Up"), build the
sequence, and grab the numeric ID from its URL.

**Create these custom fields on the campaign** before the first run, or
Smartlead silently drops the values:

- `call_date`
- `call_summary`
- `call_length_minutes`
- `job_title`
- `allo_call_id`
- `allo_contact_id`

Then you can write sequences like:

> Hi {{first_name}}, thanks for taking my call on {{call_date}}…

### 3. Deploy

```bash
vercel link
vercel env add ALLO_API_KEY production
vercel env add SMARTLEAD_API_KEY production
vercel env add SMARTLEAD_CAMPAIGN_ID production
vercel env add CRON_SECRET production        # openssl rand -hex 32
vercel --prod
```

See `.env.example` for the optional knobs.

### 4. Verify before it runs unattended

```bash
# Env complete? Both APIs reachable? Scopes right?
curl "https://YOUR-APP.vercel.app/api/health?key=$CRON_SECRET"

# Who WOULD be emailed today? Sends nothing.
curl "https://YOUR-APP.vercel.app/api/run?key=$CRON_SECRET&dry=1"

# Same, for a past day.
curl "https://YOUR-APP.vercel.app/api/run?key=$CRON_SECRET&dry=1&date=2026-07-28"
```

Only once a dry run looks right should you let the cron fire for real.

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /api/cron` | Scheduled run. Enforces the 4:30pm ET window and the weekend skip. |
| `GET /api/run` | Manual run, no clock guard. `?dry=1` to preview, `?date=YYYY-MM-DD` to backfill, `?notify=1` to also post to Slack. |
| `GET /api/health` | Read-only pre-flight: env, Allo reachability + scopes, Smartlead campaign. |

All three require `?key=$CRON_SECRET` or `Authorization: Bearer $CRON_SECRET`.
Vercel Cron sends the bearer header automatically once `CRON_SECRET` is set.

## Why there are two cron entries

Vercel cron schedules are UTC only, and 4:30pm Eastern is a different UTC time
in summer than in winter. `vercel.json` fires `/api/cron` twice a day:

| UTC | EDT (Mar–Nov) | EST (Nov–Mar) |
| --- | --- | --- |
| 20:30 | **16:30** ✅ | 15:30 — exits |
| 21:30 | 17:30 — exits | **16:30** ✅ |

The handler checks the actual Eastern hour and the wrong one returns
`{"skipped": "outside send window"}`. Exactly one real run per day, year round,
with no manual clock change in November. `test/time.test.js` asserts this holds
for all 365 days of the year.

If you change `SEND_HOUR`, update both cron entries in `vercel.json` to match
(`SEND_HOUR` in UTC, and that same hour +1).

## Behaviour worth knowing

**Outbound only.** "People I called" means calls you placed. Set
`INCLUDE_INBOUND_CALLS=true` to also follow up on people who called in.

**Unanswered calls still count.** Someone who didn't pick up is exactly who you
want to follow up with by email. Set `MIN_CALL_MINUTES` if you disagree.

**Emails come from Allo contacts.** A call record only carries a phone number,
so the job joins that number to a contact to find the email. Numbers with no
contact — or a contact with no email — are reported in `skipped` and in the
Slack summary, so you can fill them in rather than lose them.

**Suppression lists are respected.** `ignore_global_block_list`,
`ignore_unsubscribe_list` and `ignore_community_bounce_list` all default to
`false`, so Smartlead filters out anyone who opted out. The
`SMARTLEAD_IGNORE_*` env vars can flip these; don't, without a specific reason.

**Re-running is safe.** Smartlead dedupes against the campaign, so a second run
for the same day reports the leads as duplicates instead of re-adding them.
That makes `?date=` backfills and retries harmless.

**Rate limits and transient failures** are retried with backoff on both APIs
(Allo honours its `reset_in`; Smartlead honours `Retry-After`).

## Local development

```bash
npm test          # timezone/DST and phone-matching tests, no network needed
vercel dev        # then hit http://localhost:3000/api/health?key=...
```

## Layout

```
api/
  cron.js        scheduled entry, DST + weekend guards
  run.js         manual entry, dry-run and date backfill
  health.js      read-only pre-flight
lib/
  allo.js        Allo REST client, call paging, phone -> contact index
  smartlead.js   Smartlead client, batched lead upload
  pipeline.js    the job: calls -> people -> leads
  time.js        Eastern day windows and the send-window guard
  notify.js      optional Slack summary
  auth.js        shared-secret check
test/
  time.test.js
```
