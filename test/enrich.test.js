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

const SAMPLE = {
  call: { contact_number: '+15550101010', id: 'call-1' },
  person: { name: 'Amanda', last_name: 'Alvarez', website: 'https://omegaroofer.com' },
  extracted: null,
};

async function withEnrichEnv(overrides, fn) {
  const keys = ['GETLEADS_API_KEY', 'AI_ARK_API_KEY', 'LEADMAGIC_API_KEY', 'ENRICH_ALLOW_UNVERIFIED'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = '';
  Object.assign(process.env, overrides);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('AI Ark is active in the waterfall and uses people search + export/single', async () => {
  await withEnrichEnv({ AI_ARK_API_KEY: 'test-ai-ark-key' }, async () => {
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
      const { enriched, stillMissing, warnings, providerCounts } = await enrichMissingEmails([SAMPLE]);

      assert.equal(stillMissing.length, 0);
      assert.equal(enriched.length, 1);
      assert.equal(enriched[0].email, 'amanda@omegaroofer.com');
      assert.equal(enriched[0].enrichedBy, 'ai_ark');
      assert.equal(providerCounts.ai_ark, 1);
      assert.equal(providerCounts.leadmagic, undefined);
      assert.ok(!warnings.some((w) => /ai_ark.*unverified/i.test(w)));

      assert.equal(calls.length, 2);
      assert.match(calls[0].url, /\/api\/developer-portal\/v1\/people$/);
      assert.equal(calls[0].headers['X-TOKEN'], 'test-ai-ark-key');
      assert.deepEqual(calls[0].body.account.domain.any.include, ['omegaroofer.com']);
      assert.match(calls[1].url, /\/v2\/people\/export\/single$/);
      assert.deepEqual(calls[1].body, { id: 'person-1' });
      assert.ok(calls.every((c) => !/leadmagic/i.test(c.url)));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('AI Ark accepts BounceBan VALID output[] emails from export/single', async () => {
  await withEnrichEnv({ AI_ARK_API_KEY: 'test-ai-ark-key' }, async () => {
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
    }
  });
});

test('getleads miss falls through to AI Ark and never calls LeadMagic', async () => {
  await withEnrichEnv(
    {
      GETLEADS_API_KEY: 'test-getleads-key',
      AI_ARK_API_KEY: 'test-ai-ark-key',
      LEADMAGIC_API_KEY: 'stale-leadmagic-key',
    },
    async () => {
      const calls = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
        if (String(url).includes('getleads.io')) {
          return jsonResponse(200, { contacts: [] });
        }
        if (String(url).endsWith('/v1/people')) {
          return jsonResponse(200, {
            content: [{ id: 'person-1', profile: { first_name: 'Amanda', last_name: 'Alvarez' } }],
          });
        }
        if (String(url).endsWith('/v2/people/export/single')) {
          return jsonResponse(200, {
            data: { id: 'person-1', email: { value: 'amanda@omegaroofer.com', state: 'DONE' } },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      };

      try {
        const { enriched, stillMissing, providerCounts } = await enrichMissingEmails([SAMPLE]);
        assert.equal(stillMissing.length, 0);
        assert.equal(enriched[0]?.enrichedBy, 'ai_ark');
        assert.equal(providerCounts.getleads, undefined);
        assert.equal(providerCounts.ai_ark, 1);
        assert.equal(providerCounts.leadmagic, undefined);
        assert.ok(calls.some((c) => c.url.includes('getleads.io')));
        assert.ok(calls.some((c) => c.url.includes('ai-ark.com')));
        assert.ok(calls.every((c) => !/leadmagic/i.test(c.url)));
        assert.ok(calls.every((c) => !/X-API-Key/i.test(JSON.stringify(c.headers))));
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test('getleads hit stops the waterfall before AI Ark', async () => {
  await withEnrichEnv(
    {
      GETLEADS_API_KEY: 'test-getleads-key',
      AI_ARK_API_KEY: 'test-ai-ark-key',
      LEADMAGIC_API_KEY: 'stale-leadmagic-key',
    },
    async () => {
      const calls = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), headers: init.headers || {} });
        if (String(url).includes('getleads.io')) {
          return jsonResponse(200, {
            contacts: [
              {
                email_address: 'amanda@omegaroofer.com',
                email_status: 'VALID',
                org_company_name: 'Omega Roofer',
              },
            ],
          });
        }
        throw new Error(`waterfall should have stopped before ${url}`);
      };

      try {
        const { enriched, providerCounts } = await enrichMissingEmails([SAMPLE]);
        assert.equal(enriched[0]?.email, 'amanda@omegaroofer.com');
        assert.equal(enriched[0]?.enrichedBy, 'getleads');
        assert.equal(enriched[0]?.enrichedCompany, 'Omega Roofer');
        assert.deepEqual(providerCounts, { getleads: 1 });
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.includes('getleads.io'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test('both providers missing leaves the lead unenriched and never calls LeadMagic', async () => {
  await withEnrichEnv(
    {
      GETLEADS_API_KEY: 'test-getleads-key',
      AI_ARK_API_KEY: 'test-ai-ark-key',
      LEADMAGIC_API_KEY: 'stale-leadmagic-key',
    },
    async () => {
      const calls = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        if (String(url).includes('getleads.io')) return jsonResponse(200, { contacts: [] });
        if (String(url).endsWith('/v1/people')) return jsonResponse(200, { content: [] });
        throw new Error(`unexpected fetch: ${url}`);
      };

      try {
        const { enriched, stillMissing, providerCounts } = await enrichMissingEmails([SAMPLE]);
        assert.equal(enriched.length, 0);
        assert.equal(stillMissing.length, 1);
        assert.deepEqual(providerCounts, {});
        assert.ok(calls.every((url) => !/leadmagic/i.test(url)));
        assert.equal(calls.filter((url) => url.includes('getleads.io')).length, 1);
        assert.equal(calls.filter((url) => url.includes('/v1/people')).length, 1);
        assert.equal(calls.filter((url) => url.includes('export/single')).length, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test('no configured providers warns without mentioning LeadMagic', async () => {
  await withEnrichEnv({ LEADMAGIC_API_KEY: 'stale-leadmagic-key' }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      throw new Error(`no provider should fetch ${url}`);
    };
    try {
      const { enriched, stillMissing, warnings, providerCounts } = await enrichMissingEmails([SAMPLE]);
      assert.equal(enriched.length, 0);
      assert.equal(stillMissing.length, 1);
      assert.deepEqual(providerCounts, {});
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /GETLEADS_API_KEY \/ AI_ARK_API_KEY/);
      assert.doesNotMatch(warnings[0], /LEADMAGIC|LeadMagic|leadmagic/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
