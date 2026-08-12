import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichMissingEmails } from '../lib/enrich.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('AI Ark is active in the waterfall and uses people search + export/single', async () => {
  const prev = {
    GETLEADS_API_KEY: process.env.GETLEADS_API_KEY,
    AI_ARK_API_KEY: process.env.AI_ARK_API_KEY,
    LEADMAGIC_API_KEY: process.env.LEADMAGIC_API_KEY,
  };
  process.env.GETLEADS_API_KEY = '';
  process.env.LEADMAGIC_API_KEY = '';
  process.env.AI_ARK_API_KEY = 'test-ai-ark-key';

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/v1/people')) {
      return jsonResponse(200, {
        content: [
          {
            id: 'person-1',
            profile: { first_name: 'Amanda', last_name: 'Alvarez' },
            position_groups: [{ company: { name: 'Omega Roofer' } }],
          },
        ],
      });
    }
    if (String(url).endsWith('/v2/people/export/single')) {
      return jsonResponse(200, {
        status: 200,
        error: null,
        data: {
          id: 'person-1',
          email: { value: 'amanda@omegaroofer.com', state: 'DONE' },
          position_groups: [{ company: { name: 'Omega Roofer' } }],
        },
      });
    }
    return jsonResponse(404, { error: 'unexpected' });
  };

  try {
    const record = {
      call: { contact_number: '+15550101010', id: 'call-1' },
      person: { name: 'Amanda', last_name: 'Alvarez', website: 'https://omegaroofer.com' },
      extracted: null,
    };
    const { enriched, stillMissing, warnings, providerCounts } = await enrichMissingEmails([record]);

    assert.equal(stillMissing.length, 0);
    assert.equal(enriched.length, 1);
    assert.equal(enriched[0].email, 'amanda@omegaroofer.com');
    assert.equal(enriched[0].enrichedBy, 'ai_ark');
    assert.equal(providerCounts.ai_ark, 1);
    assert.ok(!warnings.some((w) => /ai_ark.*unverified/i.test(w)));

    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/api\/developer-portal\/v1\/people$/);
    assert.equal(calls[0].headers['X-TOKEN'], 'test-ai-ark-key');
    assert.deepEqual(calls[0].body.account.domain.any.include, ['omegaroofer.com']);
    assert.match(calls[1].url, /\/v2\/people\/export\/single$/);
    assert.deepEqual(calls[1].body, { id: 'person-1' });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('AI Ark accepts BounceBan VALID output[] emails from export/single', async () => {
  const prev = {
    GETLEADS_API_KEY: process.env.GETLEADS_API_KEY,
    AI_ARK_API_KEY: process.env.AI_ARK_API_KEY,
    LEADMAGIC_API_KEY: process.env.LEADMAGIC_API_KEY,
  };
  process.env.GETLEADS_API_KEY = '';
  process.env.LEADMAGIC_API_KEY = '';
  process.env.AI_ARK_API_KEY = 'test-ai-ark-key';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/v1/people')) {
      return jsonResponse(200, { content: [{ id: 'p2', profile: { first_name: 'Pat', last_name: 'West' } }] });
    }
    return jsonResponse(200, {
      data: {
        id: 'p2',
        email: {
          state: 'DONE',
          output: [{ address: 'pwest@cliffhangers.com', status: 'VALID', found: true }],
        },
      },
    });
  };

  try {
    const { enriched } = await enrichMissingEmails([
      {
        call: { contact_number: '+15550101011' },
        person: { name: 'Patrick West', website: 'cliffhangers.com' },
      },
    ]);
    assert.equal(enriched[0]?.email, 'pwest@cliffhangers.com');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
