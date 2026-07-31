/**
 * Long-running server, for hosts without a serverless cron (Railway, Render,
 * Fly, a VPS). Vercel does not need this -- there `api/*.js` are the functions
 * and `vercel.json` drives the schedule. Both deployment styles share the same
 * handlers and pipeline.
 *
 *   npm start
 *
 * Routes /api/cron, /api/run and /api/health to the same handlers Vercel uses,
 * and runs the 4:30pm schedule in-process instead of via platform cron.
 */

import { createServer } from 'node:http';

import cronHandler from './api/cron.js';
import healthHandler from './api/health.js';
import runHandler from './api/run.js';
import { notifySlack } from './lib/notify.js';
import { runFollowUp } from './lib/pipeline.js';
import { SEND_HOUR, TZ, isWeekend, weekendBacklog, zonedParts } from './lib/time.js';

const PORT = Number(process.env.PORT || 3000);
const SEND_MINUTE = Number(process.env.SEND_MINUTE ?? 30);
// Monday-morning slot for the Friday-through-Sunday backlog.
const BACKLOG_HOUR = Number(process.env.BACKLOG_HOUR ?? 8);
const BACKLOG_MINUTE = Number(process.env.BACKLOG_MINUTE ?? 0);
const TICK_MS = 30_000;

const ROUTES = {
  '/api/cron': cronHandler,
  '/api/run': runHandler,
  '/api/health': healthHandler,
};

/** Vercel's res API (res.status(n).json(obj)) on top of a node ServerResponse. */
function shim(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body, null, 2));
    return res;
  };
  return res;
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;

  // Railway's healthcheck hits the root; keep it free of API calls so a
  // throttled Allo or Smartlead never marks the deploy unhealthy.
  if (path === '/' || path === '/healthz') {
    const et = zonedParts(new Date(), TZ);
    return shim(res).status(200).json({
      ok: true,
      service: 'coldcall-follow-up',
      localTime: `${et.date} ${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')} ${TZ}`,
      schedule: {
        daily: `${pad(SEND_HOUR)}:${pad(SEND_MINUTE)} ${TZ}, Mon-Thu`,
        weekendBacklog: `Mon ${pad(BACKLOG_HOUR)}:${pad(BACKLOG_MINUTE)} ${TZ} covers Fri-Sun`,
        friday: 'held until Monday morning',
      },
      lastScheduledRun,
    });
  }

  const handler = ROUTES[path];
  if (!handler) return shim(res).status(404).json({ ok: false, error: `No route ${path}` });

  try {
    await handler(req, shim(res));
  } catch (err) {
    if (!res.writableEnded) shim(res).status(500).json({ ok: false, error: err.message });
  }
});

// --- in-process schedule ----------------------------------------------------

let lastFiredDate = null; // ET calendar date of the last scheduled run
let lastScheduledRun = null; // summary of it, surfaced on /

const pad = (n) => String(n).padStart(2, '0');

function skipWeekends() {
  const raw = process.env.SKIP_WEEKENDS;
  if (raw === undefined) return true;
  return /^(1|true|yes)$/i.test(raw.trim());
}

/**
 * Two daily triggers:
 *
 *   Mon-Thu 16:30  send that day's voicemails.
 *   Fri     16:30  skipped -- a Friday-afternoon follow-up lands in a weekend
 *                  inbox and goes stale before Monday.
 *   Mon     08:00  send the Friday-through-Sunday backlog.
 *
 * Monday therefore fires twice: 08:00 for last week's tail, 16:30 for today.
 */
async function tick() {
  const now = new Date();
  const et = zonedParts(now, TZ);

  const isMonday = et.weekday === 'Mon';
  const isFriday = et.weekday === 'Fri';

  const atBacklogTime = isMonday && et.hour === BACKLOG_HOUR && et.minute >= BACKLOG_MINUTE;
  const atDailyTime = et.hour === SEND_HOUR && et.minute >= SEND_MINUTE;

  if (!atBacklogTime && !atDailyTime) return;

  // Monday runs twice, so the guard is keyed per slot, not per day.
  const slot = atBacklogTime ? `${et.date}#backlog` : `${et.date}#daily`;
  if (lastFiredDate === slot) return;
  lastFiredDate = slot; // claim before awaiting, so a slow run cannot double-fire

  if (atDailyTime && !atBacklogTime) {
    if (skipWeekends() && isWeekend(now, TZ)) {
      lastScheduledRun = { date: et.date, skipped: 'weekend' };
      console.log(`[${et.date}] weekend — skipped`);
      return;
    }
    if (isFriday) {
      lastScheduledRun = { date: et.date, skipped: 'friday — sends Monday 8am' };
      console.log(`[${et.date}] Friday — holding until Monday 08:00 ${TZ}`);
      return;
    }
  }

  const range = atBacklogTime ? weekendBacklog(now, TZ) : null;
  const label = range ? `${range.from}..${range.through}` : et.date;

  console.log(
    `[${label}] ${pad(et.hour)}:${pad(et.minute)} ${TZ} — running ${range ? 'weekend backlog' : 'daily'} follow-up`
  );
  try {
    const stats = await runFollowUp(
      range ? { dryRun: false, date: range.from, throughDate: range.through } : { dryRun: false }
    );
    stats.slack = await notifySlack(stats);
    lastScheduledRun = {
      date: label,
      peopleCalled: stats.totals.peopleCalled,
      leadsPrepared: stats.totals.leadsPrepared,
      uploaded: stats.totals.uploaded,
      warnings: stats.warnings,
    };
    console.log(JSON.stringify(lastScheduledRun));
  } catch (err) {
    lastScheduledRun = { date: label, error: err.message };
    console.error(`[${label}] follow-up failed:`, err.message);
    await notifySlack({
      date: et.date,
      dryRun: false,
      totals: { peopleCalled: 0, leadsPrepared: 0 },
      routes: [],
      skipped: [],
      warnings: [`Run failed: ${err.message}`],
    });
  }
}

server.listen(PORT, () => {
  const et = zonedParts(new Date(), TZ);
  console.log(`coldcall-follow-up listening on :${PORT}`);
  console.log(
    `now ${et.date} ${et.hour}:${String(et.minute).padStart(2, '0')} ${TZ} — ` +
      `sending daily at ${SEND_HOUR}:${String(SEND_MINUTE).padStart(2, '0')}`
  );
  setInterval(() => {
    tick().catch((err) => console.error('tick failed:', err));
  }, TICK_MS);

  // PROBE_ALLO=1 prints the status of a set of candidate Allo endpoints, for
  // working out the right base path from logs when the docs are unreachable.
  if (/^(1|true|yes)$/i.test(process.env.PROBE_ALLO || '')) {
    import('./scripts/probe-allo.js')
      .then((m) => m.probeAllo())
      .catch((err) => console.error('PROBE_ALLO failed:', err.message));
  }

  // PROBE_ENRICH=1 exercises each enrichment provider once and dumps the raw
  // responses, so their real request/response shapes can be verified.
  if (/^(1|true|yes)$/i.test(process.env.PROBE_ENRICH || '')) {
    import('./scripts/probe-enrich.js')
      .then((m) => m.probeEnrich())
      .catch((err) => console.error('PROBE_ENRICH failed:', err.message));
  }

  // BOOT_DRY_RUN=1 does one read-only pass at startup and logs the result.
  // Useful where the deployment URL is not reachable but the logs are.
  // It never writes to Smartlead.
  if (/^(1|true|yes)$/i.test(process.env.BOOT_DRY_RUN || '')) {
    console.log('BOOT_DRY_RUN — read-only preview, nothing will be sent');
    runFollowUp({ dryRun: true })
      .then((stats) => console.log('BOOT_DRY_RUN result:', JSON.stringify(stats, null, 2)))
      .catch((err) => console.error('BOOT_DRY_RUN failed:', err.message, err.stack));
  }
});
