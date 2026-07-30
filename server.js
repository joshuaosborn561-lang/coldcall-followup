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
import { SEND_HOUR, TZ, isWeekend, zonedParts } from './lib/time.js';

const PORT = Number(process.env.PORT || 3000);
const SEND_MINUTE = Number(process.env.SEND_MINUTE ?? 30);
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
      nextSend: `${String(SEND_HOUR).padStart(2, '0')}:${String(SEND_MINUTE).padStart(2, '0')} ${TZ} daily`,
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

function skipWeekends() {
  const raw = process.env.SKIP_WEEKENDS;
  if (raw === undefined) return true;
  return /^(1|true|yes)$/i.test(raw.trim());
}

async function tick() {
  const now = new Date();
  const et = zonedParts(now, TZ);

  if (et.hour !== SEND_HOUR || et.minute < SEND_MINUTE) return;
  if (lastFiredDate === et.date) return; // already ran today

  lastFiredDate = et.date; // claim the day before awaiting, so a slow run cannot double-fire

  if (skipWeekends() && isWeekend(now, TZ)) {
    lastScheduledRun = { date: et.date, skipped: 'weekend' };
    console.log(`[${et.date}] weekend — skipped`);
    return;
  }

  console.log(`[${et.date}] ${et.hour}:${et.minute} ${TZ} — running follow-up`);
  try {
    const stats = await runFollowUp({ dryRun: false });
    stats.slack = await notifySlack(stats);
    lastScheduledRun = {
      date: et.date,
      peopleCalled: stats.totals.peopleCalled,
      leadsPrepared: stats.totals.leadsPrepared,
      uploaded: stats.totals.uploaded,
      warnings: stats.warnings,
    };
    console.log(JSON.stringify(lastScheduledRun));
  } catch (err) {
    lastScheduledRun = { date: et.date, error: err.message };
    console.error(`[${et.date}] follow-up failed:`, err.message);
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
});
