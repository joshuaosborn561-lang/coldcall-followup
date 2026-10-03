/**
 * Supabase access for post-call tables. Tests inject a memory adapter.
 */

const DEFAULT_URL = 'https://azpapwtnrbzywlnxxecz.supabase.co';

export function supabaseEnv() {
  const url = (process.env.SUPABASE_URL || DEFAULT_URL).replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, key, enabled: Boolean(key) };
}

async function rest({ path, method = 'GET', query, body }) {
  const { url, key, enabled } = supabaseEnv();
  if (!enabled) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  const target = new URL(url + '/rest/v1/' + path.replace(/^\//, ''));
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) target.searchParams.set(k, String(v));
  }
  const res = await fetch(target, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: method === 'GET' ? 'return=representation' : 'return=representation,resolution=merge-duplicates',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || text.slice(0, 300);
    throw new Error(`Supabase ${method} ${path} failed: ${msg}`);
  }
  return parsed;
}

export function createMemoryStore(seed = {}) {
  const state = {
    configs: seed.configs || [],
    templates: seed.templates || [],
    inboxes: seed.inboxes || [],
    contacts: seed.contacts || [],
    events: seed.events || [],
    daily: seed.daily || [],
    queue: seed.queue || [],
    seeds: seed.seeds || [],
    suppression: seed.suppression || [],
    campaignLeads: seed.campaignLeads || [],
    rr: seed.rr || {},
  };

  const lower = (v) => String(v || '').trim().toLowerCase();

  return {
    kind: 'memory',
    state,
    async loadConfigs() {
      return state.configs.map((c) => ({
        ...c,
        templates: state.templates.filter((t) => t.config_id === c.id),
        inboxes: state.inboxes.filter((i) => i.config_id === c.id).map((i) => ({ ...i, caller: c.caller, client: c.client })),
      }));
    },
    async getContact(caller, client, email) {
      return state.contacts.find((r) => r.caller === caller && r.client === client && r.email === lower(email)) || null;
    },
    async upsertContact(row) {
      const email = lower(row.email);
      const idx = state.contacts.findIndex((r) => r.caller === row.caller && r.client === row.client && r.email === email);
      const next = { ...row, email, updated_at: new Date().toISOString() };
      if (idx >= 0) state.contacts[idx] = { ...state.contacts[idx], ...next };
      else state.contacts.push({ status: 'active', send_count: 0, ...next });
      return next;
    },
    async logEvent(event) {
      const row = { id: `evt_${state.events.length + 1}`, created_at: new Date().toISOString(), ...event };
      state.events.push(row);
      return row;
    },
    async dailyCount(inbox, caller, client, day) {
      const row = state.daily.find((d) => d.inbox === inbox && d.caller === caller && d.client === client && d.day === day);
      return Number(row?.sent_count || 0);
    },
    async incrementDaily(inbox, caller, client, day) {
      const row = state.daily.find((d) => d.inbox === inbox && d.caller === caller && d.client === client && d.day === day);
      if (row) row.sent_count += 1;
      else state.daily.push({ inbox, caller, client, day, sent_count: 1 });
    },
    async dailyMap(caller, client, day) {
      const out = {};
      for (const row of state.daily) {
        if (row.caller === caller && row.client === client && row.day === day) out[row.inbox] = row.sent_count;
      }
      return out;
    },
    async nextRoundRobin(caller, client) {
      const key = `${caller}::${client}`;
      const n = Number(state.rr[key] || 0);
      state.rr[key] = n + 1;
      return n;
    },
    async enqueue(row) {
      state.queue.push({ id: `q_${state.queue.length + 1}`, status: 'queued', created_at: new Date().toISOString(), ...row });
    },
    async isSuppressed(email) {
      return state.suppression.some((s) => s.email === lower(email));
    },
    async campaignLead(email) {
      return state.campaignLeads.find((l) => l.email === lower(email)) || null;
    },
    async hasCallEvent(callId) {
      if (!callId) return false;
      return state.events.some((e) => e.allo_call_id === callId && e.action !== 'voicemail');
    },
    async loadSeeds() {
      return state.seeds;
    },
  };
}

let injected = null;

export function usePostcallStore(store) {
  injected = store;
}

export function getPostcallStore() {
  if (injected) return injected;
  return createSupabaseStore();
}

export function createSupabaseStore() {
  return {
    kind: 'supabase',
    async loadConfigs() {
      const configs = await rest({ path: 'postcall_caller_configs', query: { select: '*' } });
      const templates = await rest({ path: 'postcall_templates', query: { select: '*' } });
      const inboxes = await rest({ path: 'postcall_inboxes', query: { select: '*' } });
      return (configs || []).map((c) => ({
        ...c,
        templates: (templates || []).filter((t) => t.config_id === c.id),
        inboxes: (inboxes || [])
          .filter((i) => i.config_id === c.id)
          .map((i) => ({ ...i, caller: c.caller, client: c.client })),
      }));
    },
    async getContact(caller, client, email) {
      const rows = await rest({
        path: 'postcall_contacts',
        query: { select: '*', caller: `eq.${caller}`, client: `eq.${client}`, email: `eq.${String(email).toLowerCase()}` },
      });
      return rows?.[0] || null;
    },
    async upsertContact(row) {
      const payload = { ...row, email: String(row.email).toLowerCase(), updated_at: new Date().toISOString() };
      const rows = await rest({ path: 'postcall_contacts', method: 'POST', body: payload });
      return Array.isArray(rows) ? rows[0] : rows;
    },
    async logEvent(event) {
      const rows = await rest({ path: 'postcall_events', method: 'POST', body: event });
      return Array.isArray(rows) ? rows[0] : rows;
    },
    async dailyCount(inbox, caller, client, day) {
      const rows = await rest({
        path: 'postcall_inbox_daily',
        query: { select: 'sent_count', inbox: `eq.${inbox}`, caller: `eq.${caller}`, client: `eq.${client}`, day: `eq.${day}` },
      });
      return Number(rows?.[0]?.sent_count || 0);
    },
    async incrementDaily(inbox, caller, client, day) {
      const current = await this.dailyCount(inbox, caller, client, day);
      await rest({
        path: 'postcall_inbox_daily',
        method: 'POST',
        body: { inbox, caller, client, day, sent_count: current + 1 },
      });
    },
    async dailyMap(caller, client, day) {
      const rows = await rest({
        path: 'postcall_inbox_daily',
        query: { select: 'inbox,sent_count', caller: `eq.${caller}`, client: `eq.${client}`, day: `eq.${day}` },
      });
      const out = {};
      for (const row of rows || []) out[row.inbox] = row.sent_count;
      return out;
    },
    async nextRoundRobin(caller, client) {
      const count = await rest({
        path: 'postcall_events',
        query: { select: 'id', caller: `eq.${caller}`, client: `eq.${client}`, action: 'eq.sent' },
      });
      return Array.isArray(count) ? count.length : 0;
    },
    async enqueue(row) {
      await rest({ path: 'postcall_queue', method: 'POST', body: row });
    },
    async isSuppressed(email) {
      const rows = await rest({
        path: 'suppression',
        query: { select: 'email', email: `eq.${String(email).toLowerCase()}`, limit: '1' },
      });
      return Array.isArray(rows) && rows.length > 0;
    },
    async campaignLead(email) {
      const rows = await rest({
        path: 'leads',
        query: { select: 'email,status,category,client_name', email: `eq.${String(email).toLowerCase()}`, limit: '5' },
      });
      if (!rows?.length) return null;
      const replied = rows.some((r) => /replied|interested/i.test(String(r.category || '')));
      const unsub = rows.some((r) => /unsub/i.test(String(r.status || r.category || '')));
      return { ...rows[0], replied, unsubscribed: unsub };
    },
    async hasCallEvent(callId) {
      if (!callId) return false;
      const rows = await rest({
        path: 'postcall_events',
        query: { select: 'id', allo_call_id: `eq.${callId}`, limit: '5' },
      });
      return (rows || []).some((e) => e.action !== 'voicemail') || (rows || []).length > 1;
    },
    async loadSeeds() {
      return rest({ path: 'postcall_seeds', query: { select: '*' } });
    },
  };
}
