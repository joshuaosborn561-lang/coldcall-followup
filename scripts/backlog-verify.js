/**
 * One-time cleanup: verify not-started leads in campaign 3739316 and
 * remove REJECTED ones so they never send. Does not pause the campaign
 * and does not touch leads that already started / completed / bounced.
 *
 *   SMARTLEAD_API_KEY=... node scripts/backlog-verify.js --dry
 *   SMARTLEAD_API_KEY=... node scripts/backlog-verify.js --yes
 */

import { writeFile } from 'node:fs/promises';
import {
  campaignId,
  deleteLead,
  getCampaign,
  listCampaignLeads,
} from '../lib/smartlead.js';
import {
  collectResultSets,
  getVerifierResults,
  getVerifierRun,
  startVerificationUpload,
} from '../lib/verifier.js';
import { markResults } from '../lib/verdicts.js';

const dry = process.argv.includes('--dry');
const yes = process.argv.includes('--yes');
// Analytics "notStarted" / drafted maps to status STARTED on this campaign.
// COMPLETED and BLOCKED have already been mailed (or bounced).
const ALREADY_CONTACTED = new Set(['COMPLETED', 'BLOCKED', 'PAUSED', 'STOPPED', 'INPROGRESS', 'IN_PROGRESS']);

if (!dry && !yes) {
  console.error('Pass --dry to preview, or --yes to remove REJECTED not-started leads.');
  process.exit(2);
}

const id = campaignId();
const campaign = await getCampaign(id);
if (String(campaign.status).toUpperCase() !== 'ACTIVE') {
  console.error(`Refusing to continue: campaign ${id} status is ${campaign.status} (must stay ACTIVE).`);
  process.exit(1);
}

const notStarted = [];
const statusCounts = {};
let offset = 0;
const pageSize = 100;

for (;;) {
  const page = await listCampaignLeads({ id, offset, limit: pageSize });
  const rows = page.data || page.leads || [];
  for (const row of rows) {
    const status = String(row.status || '').toUpperCase();
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (ALREADY_CONTACTED.has(status)) continue;
    const email = row.lead?.email || row.email;
    const leadId = row.lead?.id || row.lead_id || row.id;
    if (email && leadId) notStarted.push({ email: String(email).toLowerCase(), leadId });
  }
  offset += rows.length;
  if (rows.length < pageSize) break;
}

const unique = new Map();
for (const row of notStarted) {
  if (!unique.has(row.email)) unique.set(row.email, row);
}

console.log(
  JSON.stringify(
    {
      campaignId: id,
      campaignStatus: campaign.status,
      statusCounts,
      notStarted: unique.size,
      dry,
    },
    null,
    2
  )
);

if (unique.size === 0) {
  console.log('No not-started leads to verify.');
  process.exit(0);
}

const emails = [...unique.keys()];
const started = await startVerificationUpload({
  emails,
  segmentName: `coldcall_3739316_backlog_${new Date().toISOString().slice(0, 10)}`,
});
console.log(JSON.stringify({ submitted: started }, null, 2));

let sets = null;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 20_000));
  const wrapped = await getVerifierRun(started.runId);
  const run = wrapped.run || wrapped;
  console.log(
    JSON.stringify({
      poll: i + 1,
      status: run.status,
      stage: run.stage_completed,
      sendable: run.final_sendable_count,
      rejected: run.final_rejected_count,
      mvCredits: run.mv_credits_used,
      n2bCredits: run.n2b_credits_used,
    })
  );
  if (run.status === 'completed') {
    const results = await getVerifierResults(started.runId);
    sets = await collectResultSets({ ...results, run });
    break;
  }
  if (run.status === 'failed') {
    console.error('Verification run failed:', run.last_error);
    process.exit(1);
  }
}

if (!sets) {
  console.error('Timed out waiting for verification.');
  process.exit(1);
}

await markResults({ runId: started.runId, sendable: sets.sendable, rejected: sets.rejected });

const toRemove = [];
for (const [email, row] of unique) {
  if (sets.rejected.has(email)) toRemove.push(row);
}

const summary = {
  checked: unique.size,
  sendable: sets.sendable.size,
  rejected: sets.rejected.size,
  wouldRemove: toRemove.length,
  credits: sets.credits,
  runId: started.runId,
  removed: 0,
};

if (!dry) {
  for (const row of toRemove) {
    await deleteLead(row.leadId, { id });
    summary.removed++;
  }
}

await writeFile('/tmp/followup-backlog-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
