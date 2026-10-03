/**
 * Post-call Smartlead path (multi-caller). Does not touch campaign 3739316.
 *
 *   GET /api/postcall?dry=1&seed=1     Gabe seed preview
 *   POST /api/postcall                 process supplied items or recent VMs
 */

import { boolParam, isAuthorized } from '../lib/auth.js';
import { runPostcall, handleReply } from '../lib/postcall/pipeline.js';
import { getPostcallStore } from '../lib/postcall/store.js';

export default async function handler(req, res) {
  const auth = isAuthorized(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: `Unauthorized: ${auth.reason}` });

  const dryRun = boolParam(req, 'dry') || req.method === 'GET';
  const allowDraft = boolParam(req, 'allowDraft');
  const store = getPostcallStore();

  try {
    if (req.method === 'POST' && req.body?.reply) {
      const out = await handleReply({ ...req.body.reply, dryRun });
      return res.status(200).json({ ok: true, ...out });
    }

    if (boolParam(req, 'seed') || req.body?.seed) {
      const seeds = await store.loadSeeds();
      const items = (seeds || []).map((s) => ({
        caller: s.caller,
        client: s.client,
        email: s.email,
        first_name: s.first_name,
        company_name: s.company_name,
        phone: s.phone,
        person: { lists: [`${listPrefix(s.client)} | Eastern`] },
        call: {
          id: `seed-${s.email}`,
          result: 'VOICEMAIL',
          summary: 'Left a voicemail',
          contact_number: s.phone || '',
          user: { name: s.caller === 'gabe' ? 'Gabe Lopez' : 'Cayden Martini' },
        },
      }));
      const first = await runPostcall({ items, dryRun, allowDraft: true });
      const secondItems = items.map((item, i) => ({
        ...item,
        call: { ...item.call, id: `${item.call.id}-2` },
        _expectThread: first.results[i],
      }));
      const second = await runPostcall({ items: secondItems, dryRun, allowDraft: true });
      return res.status(200).json({
        ok: true,
        dryRun,
        seed: true,
        first: publicResults(first),
        second: publicResults(second),
      });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(200).json({ ok: true, dryRun, counts: { sent: 0, skipped: 0, queued: 0 }, results: [] });
    }
    const out = await runPostcall({ items, dryRun, allowDraft });
    return res.status(200).json(publicResults(out));
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

function listPrefix(client) {
  if (client === 'emcor') return 'EMCOR';
  if (client === 'deep_roots') return 'Deep Roots';
  return 'SalesGlider';
}

function publicResults(out) {
  return {
    ok: out.ok,
    dryRun: out.dryRun,
    counts: out.counts,
    skipReasons: out.skipReasons,
    results: (out.results || []).map((r) => ({
      skipped: r.skipped || false,
      queued: r.queued || false,
      sent: r.sent || false,
      reason: r.reason || null,
      caller: r.caller,
      client: r.client,
      email: r.email,
      inbox: r.inbox,
      sticky: r.sticky,
      kind: r.kind,
      subject: r.subject,
      threadId: r.threadId,
      messageId: r.messageId,
      headers: r.headers,
      sendCount: r.sendCount,
      campaignId: r.campaignId,
      provider: r.provider,
    })),
  };
}
