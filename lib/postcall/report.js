/**
 * Daily Slack report: per caller, per client.
 */

import { getPostcallStore } from './store.js';
import { postSlack } from './slack.js';

export function buildDailyReport({ events = [], bookings = [], day } = {}) {
  const groups = new Map();
  const keyOf = (caller, client) => `${caller || 'unknown'} / ${client || 'unknown'}`;
  const ensure = (caller, client) => {
    const key = keyOf(caller, client);
    if (!groups.has(key)) {
      groups.set(key, {
        caller,
        client,
        voicemails: 0,
        sent: 0,
        queued: 0,
        skipped: {},
        replies: 0,
        meetings: 0,
      });
    }
    return groups.get(key);
  };

  for (const ev of events) {
    const g = ensure(ev.caller, ev.client);
    if (ev.action === 'sent' && !ev.dry_run) g.sent++;
    if (ev.action === 'queued') g.queued++;
    if (ev.action === 'reply') g.replies++;
    if (ev.action === 'skipped') {
      const reason = ev.reason || 'unknown';
      g.skipped[reason] = (g.skipped[reason] || 0) + 1;
    }
    if (ev.payload?.voicemail || ev.reason === 'voicemail_logged' || ev.action === 'voicemail') {
      g.voicemails++;
    }
  }

  for (const b of bookings) {
    const client = bookingClient(b);
    const g = ensure(b.caller || 'all', client);
    g.meetings++;
  }

  const lines = [`*Post-call daily · ${day}*`];
  if (groups.size === 0) lines.push('_No post-call activity._');
  for (const [label, g] of [...groups.entries()].sort()) {
    const skipBits = Object.entries(g.skipped).map(([k, n]) => `${k} ${n}`);
    lines.push(
      `*${label}* — VM logged ${g.voicemails} · sent ${g.sent} · queued ${g.queued} · replies ${g.replies} · meetings ${g.meetings}`
    );
    if (skipBits.length) lines.push(`  skipped: ${skipBits.join(', ')}`);
  }
  return { text: lines.join('\n'), groups: Object.fromEntries(groups) };
}

function bookingClient(row) {
  const slug = String(row.client_slug || row.client_name || row.campaign_id || '').toLowerCase();
  if (slug.includes('emcor')) return 'emcor';
  if (slug.includes('deep') || slug.includes('deeproot')) return 'deep_roots';
  if (slug.includes('sales')) return 'salesglider';
  return row.client || 'unknown';
}

export async function runDailyReport({ day, dryRun = false, events, bookings } = {}) {
  const store = getPostcallStore();
  const stamp = day || new Date().toISOString().slice(0, 10);
  const evs = events || store.state?.events || [];
  const books = bookings || [];
  const report = buildDailyReport({ events: evs, bookings: books, day: stamp });
  const slack = dryRun ? { sent: false, reason: 'dry_run' } : await postSlack(report.text);
  return { ...report, slack };
}
