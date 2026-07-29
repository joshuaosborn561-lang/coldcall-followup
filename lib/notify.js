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

  // Per rep, so it is obvious at a glance if someone's number went quiet.
  for (const route of stats.routes || []) {
    const bits = [
      `${route.peopleCalled} ${plural(route.peopleCalled, 'person', 'people')} called`,
      `${route.leadsPrepared} with an email`,
    ];
    const upload = (stats.uploads || []).find((u) => u.campaignId === route.campaignId);
    if (!stats.dryRun && upload) {
      bits.push(upload.error ? `*upload failed*` : `${upload.uploaded} added`);
    }
    lines.push(`• *${route.label}* — ${bits.join(' · ')}`);
  }

  if (!stats.routes?.length) {
    lines.push(`${totals.peopleCalled ?? 0} called · ${totals.leadsPrepared ?? 0} with an email`);
  }

  if (stats.dryRun) lines.push('_Dry run — nothing was sent._');

  const extra = [];
  if (totals.duplicates) extra.push(`${totals.duplicates} already in campaign`);
  if (totals.invalid) extra.push(`${totals.invalid} invalid`);
  if (totals.unsubscribed) extra.push(`${totals.unsubscribed} unsubscribed`);
  if (extra.length) lines.push(`Skipped by Smartlead: ${extra.join(', ')}`);

  if (stats.collisions?.length) {
    lines.push(`\n*Called by both (${stats.collisions.length}) — one follow-up each, newest call wins:*`);
    for (const c of stats.collisions.slice(0, 5)) {
      lines.push(`• ${c.email} → ${c.assignedTo}`);
    }
  }

  if (stats.skipped?.length) {
    const shown = stats.skipped.slice(0, 10);
    lines.push(`\n*No email on file (${stats.skipped.length}) — add in Allo to follow up:*`);
    for (const s of shown) {
      lines.push(`• ${s.name ? `${s.name} — ` : ''}${s.number}${s.calledBy ? ` (${s.calledBy})` : ''}`);
    }
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
