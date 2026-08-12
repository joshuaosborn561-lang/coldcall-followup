/**
 * Email normalization for Allo CRM / call-extraction / enrichment values.
 *
 * Allo often stores several addresses in one string
 * ("a@x.com,b@y.com") or as a one-element array with that string. Passing the
 * raw value to Smartlead creates invalid leads that never send. This module
 * expands those shapes, keeps only plausible addresses, and prefers the one
 * that best matches the contact's name when several are present.
 */

// Practical, not RFC-perfect: one @, non-empty local, domain with a dot, no spaces.
const EMAIL_RE = /^[A-Za-z0-9._%+'/-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// Common CRM paste typos for real TLDs (gmail.comp, yahoo.cmo, …).
const TYPO_TLDS = new Set(['comp', 'cmo', 'comm', 'coom', 'con', 'ogr', 'nte', 'ediu', 'comn', 'cim']);

/** Split a raw CRM / extractor value into candidate strings. */
export function expandEmailCandidates(raw) {
  if (raw == null) return [];

  const chunks = [];
  const push = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) {
      for (const item of v) push(item);
      return;
    }
    if (typeof v !== 'string') return;
    const trimmed = v.trim();
    if (!trimmed || /^null$/i.test(trimmed)) return;
    // Allo/CSV glue: commas, semicolons, whitespace, or " / " separators.
    for (const part of trimmed.split(/[,;\s|/]+/)) {
      if (part) chunks.push(part.trim());
    }
  };

  push(raw);
  return chunks;
}

/** Lowercase + strip wrappers; return null when it is not a usable address. */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  let email = raw.trim();
  if (!email || /^null$/i.test(email)) return null;

  // <user@host> or mailto:user@host
  email = email.replace(/^mailto:/i, '');
  const angled = email.match(/^<([^>]+)>$/);
  if (angled) email = angled[1].trim();

  email = email.toLowerCase();
  if (!EMAIL_RE.test(email)) return null;

  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  // Reject obvious garbage locals / domains from CRM paste errors.
  if (local.length > 64 || domain.length > 255) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (domain.startsWith('-') || domain.endsWith('-') || domain.includes('..')) return null;

  const tld = domain.split('.').pop();
  if (!tld || tld.length < 2 || TYPO_TLDS.has(tld)) return null;

  return email;
}

/**
 * All valid, unique emails from a raw CRM / extractor field, in order.
 */
export function collectEmails(raw) {
  const seen = new Set();
  const out = [];
  for (const candidate of expandEmailCandidates(raw)) {
    const email = normalizeEmail(candidate);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function localPartScore(email, firstName, lastName) {
  const local = email.split('@')[0] || '';
  const tokens = local.toLowerCase().split(/[._+-]+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let score = 0;
  const first = String(firstName || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const last = String(lastName || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

  if (first && first.length >= 2 && tokens.some((t) => t === first || t.startsWith(first))) score += 3;
  if (last && last.length >= 2 && tokens.some((t) => t === last || t.startsWith(last))) score += 4;
  // Slight preference for shorter, personal-looking locals over role inboxes.
  if (/^(info|admin|office|contact|sales|billing|support|hello|team)$/i.test(tokens[0])) score -= 2;
  return score;
}

/**
 * Pick the best single email for a lead.
 *
 * When the contact's name is known, prefer an address whose local part matches
 * (scott.trcka@… over courtney.dean@… for "Scott Trcka"). Otherwise keep the
 * first valid address in CRM order.
 */
export function pickBestEmail(raw, { firstName = '', lastName = '' } = {}) {
  const emails = collectEmails(raw);
  if (emails.length === 0) return null;
  if (emails.length === 1) return emails[0];

  let best = emails[0];
  let bestScore = localPartScore(best, firstName, lastName);
  for (let i = 1; i < emails.length; i++) {
    const score = localPartScore(emails[i], firstName, lastName);
    if (score > bestScore) {
      best = emails[i];
      bestScore = score;
    }
  }
  return best;
}
