/**
 * Manual entry point -- no clock guard, no weekend guard.
 *
 *   GET /api/run?key=$CRON_SECRET&dry=1                    preview today
 *   GET /api/run?key=$CRON_SECRET&dry=1&date=2026-07-28    preview a day
 *   GET /api/run?key=$CRON_SECRET&dry=1&date=2026-07-28&through=2026-07-30
 *   GET /api/run?key=$CRON_SECRET&dry=1&lookback=20         preview last 20m
 *   GET /api/run?key=$CRON_SECRET                           push to Smartlead
 *
 * Start with dry=1. It returns the exact list of people who would be mailed.
 * `date` (and optional `through`) is the full-day / backlog path.
 */

import { boolParam, isAuthorized, queryParam } from '../lib/auth.js';
import { notifySlack } from '../lib/notify.js';
import { runFollowUp } from '../lib/pipeline.js';

export default async function handler(req, res) {
  const auth = isAuthorized(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: `Unauthorized: ${auth.reason}` });
  }

  const dryRun = boolParam(req, 'dry');
  const date = queryParam(req, 'date') || null;
  const throughDate = queryParam(req, 'through') || queryParam(req, 'throughDate') || null;
  const lookbackRaw = queryParam(req, 'lookback');
  const lookbackMinutes = lookbackRaw !== '' && date == null ? Number(lookbackRaw) : null;

  if (lookbackMinutes != null && (!Number.isFinite(lookbackMinutes) || lookbackMinutes <= 0)) {
    return res.status(400).json({ ok: false, error: `Invalid lookback "${lookbackRaw}"` });
  }

  try {
    const stats = await runFollowUp({ dryRun, date, throughDate, lookbackMinutes });
    if (!dryRun && boolParam(req, 'notify')) {
      stats.slack = await notifySlack(stats);
    }
    return res.status(200).json({ ok: true, ...stats });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      name: err.name,
      status: err.status ?? null,
      details: err.body ?? null,
    });
  }
}
