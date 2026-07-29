/**
 * Manual entry point -- no clock guard, no weekend guard.
 *
 *   GET /api/run?key=$CRON_SECRET&dry=1              preview today, send nothing
 *   GET /api/run?key=$CRON_SECRET&dry=1&date=2026-07-28   preview another day
 *   GET /api/run?key=$CRON_SECRET                    actually push to Smartlead
 *
 * Start with dry=1. It returns the exact list of people who would be mailed.
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

  try {
    const stats = await runFollowUp({ dryRun, date });
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
