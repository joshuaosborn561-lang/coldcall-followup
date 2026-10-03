import { boolParam, isAuthorized, queryParam } from '../lib/auth.js';
import { runDailyReport } from '../lib/postcall/report.js';
import { getPostcallStore } from '../lib/postcall/store.js';

export default async function handler(req, res) {
  const auth = isAuthorized(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: `Unauthorized: ${auth.reason}` });

  const dryRun = boolParam(req, 'dry') || req.method === 'GET';
  const day = queryParam(req, 'date') || new Date().toISOString().slice(0, 10);
  try {
    const store = getPostcallStore();
    const events = store.state?.events || [];
    const report = await runDailyReport({ day, dryRun, events });
    return res.status(200).json({ ok: true, ...report });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
