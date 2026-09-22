/**
 * Scheduled entry point. Railway's in-process ticker hits the same pipeline
 * this handler uses. `/api/cron` is also the one-shot path if the service is
 * later switched to Railway cronSchedule (`npm run cron`).
 *
 * Default: weekday daytime only, last LOOKBACK_MINUTES of calls.
 * Bypass the clock with ?force=1 (still needs auth), or use /api/run for a
 * full-day backfill.
 */

import { boolParam, isAuthorized } from '../lib/auth.js';
import { notifySlack } from '../lib/notify.js';
import { runFollowUp } from '../lib/pipeline.js';
import { LOOKBACK_MINUTES, TZ, isWeekdayDaytime, isWeekend, zonedParts } from '../lib/time.js';

export default async function handler(req, res) {
  const auth = isAuthorized(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: `Unauthorized: ${auth.reason}` });
  }

  const now = new Date();
  const et = zonedParts(now, TZ);
  const force = boolParam(req, 'force');

  if (!force && skipWeekends() && isWeekend(now)) {
    return res.status(200).json({ ok: true, skipped: 'weekend', localTime: `${et.date} (${et.weekday})` });
  }

  if (!force && !isWeekdayDaytime(now)) {
    return res.status(200).json({
      ok: true,
      skipped: 'outside weekday daytime window',
      localTime: `${et.date} ${pad(et.hour)}:${pad(et.minute)} ${TZ}`,
    });
  }

  try {
    const stats = await runFollowUp({ dryRun: false, lookbackMinutes: LOOKBACK_MINUTES });
    if (shouldNotify(stats)) stats.slack = await notifySlack(stats);
    return res.status(200).json({ ok: true, ...stats });
  } catch (err) {
    const payload = {
      ok: false,
      error: err.message,
      name: err.name,
      status: err.status ?? null,
      date: `${et.date}`,
    };
    await notifySlack({
      date: et.date,
      dryRun: false,
      peopleCalled: 0,
      leadsPrepared: 0,
      skipped: [],
      warnings: [`Run failed: ${err.message}`],
    });
    return res.status(500).json(payload);
  }
}

function skipWeekends() {
  const raw = process.env.SKIP_WEEKENDS;
  if (raw === undefined) return true;
  return /^(1|true|yes)$/i.test(raw.trim());
}

function shouldNotify(stats) {
  const totals = stats.totals || {};
  return (
    (totals.leadsPrepared ?? 0) > 0 ||
    (totals.uploaded ?? 0) > 0 ||
    (stats.warnings || []).length > 0
  );
}

function pad(n) {
  return String(n).padStart(2, '0');
}
