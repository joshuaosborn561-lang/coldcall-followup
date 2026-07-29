# Cold Call Follow-Up

Every weekday at **4:30pm Eastern**, pull the day's outbound calls from
[Allo](https://withallo.com) and push those people into a standing
[Smartlead](https://smartlead.ai) campaign as follow-up leads — one campaign
per rep, so the email comes from the person who actually made the call.

Call someone at 10am, and by end of day they're in the sequence with the call
date and Allo's AI summary attached as custom fields.

```
per rep: Allo /calls on their number (today, OUTBOUND)
   -> join phone number to Allo contact for the email address
   -> dedupe by email ACROSS reps, newest call wins
   -> POST /campaigns/{their campaign}/leads on Smartlead
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

### 2. One Smartlead campaign per rep

Each rep sends from their own mailbox, so each rep needs their own standing
campaign. Create one per person (e.g. "Cold Call Follow-Up — Josh"), build the
sequence, and grab the numeric ID from each campaign's URL.

Then map Allo number → campaign:

```
ALLO_ROUTES="+15550101010:12345:Josh,+15550202020:67890:Cayden"
              number      campaign  label
```

**Create these custom fields on every campaign** before the first run, or
Smartlead silently drops the values:

- `call_date`
- `call_summary`
- `call_length_minutes`
- `job_title`
- `called_by`
- `allo_call_id`
- `allo_contact_id`

Then you can write sequences like:

> Hi {{first_name}}, thanks for taking my call on {{call_date}}…

If you'd rather everyone feed one shared campaign, leave `ALLO_ROUTES` unset
and set `SMARTLEAD_CAMPAIGN_ID` instead — every number on the account then
routes there.

### 3. Deploy

```bash
vercel link
vercel env add ALLO_API_KEY production
vercel env add SMARTLEAD_API_KEY production
vercel env add ALLO_ROUTES production        # +1555...:12345:Josh,+1555...:67890:Cayden
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

## Multiple reps

**The Allo number is the identity.** A Call record has `from_number`,
`to_number`, `type`, `start_date` and `summary` — and no field saying which
team member placed it. So two reps can be told apart only if they dial from
separate Allo numbers. If you share a line, nothing in the API can attribute a
call to one of you, and this job can't either.

**A prospect you both called gets one email, not two.** Dedupe runs across all
reps, not within each. The most recent call wins, so the person who spoke to
them last owns the follow-up. Those cases are listed under `collisions` in the
run output and in the Slack summary, so "my prospect went into Cayden's
campaign" is never a surprise.

**A number nobody routed is flagged, not dropped silently.** On every run the
routes are cross-checked against the numbers actually on the Allo account. A
new rep's number that isn't in `ALLO_ROUTES` shows up as a warning (or falls
back to `SMARTLEAD_CAMPAIGN_ID` if you've set one). A number in `ALLO_ROUTES`
that isn't on the account is flagged as a probable typo.

**Bad routing config fails loudly.** A malformed `ALLO_ROUTES` entry throws
with the offending text quoted, rather than guessing — a typo here would send
one rep's prospects into the other's campaign.

`/api/health` prints the resolved routing table with each rep's campaign name,
which is the fastest way to confirm the split is right.

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
  routes.js      Allo number -> rep -> Smartlead campaign mapping
  smartlead.js   Smartlead client, batched lead upload
  pipeline.js    the job: calls -> people -> leads, deduped across reps
  time.js        Eastern day windows and the send-window guard
  notify.js      optional Slack summary
  auth.js        shared-secret check
test/
  time.test.js   timezone, DST, phone matching
  routes.test.js route parsing and cross-rep dedupe
```
