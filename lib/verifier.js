/**
 * Client for Josh's email-verification-waterfall (VerifyFall).
 *
 * Production: https://verifyfall-production.up.railway.app
 *   POST /api/upload          multipart CSV -> { runs: [{ run_id, status }] }
 *   GET  /api/runs/:id        status + counts
 *   GET  /api/runs/:id/results signed SENDABLE / REJECTED CSV URLs
 *   POST /api/runs/:id/resume resume a stalled run (do not start fresh)
 *
 * SENDABLE = MillionVerifier ok + No2Bounce-confirmed catch_all/unknown.
 * SEG and OTHER splits are both sendable for this campaign.
 */

export const DEFAULT_VERIFYFALL_URL = 'https://verifyfall-production.up.railway.app';

export function verifierBase() {
  return String(process.env.VERIFYFALL_URL || DEFAULT_VERIFYFALL_URL).replace(/\/$/, '');
}

export class VerifierError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'VerifierError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { method = 'GET', body, headers } = {}, { retries = 3 } = {}) {
  const url = verifierBase() + path;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers, body });
    } catch (cause) {
      lastError = new VerifierError(`Network error calling verifier ${path}: ${cause.message}`);
      if (attempt < retries) {
        await sleep(Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      throw lastError;
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 400) };
    }

    if (res.ok || res.status === 202) return parsed;

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const waitS = Number(res.headers.get('retry-after') || 0);
      await sleep(waitS > 0 ? waitS * 1000 : Math.min(8000, 500 * 2 ** attempt));
      continue;
    }

    throw new VerifierError(
      `Verifier ${res.status} on ${path}: ${parsed.error || text.slice(0, 300)}`,
      { status: res.status, body: parsed }
    );
  }
  throw lastError;
}

export async function verifierHealth() {
  return request('/api/health', {}, { retries: 1 });
}

/** Build a one-column CSV the waterfall accepts. */
export function emailsToCsv(emails) {
  const lines = ['Email'];
  const seen = new Set();
  for (const raw of emails) {
    const email = String(raw || '').trim().toLowerCase();
    if (!email || !email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    lines.push(email);
  }
  return { csv: `${lines.join('\n')}\n`, count: seen.size };
}

export async function startVerificationUpload({ emails, segmentName }) {
  const { csv, count } = emailsToCsv(emails);
  if (count === 0) return { runId: null, count: 0 };

  const form = new FormData();
  form.append('files', new Blob([csv], { type: 'text/csv' }), `${segmentName || 'followup'}.csv`);
  if (segmentName) form.append('segment_name', segmentName);

  const parsed = await request('/api/upload', { method: 'POST', body: form }, { retries: 2 });
  const run = parsed?.runs?.[0];
  if (!run?.run_id) {
    throw new VerifierError('Verifier upload did not return a run_id', { body: parsed });
  }
  return { runId: run.run_id, status: run.status, count, segmentName: run.segment_name };
}

export async function getVerifierRun(runId) {
  return request(`/api/runs/${encodeURIComponent(runId)}`);
}

export async function resumeVerifierRun(runId) {
  return request(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function getVerifierResults(runId) {
  return request(`/api/runs/${encodeURIComponent(runId)}/results`);
}

/** Pull Email values out of a SENDABLE/REJECTED CSV. */
export function parseEmailCsv(text) {
  const emails = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return emails;

  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  let emailIdx = header.findIndex((h) => h === 'email' || h === 'e-mail' || h === 'email_address');
  if (emailIdx < 0) emailIdx = 0;

  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const email = String(cols[emailIdx] || '').trim().replace(/^"|"$/g, '').toLowerCase();
    if (!email || !email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export async function downloadResultEmails(url) {
  if (!url) return [];
  const res = await fetch(url);
  if (!res.ok) {
    throw new VerifierError(`Failed to download verifier CSV (${res.status})`);
  }
  return parseEmailCsv(await res.text());
}

/**
 * Apply a completed (or partial) results payload to sendable/rejected sets.
 * SEG + OTHER both count as sendable.
 */
export async function collectResultSets(resultsPayload) {
  const downloads = resultsPayload?.downloads || resultsPayload || {};
  const sendableUrl = downloads.sendable_url || downloads.sendable;
  const rejectedUrl = downloads.rejected_url || downloads.rejected;
  const [sendable, rejected] = await Promise.all([
    downloadResultEmails(sendableUrl),
    downloadResultEmails(rejectedUrl),
  ]);
  return {
    sendable: new Set(sendable),
    rejected: new Set(rejected),
    credits: {
      mv: Number(resultsPayload?.run?.mv_credits_used ?? resultsPayload?.mv_credits_used ?? 0),
      n2b: Number(resultsPayload?.run?.n2b_credits_used ?? resultsPayload?.n2b_credits_used ?? 0),
    },
    status: resultsPayload?.run?.status || resultsPayload?.status || null,
    partial: Boolean(resultsPayload?.partial),
  };
}
