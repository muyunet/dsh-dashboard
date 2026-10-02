/**
 * Balance reading checks.
 *
 * dsh reads the Platform wallets from `/api/v0/users/get_user_summary` and
 * validates the payload against `{ normal_wallets, bonus_wallets }`. Its own
 * `readAccountDetail` folds *every* failure — a network error and a payload that
 * fails that schema alike — into `{ status: 'failed' }`, and its account section
 * renders "View on Platform" when that happens. So `getBalance()` failing is not
 * by itself evidence of anything, and it is not the only way to read the
 * wallets: the same grant, over the same endpoint, can be parsed leniently.
 *
 * These checks drive `readBalance` end to end against a stubbed fetch, because
 * the whole point of the fallback is what it does with a payload dsh refuses.
 */

import assert from 'node:assert/strict';

import { readBalance } from '../lib/sources.js';

let passed = 0;

/**
 * Run one named check.
 * @param {string} name - the check name.
 * @param {() => Promise<void>} body - the check body.
 * @returns {Promise<void>} resolves once the check ran.
 */
async function test(name, body) {
  await body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** The Platform links the account state advertises. */
const LINKS = { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' };

/**
 * An account service whose balance read always fails, the way the live one does.
 * @param {object} [overrides] - replacements for the default members.
 * @returns {object} the stub.
 */
function failingAccount(overrides = {}) {
  return {
    /** @returns {Promise<object>} the signed-in state. */
    getState: async () => ({ status: 'credential-stored', links: LINKS }),
    /** @returns {Promise<object>} a failed wallet read. */
    getBalance: async () => ({ status: 'failed' }),
    /** @param {string} url - the destination. @returns {Promise<string>} a grant for the inference origin. */
    resolveToken: async (url) => (url === 'https://api.deepseek.com' ? 'grant-token' : undefined),
    ...overrides,
  };
}

/**
 * Install a fetch stub answering by URL.
 * @param {Record<string, { status?: number, body?: unknown }>} routes - responses by URL.
 * @returns {{ calls: string[], headers: Record<string, Record<string, string>> }} what was requested.
 */
function stubFetch(routes) {
  const calls = [];
  const headers = {};
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    headers[String(url)] = (init && init.headers) || {};
    const route = routes[String(url)];
    if (route === undefined) return { ok: false, status: 404, text: async () => '' };
    const status = route.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(route.body ?? {}) };
  };
  return { calls, headers };
}

console.log('balance');

await test('the wallet holding money wins over the first one listed', async () => {
  // A live account carried a USD wallet first and its CNY balance second, and
  // reporting the first produced a confident "$0.00" for an account that was not
  // empty.
  const account = failingAccount({
    getBalance: async () => ({
      status: 'ready',
      value: [
        { currency: 'USD', balance: '0.00' },
        { currency: 'CNY', balance: '63.50' },
      ],
      bonusWallets: [],
    }),
  });
  const result = await readBalance({ account });
  assert.equal(result.available, true);
  assert.equal(result.currency, 'CNY', 'the non-empty wallet must win');
  assert.equal(result.total, '63.50');
});

await test('an all-empty account falls back to the billing currency', async () => {
  const account = failingAccount({
    getBalance: async () => ({
      status: 'ready',
      value: [
        { currency: 'USD', balance: '0.00' },
        { currency: 'CNY', balance: '0.00' },
      ],
      bonusWallets: [],
    }),
  });
  const result = await readBalance({ account });
  assert.equal(result.currency, 'CNY');
  assert.equal(result.total, '0.00');
});

await test('a live account reading is used as-is', async () => {
  const account = failingAccount({
    getBalance: async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '10.00' }],
      bonusWallets: [{ currency: 'CNY', balance: '2.50' }],
    }),
  });
  const result = await readBalance({ account });
  assert.equal(result.available, true);
  assert.equal(result.source, 'platform');
  assert.equal(result.total, '12.50');
  assert.equal(result.topUp, '10.00');
  assert.equal(result.bonus, '2.50');
});

await test('the shipped-shaped summary is read when the service fails', async () => {
  stubFetch({
    'https://platform.deepseek.com/api/v0/users/get_user_summary': {
      body: {
        normal_wallets: [{ currency: 'CNY', balance: '7.25' }],
        bonus_wallets: [{ currency: 'CNY', balance: '0.75' }],
      },
    },
  });
  const result = await readBalance({ account: failingAccount(), clientVersion: '0.2.0-rc.2' });
  assert.equal(result.available, true, `expected a reading, got ${JSON.stringify(result)}`);
  assert.equal(result.source, 'platform-summary');
  assert.equal(result.total, '8.00');
  assert.equal(result.usageUrl, LINKS.usageUrl);
});

await test('a summary dsh would reject is still read', async () => {
  // This is the case that matters: the strict schema only accepts
  // `normal_wallets`/`bonus_wallets`, so any other key makes `getBalance()`
  // report failure. The wallets are still in the payload.
  stubFetch({
    'https://platform.deepseek.com/api/v0/users/get_user_summary': {
      body: { wallets: [{ currency: 'CNY', balance: '42.00' }], granted_wallets: [{ currency: 'CNY', balance: '8.00' }] },
    },
  });
  const result = await readBalance({ account: failingAccount() });
  assert.equal(result.available, true, `expected a reading, got ${JSON.stringify(result)}`);
  assert.equal(result.total, '50.00');
  assert.equal(result.topUp, '42.00');
  assert.equal(result.bonus, '8.00');
});

await test('a wallet in another currency does not leak into the total', async () => {
  stubFetch({
    'https://platform.deepseek.com/api/v0/users/get_user_summary': {
      body: {
        normal_wallets: [
          { currency: 'CNY', balance: '5.00' },
          { currency: 'USD', balance: '99.00' },
        ],
        bonus_wallets: [],
      },
    },
  });
  const result = await readBalance({ account: failingAccount() });
  assert.equal(result.available, true);
  assert.equal(result.currency, 'CNY');
  assert.equal(result.total, '5.00');
});

await test('every path failing reports why, and names the keys that arrived', async () => {
  stubFetch({
    'https://platform.deepseek.com/api/v0/users/get_user_summary': { body: { code: 0, data: { nothing: true } } },
  });
  const result = await readBalance({ account: failingAccount() });
  assert.equal(result.available, false);
  assert.equal(result.source, 'budget');
  assert.ok(result.reason.includes('balance-failed'), `the account failure must survive: ${result.reason}`);
  assert.ok(result.reason.includes('code,data'), `the reason must name the payload keys: ${result.reason}`);
});

await test('an unreachable platform is reported as unreachable, not as a bad payload', async () => {
  globalThis.fetch = async () => {
    throw new Error('fetch failed');
  };
  const result = await readBalance({ account: failingAccount() });
  assert.equal(result.available, false);
  assert.ok(result.reason.includes('fetch failed'), `the transport failure must survive: ${result.reason}`);
});

await test('the platform grant travels in x-dsh-auth-token, not Authorization', async () => {
  // dsh's own `accountHeaders` sends the grant as `x-dsh-auth-token`. A bearer
  // header is the *API* spelling, and the Platform rejects it — so a fallback
  // that used Authorization would fail even on a working network.
  const { headers } = stubFetch({});
  await readBalance({ account: failingAccount(), clientVersion: '0.2.0-rc.2' });
  const sent = headers['https://platform.deepseek.com/api/v0/users/get_user_summary'];
  assert.notEqual(sent, undefined, 'the summary request must be sent');
  assert.equal(sent['x-dsh-auth-token'], 'grant-token');
  assert.equal(sent.authorization, undefined, 'the Platform must not receive an Authorization header');
  assert.equal(sent['x-client-version'], '0.2.0-rc.2');
  assert.equal(sent['x-client-platform'], 'web');
});

await test('the public API path still uses the bearer spelling', async () => {
  // The other endpoint is the API, where Authorization is correct.
  const { headers } = stubFetch({});
  await readBalance({ account: failingAccount() });
  const sent = headers['https://api.deepseek.com/user/balance'];
  assert.notEqual(sent, undefined, 'the API request must be sent');
  assert.equal(sent.authorization, 'Bearer grant-token');
  assert.equal(sent['x-dsh-auth-token'], undefined, 'the API must not receive the Platform header');
});

await test('the platform token is requested for the inference origin only', async () => {
  // `resolveToken` refuses any destination but the inference origin, so a
  // request for the Platform origin would silently yield no token at all. Both
  // fallbacks therefore ask for the inference origin and use the grant there.
  const asked = [];
  const account = failingAccount({
    /** @param {string} url - the destination. @returns {Promise<string>} the grant. */
    resolveToken: async (url) => {
      asked.push(url);
      return 'grant-token';
    },
  });
  stubFetch({});
  await readBalance({ account });
  assert.ok(asked.length > 0, 'a token must be requested');
  assert.ok(
    asked.every((url) => url === 'https://api.deepseek.com'),
    `only the inference origin may be asked, saw ${JSON.stringify(asked)}`,
  );
});

await test('a signed-out account never reaches the network', async () => {
  const { calls } = stubFetch({});
  const account = failingAccount({ getState: async () => ({ status: 'signed-out', links: LINKS }) });
  const result = await readBalance({ account });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'signed-out');
  assert.deepEqual(calls, [], 'no request may be sent while signed out');
});

await test('a missing account service is reported, not thrown', async () => {
  const result = await readBalance({ account: null });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'account-service-unavailable');
});

console.log(`\n${passed} checks passed`);
