/**
 * These endpoints email real prospects, so they are not left open.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
 * CRON_SECRET is set in project env. Manual calls can pass the same value as
 * a bearer token or as ?key=.
 */

import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, reason: 'CRON_SECRET is not set on this deployment' };

  const header = req.headers?.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const query = queryParam(req, 'key');

  if (safeEqual(bearer, secret) || safeEqual(query, secret)) return { ok: true };
  return { ok: false, reason: 'missing or invalid credentials' };
}

export function queryParam(req, name) {
  if (req.query && req.query[name] !== undefined) {
    const v = req.query[name];
    return Array.isArray(v) ? v[0] : String(v);
  }
  try {
    return new URL(req.url, 'http://localhost').searchParams.get(name) || '';
  } catch {
    return '';
  }
}

export function boolParam(req, name) {
  const v = queryParam(req, name);
  return v !== '' && /^(1|true|yes)$/i.test(v);
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
