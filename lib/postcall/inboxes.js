/**
 * Inbox selection is scoped to one caller + client pool. Never borrow.
 *
 * Sticky: a contact reuses the inbox that already emailed them.
 * New contacts: round-robin across healthy inboxes under the daily cap (35).
 */

export const DEFAULT_DAILY_CAP = 35;

export function poolKey(caller, client) {
  return `${caller}::${client}`;
}

export function pickInbox({
  pool = [],
  contact,
  dailyCounts = {},
  roundRobinIndex = 0,
  dayCap = DEFAULT_DAILY_CAP,
} = {}) {
  const emails = (pool || [])
    .filter((box) => box && box.email && box.healthy !== false)
    .map((box) => ({
      ...box,
      email: String(box.email).trim().toLowerCase(),
      cap: Number(box.max_sends_per_day || dayCap),
    }));

  if (emails.length === 0) {
    return { ok: false, reason: 'inbox_pool_empty' };
  }

  const sticky = String(contact?.inbox || '').trim().toLowerCase();
  if (sticky) {
    const owned = emails.find((box) => box.email === sticky);
    if (!owned) {
      return { ok: false, reason: 'sticky_inbox_not_in_pool' };
    }
    const used = Number(dailyCounts[owned.email] || 0);
    if (used >= owned.cap) {
      return { ok: false, reason: 'inbox_pool_at_cap', queue: true };
    }
    return { ok: true, inbox: owned.email, sticky: true };
  }

  const underCap = emails.filter((box) => Number(dailyCounts[box.email] || 0) < box.cap);
  if (underCap.length === 0) {
    return { ok: false, reason: 'inbox_pool_at_cap', queue: true };
  }

  const idx = Math.abs(Number(roundRobinIndex) || 0) % underCap.length;
  const chosen = underCap[idx];
  return { ok: true, inbox: chosen.email, sticky: false, nextIndex: idx + 1 };
}

export function assertPoolIsolation(pool, { caller, client } = {}) {
  for (const box of pool || []) {
    if (box.caller && box.caller !== caller) {
      throw new Error(`inbox ${box.email} belongs to ${box.caller}, not ${caller}`);
    }
    if (box.client && box.client !== client) {
      throw new Error(`inbox ${box.email} belongs to ${box.client}, not ${client}`);
    }
  }
}
