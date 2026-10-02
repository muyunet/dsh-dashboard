/**
 * External data sources: the greeting API, the DeepSeek account balance, and
 * the official pricing document.
 *
 * Every remote string is untrusted data. The greeting is rendered as text only,
 * never as markup, and the pricing parser keeps numbers and discards the rest.
 *
 * Two transports are available and both are needed:
 *  - `ctx.web.fetch` is the harness's own fetch provider: proxy-aware and
 *    address-guarded, but it takes no request headers and caps the body at
 *    100k characters, so a document whose table sits past that cap is cut off.
 *  - the runtime's global `fetch` sends headers, which the balance endpoint
 *    requires, but knows nothing about a proxy.
 *
 * @module dsh-usage-dashboard/sources
 */

import { DEFAULT_PRICES, DEFAULT_PEAK_WINDOWS, isValidPriceTable, parsePricingPage, PRICING_URL } from './pricing.js';

/** Greeting endpoints, tried in order. */
const GREETING_ENDPOINTS = ['https://v1.hitokoto.cn/?c=d&c=i&c=k&encode=json&charset=utf-8', 'https://international.v1.hitokoto.cn/?c=d&c=i&c=k&encode=json&charset=utf-8'];

/** Longest greeting accepted, in code points. */
const GREETING_MAX_LENGTH = 120;

/** Built-in greetings, used when every endpoint is unreachable. */
const BUILTIN_GREETINGS = [
  { text: '今天也要好好写代码。', from: '内置', fromWho: null },
  { text: '慢就是快，少即是多。', from: '内置', fromWho: null },
  { text: '先让它跑起来，再让它跑得漂亮。', from: '内置', fromWho: null },
  { text: '每一个 bug 都是理解系统的入口。', from: '内置', fromWho: null },
  { text: '清晰胜于聪明。', from: '内置', fromWho: null },
  { text: '把复杂留给自己，把简单留给别人。', from: '内置', fromWho: null },
  { text: '今天的 token，明天的直觉。', from: '内置', fromWho: null },
  { text: '不必一次做对所有事，但要一次做对一件事。', from: '内置', fromWho: null },
  { text: 'Make it work, make it right, make it fast.', from: '内置', fromWho: null },
  { text: 'Simplicity is the soul of efficiency.', from: '内置', fromWho: null },
  { text: 'Talk is cheap. Show me the code.', from: '内置', fromWho: null },
  { text: 'Programs must be written for people to read.', from: '内置', fromWho: null },
  { text: 'The best error message is the one that never shows up.', from: '内置', fromWho: null },
  { text: 'First, solve the problem. Then, write the code.', from: '内置', fromWho: null },
  { text: 'Deleted code is debugged code.', from: '内置', fromWho: null },
  { text: 'Measure. Then optimize.', from: '内置', fromWho: null },
];

/**
 * Retrieve a URL as text, preferring the transport that can carry headers and
 * falling back to the harness provider.
 *
 * @param {string} url - the absolute URL.
 * @param {{ web?: { fetch: (request: { url: string }, signal?: AbortSignal) => Promise<{ statusCode: number, body?: { content?: string }, truncated?: boolean }> }, timeoutMs?: number, signal?: AbortSignal, headers?: Record<string, string> }} [options]
 *   the web service, timeout, cancellation and optional request headers.
 * @returns {Promise<{ ok: boolean, text: string, status: number | null, via: 'direct' | 'web' | null, truncated: boolean, error: string | null }>}
 *   the retrieval outcome. A non-2xx response is a result, not a throw.
 */
export async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const headers = options.headers ?? {};
  const hasHeaders = Object.keys(headers).length > 0;
  const direct = typeof globalThis.fetch === 'function';

  /**
   * Send one request with the runtime's own fetch.
   * @param {Record<string, string>} requestHeaders - headers to send.
   * @returns {Promise<object>} the retrieval outcome.
   */
  const viaDirect = async (requestHeaders) => {
    try {
      const response = await globalThis.fetch(url, { headers: requestHeaders, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      return { ok: response.ok, text, status: response.status, via: 'direct', truncated: false, error: response.ok ? null : `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, text: '', status: null, via: null, truncated: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  // Only the runtime's own fetch can carry headers, so a headers request never
  // falls back to the harness provider: that provider would silently drop the
  // Authorization header and report the resulting 401 as the answer.
  if (hasHeaders) {
    if (!direct) return { ok: false, text: '', status: null, via: null, truncated: false, error: 'no header-capable transport available' };
    return viaDirect(headers);
  }

  if (direct) {
    const attempt = await viaDirect({ accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'user-agent': 'dsh-usage-dashboard/1.0' });
    if (attempt.ok) return attempt;
  }

  const web = options.web;
  if (web !== undefined && web !== null) {
    try {
      const result = await web.fetch({ url }, options.signal);
      const text = result?.body?.content ?? '';
      const status = typeof result?.statusCode === 'number' ? result.statusCode : null;
      const ok = status !== null && status >= 200 && status < 300;
      return { ok, text, status, via: 'web', truncated: result?.truncated === true, error: ok ? null : `HTTP ${status ?? 'unknown'}` };
    } catch (error) {
      return { ok: false, text: '', status: null, via: null, truncated: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { ok: false, text: '', status: null, via: null, truncated: false, error: 'no transport available' };
}

/**
 * Clip a greeting to the accepted length.
 * @param {unknown} value - the raw text.
 * @returns {string} the clipped text.
 */
function clipGreeting(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  return characters.length > GREETING_MAX_LENGTH ? `${characters.slice(0, GREETING_MAX_LENGTH - 1).join('')}…` : text;
}

/**
 * Pick a built-in greeting.
 * @param {number} [seed] - an optional index selector; random when omitted.
 * @returns {{ text: string, from: string, fromWho: string | null, source: 'builtin' }} the greeting.
 */
export function builtinGreeting(seed = Math.floor(Math.random() * BUILTIN_GREETINGS.length)) {
  const entry = BUILTIN_GREETINGS[Math.abs(seed) % BUILTIN_GREETINGS.length];
  return { text: entry.text, from: entry.from, fromWho: entry.fromWho, source: 'builtin' };
}

/**
 * Fetch one greeting from the quote API, falling back to the built-in list.
 * @param {{ web?: object, signal?: AbortSignal }} [options] - the web service and cancellation.
 * @returns {Promise<{ text: string, from: string | null, fromWho: string | null, source: 'hitokoto' | 'fallback-api' | 'builtin', fetchedAt: number }>}
 *   the greeting plus which source produced it.
 */
export async function fetchGreeting(options = {}) {
  for (let index = 0; index < GREETING_ENDPOINTS.length; index += 1) {
    const result = await fetchText(GREETING_ENDPOINTS[index], { web: options.web, signal: options.signal, timeoutMs: 8000 });
    if (!result.ok) continue;
    try {
      const payload = JSON.parse(result.text);
      const text = clipGreeting(payload?.hitokoto);
      if (text === '') continue;
      return {
        text,
        from: typeof payload?.from === 'string' ? payload.from : null,
        fromWho: typeof payload?.from_who === 'string' ? payload.from_who : null,
        source: index === 0 ? 'hitokoto' : 'fallback-api',
        fetchedAt: Date.now(),
      };
    } catch {
      // A malformed payload is a miss, not a failure: try the next endpoint.
    }
  }
  return { ...builtinGreeting(), fetchedAt: Date.now() };
}

/**
 * Add decimal strings without floating-point drift.
 * @param {readonly string[]} values - the decimal strings.
 * @returns {string} the sum formatted to at most two decimals.
 */
export function addDecimals(values) {
  let micro = 0;
  for (const value of values) {
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    micro += Math.round(number * 1e6);
  }
  return (micro / 1e6).toFixed(2);
}

/**
 * Read the account balance.
 *
 * The primary path is the harness account service, which queries the Platform
 * wallets live and needs no key handling. The raw Platform endpoint is a
 * best-effort enrichment that adds `is_available`; it needs an Authorization
 * header, so it can only use the runtime's own fetch.
 *
 * @param {{ account?: { getState: () => Promise<{ status: string, links?: { usageUrl?: string, topUpUrl?: string } }>, getBalance: (client: object) => Promise<object | null>, resolveToken?: (url: string) => Promise<string | undefined> }, web?: object, locale?: string, clientVersion?: string, signal?: AbortSignal }} options
 *   the account service, web service, locale, the client version reported to the Platform, and cancellation.
 * @returns {Promise<object>} the balance view; `available` is false whenever no live figure could be read.
 */
export async function readBalance(options = {}) {
  const checkedAt = Date.now();
  const account = options.account;
  if (account === undefined || account === null) {
    return { available: false, source: 'budget', reason: 'account-service-unavailable', checkedAt };
  }

  let state;
  try {
    state = await account.getState();
  } catch (error) {
    return { available: false, source: 'budget', reason: error instanceof Error ? error.message : String(error), checkedAt };
  }
  const links = { usageUrl: state?.links?.usageUrl ?? null, topUpUrl: state?.links?.topUpUrl ?? null };
  if (state?.status !== 'credential-stored') {
    return { available: false, source: 'budget', reason: 'signed-out', ...links, checkedAt };
  }

  let details = null;
  let accountFailure = null;
  try {
    details = await account.getBalance({
      // `x-client-version` carries this value to the Platform verbatim, so it
      // must be the real running version rather than an invented placeholder.
      version: options.clientVersion ?? 'unknown',
      locale: options.locale ?? 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    });
  } catch (error) {
    accountFailure = error instanceof Error ? error.message : String(error);
  }
  if (details === null) accountFailure ??= 'balance-unavailable';
  else if (details?.status !== 'ready') accountFailure ??= `balance-${details?.status ?? 'unknown'}`;

  if (accountFailure === null) {
    const wallets = Array.isArray(details.value) ? details.value : [];
    const bonusWallets = Array.isArray(details.bonusWallets) ? details.bonusWallets : [];
    const currency = pickCurrency(wallets, bonusWallets);
    const topUp = addDecimals(wallets.filter((wallet) => wallet.currency === currency).map((wallet) => wallet.balance));
    const bonus = addDecimals(bonusWallets.filter((wallet) => wallet.currency === currency).map((wallet) => wallet.balance));
    return {
      available: true,
      currency,
      topUp,
      bonus,
      total: addDecimals([topUp, bonus]),
      isAvailable: null,
      source: 'platform',
      ...links,
      checkedAt,
    };
  }

  // The account service returned nothing usable. dsh reads the wallets from the
  // Platform's `/api/v0/users/get_user_summary` and validates them against
  // `{ normal_wallets, bonus_wallets }`; `readAccountDetail` folds every failure
  // — a network error and a payload that fails that schema alike — into
  // `{ status: 'failed' }`. dsh's own account section shows the same fallback
  // when this happens, so there is no other shipped method to call.
  //
  // What this plugin can do is repeat the very same request and parse it
  // leniently. `resolveToken` issues the stored Platform grant for the inference
  // origin, and that grant is exactly the one dsh sends to the Platform, so this
  // is the same credential over the same endpoint.
  const summary = await readPlatformSummary(account, options, links);
  if (summary.view !== null) return { ...summary.view, ...links, checkedAt };

  const raw = await readRawBalance(account, options);
  if (raw !== null) return { ...raw, ...links, checkedAt };
  return { available: false, source: 'budget', reason: `${accountFailure} (${summary.note})`, ...links, checkedAt };
}

/**
 * Choose which currency to report.
 *
 * An account can carry wallets in both CNY and USD, and the first one in the
 * list is not necessarily the one holding money — reporting the first gave a
 * confident "¥0.00" for an account whose CNY wallet was not empty. The wallet
 * with a non-zero balance wins; ties and all-empty accounts fall back to CNY,
 * the currency this deployment bills in, and only then to whatever is present.
 *
 * @param {Array<{ currency?: string, balance?: string }>} wallets - topped-up wallets.
 * @param {Array<{ currency?: string, balance?: string }>} bonusWallets - granted wallets.
 * @returns {string} the currency to report.
 */
function pickCurrency(wallets, bonusWallets) {
  const totals = new Map();
  for (const wallet of [...wallets, ...bonusWallets]) {
    const currency = typeof wallet?.currency === 'string' ? wallet.currency : null;
    if (currency === null) continue;
    const amount = Number(wallet.balance);
    totals.set(currency, (totals.get(currency) ?? 0) + (Number.isFinite(amount) ? amount : 0));
  }
  for (const [currency, amount] of totals) if (amount > 0) return currency;
  if (totals.has('CNY')) return 'CNY';
  return totals.keys().next().value ?? 'CNY';
}

/**
 * Turn a wallet list into the balance view.
 *
 * @param {object} payload - the Platform summary.
 * @returns {object | null} the view, or `null` when no wallet could be read.
 */
function walletsToView(payload) {
  const wallets = collectWallets(payload);
  if (wallets.length === 0) return null;
  const currency = pickCurrency(
    wallets.filter((wallet) => wallet.kind !== 'bonus'),
    wallets.filter((wallet) => wallet.kind === 'bonus'),
  );
  const pick = (kind) =>
    addDecimals(
      wallets
        .filter((wallet) => wallet.kind === kind && wallet.currency === currency)
        .map((wallet) => wallet.balance),
    );
  const topUp = pick('normal');
  const bonus = pick('bonus');
  return {
    available: true,
    currency,
    topUp,
    bonus,
    total: addDecimals([topUp, bonus]),
    isAvailable: payload?.is_available === true,
    source: 'platform-summary',
  };
}

/**
 * Collect every `{ currency, balance }` pair a Platform payload carries.
 *
 * The strict shipped schema only accepts `normal_wallets` and `bonus_wallets`,
 * so a payload shaped differently is rejected outright. This walks whatever
 * actually arrived and labels each wallet by the key that held it, which is both
 * how the balance survives a shape dsh refuses and how the reason below can name
 * the keys that did come back.
 *
 * @param {unknown} payload - the parsed response body.
 * @returns {Array<{ kind: string, currency: string, balance: string }>} the wallets found.
 */
function collectWallets(payload) {
  if (payload === null || typeof payload !== 'object') return [];
  const found = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.balance !== 'string' || typeof entry.currency !== 'string') continue;
      found.push({
        // Anything that is not clearly a grant counts as the topped-up balance:
        // that is what the primary wallet holds, and a payload dsh refused gives
        // no second chance to guess from a schema.
        kind: /bonus|grant/i.test(key) ? 'bonus' : 'normal',
        currency: entry.currency,
        balance: entry.balance,
      });
    }
  }
  return found;
}

/**
 * Build the client identity headers dsh sends to the Platform.
 *
 * Mirrors `platformClientHeaders`: the bundle ID is intentionally empty, and the
 * locale is the region-tagged Platform spelling.
 *
 * @param {{ clientVersion?: string, locale?: string }} options - identity to report.
 * @returns {Record<string, string>} the headers.
 */
function clientHeaders(options) {
  return {
    accept: 'application/json',
    'x-client-bundle-id': '',
    'x-client-platform': 'web',
    'x-client-version': options.clientVersion ?? 'unknown',
    'x-client-locale': (options.locale ?? 'zh-CN').replace('-', '_'),
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
}

/**
 * Repeat the Platform's own summary request and read it leniently.
 *
 * @param {object} account - the account service.
 * @param {{ signal?: AbortSignal, clientVersion?: string, locale?: string }} options - identity and cancellation.
 * @param {{ usageUrl: string | null }} links - the Platform links, whose origin is the endpoint's.
 * @returns {Promise<{ view: object | null, note: string }>} the view when readable, plus what happened either way.
 */
async function readPlatformSummary(account, options, links) {
  try {
    if (typeof links?.usageUrl !== 'string') return { view: null, note: 'no platform origin' };
    const origin = new URL(links.usageUrl).origin;
    const token = await account.resolveToken?.('https://api.deepseek.com');
    if (typeof token !== 'string' || token === '') return { view: null, note: 'no token for the inference origin' };
    const response = await fetchText(`${origin}/api/v0/users/get_user_summary`, {
      headers: {
        // The Platform does not take a bearer token: dsh's own `accountHeaders`
        // sends the grant as `x-dsh-auth-token`, and a request with the
        // Authorization header instead is rejected even when the network works.
        ...clientHeaders(options),
        'x-dsh-auth-token': token,
      },
      timeoutMs: 10000,
      signal: options.signal,
    });
    // `fetchText` reports a transport failure as a result rather than a throw,
    // so its own message is the only thing that distinguishes "unreachable" from
    // "the Platform answered with an error".
    if (!response.ok) return { view: null, note: response.error ?? `summary HTTP ${String(response.status)}` };
    const payload = JSON.parse(response.text);
    const view = walletsToView(payload);
    if (view !== null) return { view, note: 'ok' };
    // Naming the keys that did arrive is what turns "it failed" into a fixable
    // report: dsh's own schema only accepts normal_wallets and bonus_wallets.
    const keys = payload !== null && typeof payload === 'object' ? Object.keys(payload).join(',') : typeof payload;
    return { view: null, note: `summary keys: ${keys}` };
  } catch (error) {
    return { view: null, note: `summary ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Read the wallets from the public API balance endpoint.
 *
 * A second independent path: a different URL and a different payload shape,
 * authenticated with the same stored grant.
 *
 * @param {object} account - the account service.
 * @param {{ signal?: AbortSignal }} options - cancellation.
 * @returns {Promise<object | null>} the balance view, or `null` when unavailable.
 */
async function readRawBalance(account, options) {
  try {
    const token = await account.resolveToken?.('https://api.deepseek.com');
    if (typeof token !== 'string' || token === '') return null;
    const response = await fetchText('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      timeoutMs: 10000,
      signal: options.signal,
    });
    if (!response.ok) return null;
    const payload = JSON.parse(response.text);
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    if (infos.length === 0) return null;
    const info = infos.find((entry) => entry?.currency === 'CNY') ?? infos[0];
    const currency = typeof info?.currency === 'string' ? info.currency : 'CNY';
    const total = typeof info?.total_balance === 'string' ? info.total_balance : '0.00';
    return {
      available: true,
      currency,
      topUp: typeof info?.topped_up_balance === 'string' ? info.topped_up_balance : '0.00',
      bonus: typeof info?.granted_balance === 'string' ? info.granted_balance : '0.00',
      total,
      isAvailable: payload?.is_available === true,
      source: 'platform-raw',
    };
  } catch {
    return null;
  }
}

/**
 * Read the official pricing document and parse it.
 *
 * A document that cannot be read, is truncated before its table, or fails the
 * structural check is discarded entirely and the caller keeps what it had: a
 * wrong price is worse than a stale one.
 *
 * @param {{ web?: object, url?: string, builtin?: Record<string, unknown>, signal?: AbortSignal }} [options] - the web service, document URL, current table and cancellation.
 * @returns {Promise<{ table: Record<string, unknown>, peakWindows: Array<{ start: string, end: string }>, source: 'live' | 'builtin', fetchedAt: number | null, via: string | null, warning: { kind: 'unreachable' | 'truncated' | 'invalid', detail: string | null } | null }>}
 *   the pricing plus which source produced it.
 */
export async function readPricing(options = {}) {
  const url = options.url ?? PRICING_URL;
  const builtin = options.builtin ?? DEFAULT_PRICES;

  const attempt = await fetchText(url, { web: options.web, timeoutMs: 20000, signal: options.signal });
  if (attempt.ok) {
    const parsed = parsePricingPage(attempt.text);
    if (parsed !== null) {
      return { table: parsed.table, peakWindows: parsed.peakWindows, source: 'live', fetchedAt: Date.now(), via: attempt.via, warning: null };
    }
  }

  // A structured reason rather than a sentence: the client renders it in the
  // active language, and keeps the raw transport text as the hover detail so the
  // technical cause is still reachable without being the whole message.
  const reason = attempt.ok
    ? attempt.truncated
      ? { kind: 'truncated', detail: null }
      : { kind: 'invalid', detail: null }
    : { kind: 'unreachable', detail: attempt.error ?? null };
  return {
    table: isValidPriceTable(builtin) ? builtin : DEFAULT_PRICES,
    peakWindows: DEFAULT_PEAK_WINDOWS,
    source: 'builtin',
    fetchedAt: null,
    via: attempt.via,
    warning: reason,
  };
}
