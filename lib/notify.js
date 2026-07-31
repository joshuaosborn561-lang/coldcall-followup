/**
 * Optional Slack ping so a daily unattended job is not invisible.
 * No-op unless SLACK_WEBHOOK_URL is set. Never throws -- a broken notifier
 * must not fail a run that already pushed leads.
 */

export async function notifySlack(stats) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { sent: false, reason: 'SLACK_WEBHOOK_URL not set' };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: formatSummary(stats) }),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

export function formatSummary(stats) {
  const lines = [];
  const totals = stats.totals || {};

  lines.push(
    stats.dryRun
      ? `*Cold call follow-up — dry run for ${stats.date}*`
      : `*Cold call follow-up — ${stats.date}*`
  );

  lines.push(
    `${totals.voicemailsLeft ?? 0} voicemail${totals.voicemailsLeft === 1 ? '' : 's'} left ` +
      `of ${totals.callsInWindow ?? 0} outbound calls · ` +
      `${totals.leadsPrepared ?? 0} with an email` +
      (stats.dryRun ? '' : ` · ${totals.uploaded ?? 0} added`)
  );

  // Per rep, so it is obvious at a glance if someone went quiet.
  const byRep = Object.entries(stats.byRep || {});
  if (byRep.length) {
    lines.push(byRep.map(([rep, n]) => `${rep}: ${n}`).join(' · '));
  }

  const src = stats.emailSources || {};
  const srcBits = [];
  if (src.allo_crm) srcBits.push(`${src.allo_crm} from Allo`);
  if (src.call_extraction) srcBits.push(`${src.call_extraction} from call audio`);
  if (src.enriched) srcBits.push(`${src.enriched} enriched`);
  if (srcBits.length) lines.push(`Emails: ${srcBits.join(', ')}`);

  if (stats.dryRun) lines.push('_Dry run — nothing was sent._');

  const extra = [];
  if (totals.duplicates) extra.push(`${totals.duplicates} already in campaign`);
  if (totals.invalid) extra.push(`${totals.invalid} invalid`);
  if (totals.unsubscribed) extra.push(`${totals.unsubscribed} unsubscribed`);
  if (extra.length) lines.push(`Skipped by Smartlead: ${extra.join(', ')}`);

  // Only the no-email cases are worth listing; calls with no voicemail are
  // expected and would drown the summary.
  const noEmail = (stats.skipped || []).filter((s) => /no email/i.test(s.reason || ''));
  if (noEmail.length) {
    const shown = noEmail.slice(0, 10);
    lines.push(`\n*Voicemail left but no email found (${noEmail.length}):*`);
    for (const s of shown) {
      lines.push(`• ${s.name ? `${s.name} — ` : ''}${s.number}${s.calledBy ? ` (${s.calledBy})` : ''}`);
    }
    if (noEmail.length > shown.length) lines.push(`• …and ${noEmail.length - shown.length} more`);
  }

  for (const w of stats.warnings || []) lines.push(`\n:warning: ${w}`);

  return lines.join('\n');
}

