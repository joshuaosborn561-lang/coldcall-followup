/**
 * Run the pipeline from a terminal, without deploying.
 *
 *   ALLO_API_KEY=... SMARTLEAD_API_KEY=... SMARTLEAD_CAMPAIGN_ID=... \
 *     node scripts/local-run.js --dry [--date 2026-07-30]
 *
 * --dry is read-only: it reads Allo and resolves the campaign, but never adds
 * a lead. Omit it and it writes to Smartlead for real.
 */

import { runFollowUp } from '../lib/pipeline.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const dateIdx = args.indexOf('--date');
const date = dateIdx >= 0 ? args[dateIdx + 1] : null;

if (!dryRun && !args.includes('--yes-really-send')) {
  console.error('Refusing to write to Smartlead. Pass --dry to preview, or --yes-really-send to commit.');
  process.exit(2);
}

const stats = await runFollowUp({ dryRun, date });
console.log(JSON.stringify(stats, null, 2));
