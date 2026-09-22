/**
 * One-shot incremental follow-up for Railway cronSchedule.
 *
 * The production `followup` service stays always-on (`npm start`) so
 * /api/health and /api/run keep answering. If you later switch that service
 * (or a sibling) to native cron, set the start command to:
 *
 *   npm run cron
 *
 * This process exits when the run finishes. Weekday-daytime and lookback
 * guards live in the same helpers the long-running ticker uses.
 */

import { notifySlack } from '../lib/notify.js';
import { runFollowUp } from '../lib/pipeline.js';
import { LOOKBACK_MINUTES, TZ, isWeekdayDaytime, isWeekend, zonedParts } from '../lib/time.js';

function skipWeekends() {
  const raw = process.env.SKIP_WEEKENDS;
  if (raw === undefined) return true;
  return /^(1|true|yes)$/i.test(raw.trim());
}

const now = new Date();
const et = zonedParts(now, TZ);
const force = process.argv.includes('--force');

if (!force && skipWeekends() && isWeekend(now, TZ)) {
  console.log(`[${et.date}] weekend — skipped`);
  process.exit(0);
}

if (!force && !isWeekdayDaytime(now, TZ)) {
  console.log(`[${et.date} ${et.hour}:${String(et.minute).padStart(2, '0')} ${TZ}] outside weekday daytime — skipped`);
  process.exit(0);
}

try {
  const stats = await runFollowUp({ dryRun: false, lookbackMinutes: LOOKBACK_MINUTES });
  const totals = stats.totals || {};
  if ((totals.leadsPrepared ?? 0) > 0 || (totals.uploaded ?? 0) > 0 || (stats.warnings || []).length > 0) {
    stats.slack = await notifySlack(stats);
  }
  console.log(JSON.stringify(stats, null, 2));
} catch (err) {
  console.error('cron-run failed:', err.message);
  await notifySlack({
    date: et.date,
    dryRun: false,
    totals: { eligibleCalls: 0, leadsPrepared: 0 },
    skipped: [],
    warnings: [`Run failed: ${err.message}`],
  });
  process.exit(1);
}
