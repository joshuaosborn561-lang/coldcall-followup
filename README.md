# Cold Call Follow-Up

Weekday daytime, about every **10 minutes**, pull recent outbound calls from
[Allo](https://withallo.com), keep the ones where there was **no real
conversation** with the prospect, and push those people into a standing
[Smartlead](https://smartlead.ai) campaign as follow-up leads.

Cayden does not leave voicemails. A no-connect, an unanswered ring, a hangup
before a talk, a gatekeeper screen, or a voicemail / answering machine hit
(message left or not) all get a follow-up. A live conversation with the
prospect does not.

```
Allo v2 conversations/items/search  (last ~20 minutes, OUTBOUND)
   -> keep no-connect + voicemail hits; drop real conversations
   -> email: Allo CRM -> call audio extraction -> enrichment
   -> dedupe by email, newest eligible call wins
   -> POST /campaigns/3739316/leads on Smartlead
```

Runs on Railway (`server.js`). The always-on process owns the 10-minute
ticker — it does not depend on a Grok Bot routine. Smartlead dedupe makes
overlapping lookbacks safe.

## Setup

### 1. Allo API key

Generate at [web.withallo.com/settings/api](https://web.withallo.com/settings/api)
with these **v2** scopes:

| Scope | Used for |
| --- | --- |
| `CONVERSATIONS_READ` | the call log |
| `CRM_READ` | person records (names, job titles, companies, websites) |
| `PHONE_NUMBERS_READ` | listing the account's numbers |
| `USERS_READ` | team members |

No write scopes are needed — this job never modifies anything in Allo.

> `CONTACTS_READ` was a **v1** scope and no longer exists. v1's `/contacts`
> endpoint is unreachable with a current key regardless of what is granted.
> `GET /v2/api/me` returns a key's real scopes plus a catalogue of every
> endpoint and the scope it needs — check that first when anything 403s.

### 2. Smartlead campaign

One standing campaign that everyone's calls feed:

```
SMARTLEAD_CAMPAIGN_ID=3739316
```

Every Allo number on the account routes there. Rep attribution is automatic —
each call carries its own `user` object, so `{{called_by}}` renders "Joshua
Osborn" or "Cayden Martini" with no configuration, and stays correct on a
shared number.

**Create these custom fields on the campaign** before the first run, or
Smartlead accepts the lead and silently drops the values:

`call_date` · `call_day` · `call_time` · `call_summary` ·
`call_length_minutes` · `job_title` · `called_by` · `allo_call_id` ·
`allo_person_id`

Then you can write sequences like:

> Hi {{first_name}}, thanks for taking my call {{call_day}} — you mentioned…

or, in a shared campaign, attribute the call:

> Hi {{first_name}}, thanks for speaking with {{called_by}} on {{call_date}}…

## Merge field mapping

What each Smartlead variable resolves to:

| Smartlead field | Source | Example |
| --- | --- | --- |
| `{{first_name}}` | Allo person `name`, normalized — **first name only** | `Amanda` |
| `{{last_name}}` | Allo person `last_name`, or split out of `name` | `Alvarez` |
| `{{company_name}}` | Allo `company.name`, else the enrichment provider's | `Omega Roofer` |
| `{{website}}` | Allo person `website` | `http://omegaroofer.com` |
| `{{phone_number}}` | the number dialled | `+18134539292` |
| `{{call_date}}` | call `date`, local | `July 30` |
| `{{call_day}}` | call `date`, local | `Thursday` |
| `{{call_time}}` | call `date`, local | `2:23pm` |
| `{{call_summary}}` | Allo's AI summary, ≤500 chars | `Cold outbound voicemail about…` |
| `{{call_length_minutes}}` | call `duration` (seconds) ÷ 60 | `0.7` |
| `{{job_title}}` | Allo person `job_title` | `Office Manager Co-owner` |
| `{{called_by}}` | the call's own `user.name` | `Joshua Osborn` |
| `{{allo_call_id}}` / `{{allo_person_id}}` | traceability back to Allo | `cll-16F950…` |

Two things this handles that a naive mapping would not:

**`{{first_name}}` is the first name, not the full name.** Allo has separate
`name` and `last_name` fields, but contacts imported from a list routinely
arrive with the whole name in `name` and `last_name` empty. Passing that
through renders *"Hi John Doe,"*. Names are split, and cleaned with the
established SalesGlider rules — titles, credentials and generational suffixes
stripped, `Anthony (Tony)` → `Tony`, `ANTHONY` → `Anthony`, `Jimmy` → `Jim`.
Formal given names are never converted to nicknames (James stays James).

**Dates are readable and local.** `date` arrives as
`2026-07-30T18:23:11Z`; dropping that into a sequence renders the raw ISO
string, and a 9pm call would be attributed to the wrong day. The three date
fields are formatted in the rep's timezone.

A contact with no first name in Allo is reported under
`leadsWithoutFirstName` in the run output — use a Smartlead fallback like
`{{first_name|there}}` so those don't render as *"Hi ,"*.

### 3. Email enrichment

Allo's CRM holds names, job titles, companies and websites but **almost no
email addresses** — so most people we follow up with need enriching
from (first name, last name, company domain).

Order when Allo has no email: **getleads → AI Ark → LeadMagic**.

| Provider | Env var | Status |
| --- | --- | --- |
| getleads | `GETLEADS_API_KEY` | **verified** — `app.getleads.io/api/v1/contacts/search` |
| AI Ark | `AI_ARK_API_KEY` | **active** — people search + `/v2/people/export/single` (`X-TOKEN`) |
| LeadMagic | `LEADMAGIC_API_KEY` | **verified** — `/email-finder` |

The waterfall stops at the first hit, so a lead costs one lookup, not three.
Only addresses the provider itself calls deliverable are accepted.

`PROBE_ENRICH=1` exercises each provider once and logs raw responses.

Allo CRM emails are normalized before upload: comma-joined values like
`a@x.com,b@y.com` are split, invalid addresses dropped, and the address that
best matches the contact's name is preferred.

### 4. Deploy

Deployed on Railway, project `coldcall-follow-up`, service `followup`. It
builds from `main` and runs `npm start` (`server.js`), which schedules
in-process every 10 minutes on weekdays. Set the variables in Railway →
Variables:

```
ALLO_API_KEY  SMARTLEAD_API_KEY  SMARTLEAD_CAMPAIGN_ID
GETLEADS_API_KEY  AI_ARK_API_KEY  LEADMAGIC_API_KEY
```

Optionally set `CRON_SECRET` to close the endpoints — see
[Endpoint access](#endpoint-access). See `.env.example` for the rest.

The `api/*.js` handlers also work as Vercel functions with `vercel.json`, but
Railway is the deployed path and owns the 10-minute weekday ticker.

### 5. Verify before it runs unattended

```bash
# Env complete? Both APIs reachable? Scopes right? Campaign resolves?
curl "https://followup-production-a954.up.railway.app/api/health"

# Who WOULD be emailed for the last 20 minutes? Sends nothing.
curl "https://followup-production-a954.up.railway.app/api/run?dry=1&lookback=20"

# Full calendar day (backfill / backlog).
curl "https://followup-production-a954.up.railway.app/api/run?dry=1&date=2026-07-28"
```

Only once a dry run looks right should you let the cron fire for real.

(Append `&key=$CRON_SECRET` to each if you've set one.)

You can also run it from a terminal without deploying:

```bash
ALLO_API_KEY=... SMARTLEAD_API_KEY=... SMARTLEAD_CAMPAIGN_ID=3739316 \
  node scripts/local-run.js --dry
```

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /api/cron` | Scheduled incremental run. Weekday-daytime guard; last `LOOKBACK_MINUTES` only. |
| `GET /api/run` | Manual run, no clock guard. `?dry=1` to preview, `?date=YYYY-MM-DD` (and optional `?through=`) for a full-day backfill, `?lookback=20` for the incremental window, `?notify=1` to also post to Slack. |
| `GET /api/health` | Read-only pre-flight: env, Allo reachability + scopes, Smartlead campaign. |

### Endpoint access

Auth is opt-in, via `CRON_SECRET`:

| `CRON_SECRET` | Behaviour |
| --- | --- |
| unset (default) | Endpoints are **open** to anyone with the deployment URL. |
| set | Every endpoint requires `?key=…` or `Authorization: Bearer …`. Vercel Cron sends the header automatically. |

Open is worth understanding before choosing it. `GET /api/run?dry=1` returns
the day's full prospect list — names, emails, companies, job titles and call
summaries — to anyone who requests it, and `GET /api/run` without `dry`
pushes leads into the campaign for real. A Vercel production URL is not
secret; it appears in deployment logs and browser history.

Two ways to close it back up, whenever you want:

- `vercel env add CRON_SECRET production` — a value from `openssl rand -hex 32`.
  Cron keeps working with no further changes.
- **Vercel Deployment Protection** (Project → Settings → Deployment
  Protection). Gates every route behind your Vercel login, still lets cron
  through, and there's no secret to manage. This is the easier option if the
  query string was the annoying part.

## Schedule

Railway owns the recurring work. `npm start` (`server.js`) is always on so
`/api/health` and `/api/run` keep answering, and an in-process ticker fires
the job.

| When | What it sends |
| --- | --- |
| Mon–Fri, every 10 minutes, 08:00–20:00 `RUN_TIMEZONE` | outbound calls from the last **20 minutes** that were no-connect or voicemail |
| Sat/Sun | nothing |
| nights (before 08:00 / from 20:00) | nothing |

`America/New_York` (default) or `America/Chicago` are both fine. The lookback
is a few minutes longer than the interval so one missed tick still overlaps.
Smartlead dedupes against the campaign, so overlap does not double-enroll.

Full-day / backlog remains a **manual** path:

```
GET /api/run?dry=1&date=2026-09-22
GET /api/run?dry=1&date=2026-09-19&through=2026-09-21
```

Tunable env vars: `SCHEDULE_INTERVAL_MINUTES` (10), `LOOKBACK_MINUTES` (20),
`DAYTIME_START_HOUR` (8), `DAYTIME_END_HOUR` (20), `RUN_TIMEZONE`,
`SKIP_WEEKENDS`.

`test/schedule.test.js` and `test/time.test.js` cover the 10-minute slots, the
20-minute lookback, weekday-daytime, weekend skip, and DST-safe day windows.

### Railway dashboard

No `cronSchedule` is set on service `followup` on purpose. Putting
`*/10 * * * *` on this same service would turn it into a start-then-exit
cron job and take the public URL down between runs.

After this code is deployed, the in-process ticker is enough. Optional
native-cron alternative: add a **second** Railway service (or change start
only if you no longer need the HTTP API) with start command `npm run cron`
and `cronSchedule` `*/10 * * * *`. `scripts/cron-run.js` is a one-shot that
uses the same weekday + lookback guards.

Do **not** drive this from a Grok Bot routine.

### Vercel

`vercel.json` still lists two daily UTC crons. `/api/cron` now runs the
incremental lookback and skips nights/weekends, so the Vercel path is not a
full-day send and is not the production schedule. Railway is. Historical
DST table for those leftover crons:

| UTC | EDT (Mar–Nov) | EST (Nov–Mar) |
| --- | --- | --- |
| 20:30 | 16:30 weekday daytime | 15:30 — skipped as outside daytime |
| 21:30 | 17:30 weekday daytime | 16:30 weekday daytime |

Those leftover crons now run the 20-minute lookback, not a full day.

## Multiple reps

**The Allo number is the identity.** A Call record has `from_number`,
`to_number`, `type`, `start_date` and `summary` — and no field saying which
team member placed it. So two reps can be told apart only if they dial from
separate Allo numbers. If you share a line, nothing in the API can attribute a
call to one of you, and this job can't either.

**A prospect you both called gets one email, not two.** Dedupe runs across all
reps, not within each. The most recent call wins, so the person who spoke to
them last owns the follow-up. Those cases are listed under `collisions` in the
run output and in the Slack summary. This matters most in a shared campaign,
where the same prospect arriving twice would otherwise mean two touches from
the same company on the same day.

**One shared campaign means one sender.** With everyone pointed at the same
campaign ID, every follow-up goes out from whichever mailboxes are attached to
that campaign, regardless of who made the call. Use `{{called_by}}` in the
sequence to name the rep, or split reps onto separate campaign IDs if they
should send from their own inboxes.

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

**No-connect and voicemail both count.** Someone who didn't pick up, or whose
line hit a mailbox, is exactly who you want to follow up with by email. A
real conversation with the prospect is excluded.

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
  cron.js        scheduled incremental entry, weekday-daytime + lookback
  run.js         manual entry, dry-run, date backfill, optional lookback
  health.js      read-only pre-flight
lib/
  allo.js        Allo REST client, call paging, phone -> contact index
  names.js       first/last name split and normalization for merge fields
  routes.js      Allo number -> rep -> Smartlead campaign mapping
  smartlead.js   Smartlead client, batched lead upload
  pipeline.js    the job: calls -> people -> leads, deduped across reps
  time.js        day windows, 20-minute lookback, weekday-daytime guard
  voicemail.js   no-connect / voicemail vs live-conversation classifier
  notify.js      optional Slack summary
  auth.js        shared-secret check
test/
  time.test.js   timezone, DST, lookback, weekday-daytime
  schedule.test.js  incremental lookback vs full-day, weekend skip
  voicemail.test.js no-connect + voicemail vs live conversation
  names.test.js  name splitting, normalization, date merge fields
```
