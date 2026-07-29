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
  const uploaded = stats.smartlead?.uploaded ?? 0;

  lines.push(
    stats.dryRun
      ? `*Cold call follow-up — dry run for ${stats.date}*`
      : `*Cold call follow-up — ${stats.date}*`
  );
  lines.push(
    `Called ${stats.peopleCalled} ${plural(stats.peopleCalled, 'person', 'people')} · ` +
      `${stats.leadsPrepared} with an email on file` +
      (stats.dryRun ? ' (nothing sent)' : ` · ${uploaded} added to Smartlead`)
  );

  const sl = stats.smartlead;
  if (sl) {
    const extra = [];
    if (sl.duplicates) extra.push(`${sl.duplicates} already in campaign`);
    if (sl.invalid) extra.push(`${sl.invalid} invalid`);
    if (sl.unsubscribed) extra.push(`${sl.unsubscribed} unsubscribed`);
    if (sl.leadLimitExhausted) extra.push('*lead limit reached*');
    if (extra.length) lines.push(`Skipped by Smartlead: ${extra.join(', ')}`);
  }

  if (stats.skipped?.length) {
    const shown = stats.skipped.slice(0, 10);
    lines.push(`\n*No email on file (${stats.skipped.length}) — add in Allo to follow up:*`);
    for (const s of shown) lines.push(`• ${s.name ? `${s.name} — ` : ''}${s.number} (${s.reason})`);
    if (stats.skipped.length > shown.length) {
      lines.push(`• …and ${stats.skipped.length - shown.length} more`);
    }
  }

  for (const w of stats.warnings || []) lines.push(`\n:warning: ${w}`);

  return lines.join('\n');
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}
