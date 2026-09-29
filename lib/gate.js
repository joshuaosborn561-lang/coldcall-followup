/**
 * Gate Smartlead uploads on the VerifyFall waterfall.
 *
 *   1. Harvest completed pending runs (resume stalled ones).
 *   2. SENDABLE leads from this batch (or an earlier one) may be pushed.
 *   3. REJECTED leads are recorded and never uploaded.
 *   4. Unknown addresses are submitted in a batch and wait for the next tick.
 */

import {
  collectResultSets,
  getVerifierResults,
  getVerifierRun,
  resumeVerifierRun,
  startVerificationUpload,
} from './verifier.js';
import {
  attachLead,
  getCachedLead,
  listPendingRuns,
  lookupByPhone,
  lookupVerdict,
  markPending,
  markResults,
} from './verdicts.js';

export function verifyBatchSize() {
  const n = Number.parseInt(process.env.VERIFY_BATCH_SIZE ?? '75', 10);
  return Number.isFinite(n) && n > 0 ? n : 75;
}

function emailOf(lead) {
  return String(lead?.email || '').trim().toLowerCase();
}

export async function harvestPendingRuns({ dryRun = false } = {}) {
  const pending = await listPendingRuns();
  const harvested = { completed: 0, resumed: 0, sendable: 0, rejected: 0, credits: { mv: 0, n2b: 0 }, errors: [] };

  for (const item of pending) {
    try {
      const wrapped = await getVerifierRun(item.runId);
      const run = wrapped.run || wrapped;
      const status = run.status;
      if (status === 'failed' || status === 'paused' || status === 'queued') {
        if (dryRun) continue;
        await resumeVerifierRun(item.runId);
        harvested.resumed++;
        continue;
      }
      if (status !== 'completed' && !wrapped.downloads) continue;

      const results = await getVerifierResults(item.runId);
      const sets = await collectResultSets({ ...results, run });
      await markResults({ runId: item.runId, sendable: sets.sendable, rejected: sets.rejected });
      harvested.completed++;
      harvested.sendable += sets.sendable.size;
      harvested.rejected += sets.rejected.size;
      harvested.credits.mv += sets.credits.mv;
      harvested.credits.n2b += sets.credits.n2b;
    } catch (err) {
      harvested.errors.push(`${item.runId}: ${err.message}`);
    }
  }
  return harvested;
}

/**
 * Split prepared Smartlead leads into push / queue / reject.
 * Does not upload or start a run when dryRun is true.
 */
export async function gateLeads(leads, { dryRun = false, segmentName } = {}) {
  const harvested = await harvestPendingRuns({ dryRun });

  const toPush = [];
  const rejected = [];
  const pending = [];
  const unknown = [];

  for (const lead of leads) {
    const email = emailOf(lead);
    if (!email) continue;
    await attachLead(email, lead);
    const verdict = await lookupVerdict(email);
    if (verdict?.status === 'rejected') {
      rejected.push({ email, reason: 'verifier rejected' });
      continue;
    }
    if (verdict?.status === 'sendable') {
      toPush.push(lead);
      continue;
    }
    if (verdict?.status === 'pending') {
      pending.push(email);
      continue;
    }
    unknown.push(lead);
  }

  let submitted = null;
  const batch = unknown.slice(0, verifyBatchSize());
  const overflow = unknown.slice(verifyBatchSize());

  if (!dryRun && batch.length > 0) {
    const emails = batch.map(emailOf);
    const leadsByEmail = Object.fromEntries(batch.map((l) => [emailOf(l), l]));
    const name =
      segmentName ||
      `coldcall_followup_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
    submitted = await startVerificationUpload({ emails, segmentName: name });
    if (submitted.runId) {
      await markPending({ emails, runId: submitted.runId, leadsByEmail });
    }
  } else if (dryRun) {
    submitted = { runId: null, count: batch.length, dryRun: true };
  }

  // Newly completed harvest may have unlocked leads from a previous tick.
  const unlocked = [];
  for (const email of pending) {
    const again = await lookupVerdict(email);
    if (again?.status === 'sendable') {
      unlocked.push(getCachedLead(email) || { email });
    }
  }

  return {
    toPush: [...toPush, ...unlocked.filter((l) => l?.email)],
    rejected,
    pending: pending.filter((e) => !unlocked.some((l) => emailOf(l) === e)),
    queued: batch.map(emailOf),
    overflow: overflow.map(emailOf),
    submitted,
    harvested,
  };
}

/** True when this email/phone should skip enrichment (already decided or in flight). */
export async function shouldSkipEnrichment({ email, phone } = {}) {
  if (email) {
    const v = await lookupVerdict(email);
    if (v && (v.status === 'rejected' || v.status === 'pending' || v.status === 'sendable')) return true;
  }
  if (phone) {
    const v = await lookupByPhone(phone);
    if (v && (v.status === 'rejected' || v.status === 'pending' || v.status === 'sendable')) return true;
  }
  return false;
}
