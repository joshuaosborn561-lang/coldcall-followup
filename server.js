/**
 * Long-running server, for hosts without a serverless cron (Railway, Render,
 * Fly, a VPS). Vercel does not need this -- there `api/*.js` are the functions
 * and `vercel.json` drives the schedule. Both deployment styles share the same
 * handlers and pipeline.
 *
 *   npm start
 *
 * Routes /api/cron, /api/run and /api/health to the same handlers Vercel uses,
 * and runs the weekday every-10-minute schedule in-process. Railway owns this
 * ticker -- it does not depend on an external bot routine.
 */

import { createServer } from 'node:http';

import cronHandler from './api/cron.js';
import healthHandler from './api/health.js';
import runHandler from './api/run.js';
import { notifySlack } from './lib/notify.js';
import { runFollowUp } from './lib/pipeline.js';
import {
  DAYTIME_END_HOUR,
  DAYTIME_START_HOUR,
  LOOKBACK_MINUTES,
  SCHEDULE_INTERVAL_MINUTES,
  TZ,
  isWeekdayDaytime,
  isWeekend,
  scheduleSlot,
  zonedParts,
} from './lib/time.js';

const PORT = Number(process.env.PORT || 3000);
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
      schedule: describeSchedule(),
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

let lastFiredSlot = null;
let lastScheduledRun = null;

const pad = (n) => String(n).padStart(2, '0');

function describeSchedule() {
  return {
    intervalMinutes: SCHEDULE_INTERVAL_MINUTES,
    lookbackMinutes: LOOKBACK_MINUTES,
    weekdays: `${pad(DAYTIME_START_HOUR)}:00–${pad(DAYTIME_END_HOUR)}:00 ${TZ}`,
    weekends: 'skipped',
  };
}

function skipWeekends() {
  const raw = process.env.SKIP_WEEKENDS;
  if (raw === undefined) return true;
  return /^(1|true|yes)$/i.test(raw.trim());
}

/**
 * Every SCHEDULE_INTERVAL_MINUTES during weekday daytime, process only the
 * last LOOKBACK_MINUTES of outbound calls. Overlap + Smartlead dedupe makes
 * a missed tick or a restart safe without re-paging the whole day.
 */
async function tick() {
  const now = new Date();
  const et = zonedParts(now, TZ);

  if (skipWeekends() && isWeekend(now, TZ)) return;
  if (!isWeekdayDaytime(now, TZ)) return;

  const slot = scheduleSlot(now, TZ);
  if (lastFiredSlot === slot) return;
  lastFiredSlot = slot; // claim before awaiting, so a slow run cannot double-fire

  const label = `${et.date} ${pad(et.hour)}:${pad(et.minute)}`;
  console.log(
    `[${label} ${TZ}] running incremental follow-up (lookback ${LOOKBACK_MINUTES}m)`
  );
  try {
    const stats = await runFollowUp({ dryRun: false, lookbackMinutes: LOOKBACK_MINUTES });
    if (shouldNotify(stats)) stats.slack = await notifySlack(stats);
    lastScheduledRun = {
      date: stats.date,
      mode: stats.mode,
      eligibleCalls: stats.totals.eligibleCalls,
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
      totals: { peopleCalled: 0, eligibleCalls: 0, leadsPrepared: 0 },
      routes: [],
      skipped: [],
      warnings: [`Run failed: ${err.message}`],
    });
  }
}

function shouldNotify(stats) {
  const totals = stats.totals || {};
  return (
    (totals.leadsPrepared ?? 0) > 0 ||
    (totals.uploaded ?? 0) > 0 ||
    (stats.warnings || []).length > 0
  );
}

server.listen(PORT, () => {
  const et = zonedParts(new Date(), TZ);
  console.log(`coldcall-follow-up listening on :${PORT}`);
  console.log(
    `now ${et.date} ${et.hour}:${String(et.minute).padStart(2, '0')} ${TZ} — ` +
      `every ${SCHEDULE_INTERVAL_MINUTES}m, last ${LOOKBACK_MINUTES}m, ` +
      `weekdays ${pad(DAYTIME_START_HOUR)}:00–${pad(DAYTIME_END_HOUR)}:00`
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
    runFollowUp({ dryRun: true, lookbackMinutes: LOOKBACK_MINUTES })
      .then((stats) => console.log('BOOT_DRY_RUN result:', JSON.stringify(stats, null, 2)))
      .catch((err) => console.error('BOOT_DRY_RUN failed:', err.message, err.stack));
  }
});
