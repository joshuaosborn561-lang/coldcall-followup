/**
 * Scheduled entry point. Vercel fires this at 20:30 and 21:30 UTC daily; the
 * send-window guard lets through only the firing that is 4:30pm Eastern, so
 * the job stays put across the DST changeover. See lib/time.js.
 *
 * Bypass the guard for a one-off manual run with ?force=1 (still needs auth),
 * or just use /api/run.
 */

import { boolParam, isAuthorized } from '../lib/auth.js';
import { notifySlack } from '../lib/notify.js';
import { runFollowUp } from '../lib/pipeline.js';
import { isSendWindow, isWeekend, zonedParts, TZ } from '../lib/time.js';

export default async function handler(req, res) {
  const auth = isAuthorized(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: `Unauthorized: ${auth.reason}` });
  }

  const now = new Date();
  const et = zonedParts(now, TZ);
  const force = boolParam(req, 'force');

  if (!force && !isSendWindow(now)) {
    // The other of the two daily firings. Expected, not an error.
    return res.status(200).json({
      ok: true,
      skipped: 'outside send window',
      localTime: `${et.date} ${pad(et.hour)}:${pad(et.minute)} ${TZ}`,
    });
  }

  if (!force && skipWeekends() && isWeekend(now)) {
    return res.status(200).json({ ok: true, skipped: 'weekend', localTime: `${et.date} (${et.weekday})` });
  }

  try {
    const stats = await runFollowUp({ dryRun: false });
    stats.slack = await notifySlack(stats);
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

function pad(n) {
  return String(n).padStart(2, '0');
}
