/**
 * Persist verification verdicts so we do not re-enrich or re-verify.
 *
 * Preferred store: Supabase `followup_email_verdicts` (same project as
 * VerifyFall). Also consults `verification_address_results` so a prior
 * waterfall run for the same address is reused.
 *
 * Fallback: JSON file (survives process restarts, not Railway deploys).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const TABLE = 'followup_email_verdicts';

function supabaseEnv() {
  const url = (process.env.SUPABASE_URL || 'https://azpapwtnrbzywlnxxecz.supabase.co').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, key, enabled: Boolean(key) };
}

export function verdictStorePath() {
  return process.env.VERDICT_STORE_PATH || '/tmp/followup-verdicts.json';
}

function emptyStore() {
  return { emails: {}, pendingRuns: [], updatedAt: null };
}

let memory = emptyStore();
let loaded = false;

function norm(email) {
  return String(email || '').trim().toLowerCase();
}

export async function loadVerdicts() {
  if (loaded) return memory;
  try {
    const raw = await readFile(verdictStorePath(), 'utf8');
    const parsed = JSON.parse(raw);
    memory = {
      emails: parsed.emails || {},
      pendingRuns: Array.isArray(parsed.pendingRuns) ? parsed.pendingRuns : [],
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    memory = emptyStore();
  }
  loaded = true;
  return memory;
}

async function saveVerdicts() {
  memory.updatedAt = new Date().toISOString();
  const path = verdictStorePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(memory), 'utf8');
}

async function supabaseHeaders() {
  const { url, key, enabled } = supabaseEnv();
  if (!enabled) return null;
  return {
    url,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  };
}

export function hasSupabaseVerdicts() {
  return supabaseEnv().enabled;
}

/**
 * Look up one address. Order: in-memory/file, followup_email_verdicts,
 * then the latest verification_address_results row.
 */
export async function lookupVerdict(email) {
  const key = norm(email);
  if (!key) return null;
  await loadVerdicts();
  if (memory.emails[key]) return memory.emails[key];

  const sb = await supabaseHeaders();
  if (!sb) return null;

  const local = await sbFetch(
    `${sb.url}/rest/v1/${TABLE}?email=eq.${encodeURIComponent(key)}&select=email,phone,status,run_id,source,lead_payload&limit=1`,
    sb.headers
  );
  if (local?.[0]?.status) {
    const row = toVerdict(local[0]);
    memory.emails[key] = row;
    return row;
  }

  const prior = await sbFetch(
    `${sb.url}/rest/v1/verification_address_results?email=eq.${encodeURIComponent(key)}&select=email,final_disposition,run_id,updated_at&order=updated_at.desc&limit=1`,
    sb.headers
  );
  const disposition = prior?.[0]?.final_disposition;
  if (disposition === 'sendable' || disposition === 'rejected') {
    const row = {
      status: disposition,
      runId: prior[0].run_id || null,
      source: 'verification_address_results',
      phone: null,
      lead: null,
    };
    memory.emails[key] = row;
    await upsertRows([
      { email: key, status: disposition, run_id: row.runId, source: row.source },
    ]);
    return row;
  }
  return null;
}

export async function lookupMany(emails) {
  const out = new Map();
  for (const email of emails) {
    const v = await lookupVerdict(email);
    if (v) out.set(norm(email), v);
  }
  return out;
}

export async function markPending({ emails, runId, leadsByEmail = {} }) {
  await loadVerdicts();
  const now = new Date().toISOString();
  const rows = [];
  for (const raw of emails) {
    const email = norm(raw);
    if (!email) continue;
    const lead = leadsByEmail[email] || null;
    memory.emails[email] = {
      status: 'pending',
      runId,
      source: 'followup',
      phone: lead?.phone_number || lead?.phone || null,
      lead,
      at: now,
    };
    rows.push({
      email,
      phone: memory.emails[email].phone,
      status: 'pending',
      run_id: runId,
      source: 'followup',
      lead_payload: lead,
    });
  }
  if (runId) {
    const existing = memory.pendingRuns.find((r) => r.runId === runId);
    if (existing) existing.emails = [...new Set([...existing.emails, ...emails.map(norm)])];
    else memory.pendingRuns.push({ runId, emails: emails.map(norm).filter(Boolean), at: now });
  }
  await saveVerdicts();
  await upsertRows(rows);
}

export async function markResults({ runId, sendable, rejected }) {
  await loadVerdicts();
  const now = new Date().toISOString();
  const rows = [];

  const apply = (set, status) => {
    for (const raw of set) {
      const email = norm(raw);
      if (!email) continue;
      const prev = memory.emails[email] || {};
      memory.emails[email] = {
        ...prev,
        status,
        runId: runId || prev.runId || null,
        source: 'followup',
        at: now,
      };
      rows.push({
        email,
        phone: memory.emails[email].phone || null,
        status,
        run_id: memory.emails[email].runId,
        source: 'followup',
        lead_payload: prev.lead || null,
      });
    }
  };

  apply(sendable, 'sendable');
  apply(rejected, 'rejected');

  memory.pendingRuns = memory.pendingRuns.filter((r) => r.runId !== runId);
  await saveVerdicts();
  await upsertRows(rows);
}

export async function listPendingRuns() {
  await loadVerdicts();
  return [...memory.pendingRuns];
}

export async function attachLead(email, lead) {
  const key = norm(email);
  if (!key || !lead) return;
  await loadVerdicts();
  if (!memory.emails[key]) memory.emails[key] = { status: 'pending', lead };
  else memory.emails[key].lead = lead;
  if (lead.phone_number) memory.emails[key].phone = lead.phone_number;
  await saveVerdicts();
}

export function getCachedLead(email) {
  return memory.emails[norm(email)]?.lead || null;
}

export async function lookupByPhone(phone) {
  const key = String(phone || '').replace(/\D/g, '');
  if (!key) return null;
  await loadVerdicts();
  for (const row of Object.values(memory.emails)) {
    const digits = String(row.phone || '').replace(/\D/g, '');
    if (digits && (digits === key || digits.endsWith(key.slice(-10)) || key.endsWith(digits.slice(-10)))) {
      return row;
    }
  }
  return null;
}

function toVerdict(row) {
  return {
    status: row.status,
    runId: row.run_id || row.runId || null,
    source: row.source || null,
    phone: row.phone || null,
    lead: row.lead_payload || row.lead || null,
  };
}

async function sbFetch(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return res.json();
}

async function upsertRows(rows) {
  const sb = await supabaseHeaders();
  if (!sb || rows.length === 0) return;
  const payload = rows.map((r) => ({
    email: r.email,
    phone: r.phone ?? null,
    status: r.status,
    run_id: r.run_id ?? null,
    source: r.source ?? 'followup',
    lead_payload: r.lead_payload ?? null,
    updated_at: new Date().toISOString(),
  }));
  await fetch(`${sb.url}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: { ...sb.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
}

/** Test helper. */
export function __resetVerdictsForTests() {
  memory = emptyStore();
  loaded = true;
}
