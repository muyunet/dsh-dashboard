/**
 * Host half of the usage dashboard.
 *
 * It owns three things the browser cannot reach on its own: the usage ledger
 * folded from session logs, the live account balance, and the official pricing
 * document. All three are published as one JSON document over a single
 * loopback route that the client half polls.
 *
 * @module @muyunet/dsh-dashboard
 */

import fs from 'node:fs';
import path from 'node:path';

// Inlined rather than declared: a workspace bundle cannot resolve a package
// that ships inside dsh's own archive, and a git-installed dependency would land
// in a layout this loader's resolver does not follow. See vendor/README.md.
import z from './vendor/schemastery/index.mjs';
import { isVolatile } from './vendor/cosmokit/index.js';

import { Ledger, dshHome, periodKeys, seriesDates } from './lib/ledger.js';
import {
  DEFAULT_PEAK_WINDOWS,
  PRICING_URL,
  beijingParts,
  bucketAt,
  nextSwitchAt,
  resolvePricingConfig,
} from './lib/pricing.js';
import { fetchGreeting, readBalance, readPricing } from './lib/sources.js';

/** Route the client half reads. */
const SNAPSHOT_PATH = '/usage-dashboard/snapshot';

/** How long a built snapshot is reused, so polling does not re-price the ledger. */
const SNAPSHOT_TTL_MS = 10000;

/** How long a balance reading is reused. */
const BALANCE_TTL_MS = 60000;

/**
 * How soon a *failed* balance read is retried.
 *
 * The Platform is intermittently unreachable; retrying on the configured
 * interval would keep a stale failure on screen for a minute after a blip.
 */
const BALANCE_RETRY_MS = 15000;

/** Delay before the session-log backfill runs, keeping activation fast. */
const BACKFILL_DELAY_MS = 1200;

/**
 * The row's configuration, as the Plugin Manager renders and validates it.
 *
 * Every field declares the same default `resolveConfig` falls back to, so an
 * empty or absent `config` validates to exactly the built-in behaviour and this
 * schema cannot fail an activation. Unknown keys are preserved by schemastery,
 * which is what lets `prices` and `peakWindows` stay patch-editable without
 * being modelled here — modelling the price table would mean re-declaring the
 * whole official rate card in two places and letting them drift apart.
 *
 * `volatile()` is what makes these fields editable at all. dsh builds a settings
 * page only from fields a schema marks volatile — `volatileForm` walks the node
 * tree and returns nothing when no leaf has it — so a plain schema validates
 * perfectly and still renders no configuration anywhere. A volatile field also
 * parses into a live reference rather than a plain value, which is why
 * `resolveConfig` unwraps before reading; see {@link plain}.
 */
export const Config = z.object({
  budgetTotal: z
    .number()
    .min(0)
    .default(0)
    .volatile()
    .description('预算总额（元）。0 表示不使用预算模式，此时「剩余」只在能读到账户余额时显示'),
  baselineCost: z
    .number()
    .min(0)
    .default(0)
    .volatile()
    .description('安装本插件之前已经花掉的钱（元）。预算模式下会加到已用金额里，用来估算剩余'),
  currencySymbol: z.string().default('¥').volatile().description('金额前缀符号，例如 ¥ 或 $'),
  currency: z.string().default('CNY').volatile().description('币种代码，用于匹配平台钱包（CNY / USD）'),
  balanceRefreshSeconds: z
    .number()
    .min(30)
    .default(60)
    .volatile()
    .description('余额刷新间隔（秒，最小 30）。余额接口读不到时会在每次轮询重试'),
  fallbackModel: z
    .string()
    .default('deepseek-flash')
    .volatile()
    .description('会话日志里认不出模型名时，按哪个模型的价格计算'),
  holidays: z
    .array(z.string())
    .default([])
    .volatile()
    .description('中国法定节假日，格式 YYYY-MM-DD。填了之后峰谷判定会排除这些日期；留空则只按周一至周五判断'),
  refreshHours: z
    .number()
    .min(1)
    .default(12)
    .volatile()
    .description('从官方价格文档重新抓取价格的间隔（小时）'),
  pricingUrl: z.string().default(PRICING_URL).volatile().description('官方价格文档地址'),
});

/**
 * Detach a parsed config value from its live references.
 *
 * A `volatile()` field parses into `{ get, [write] }` rather than the value
 * itself. Without this, `Number.isFinite(config.budgetTotal)` would be false for
 * every field the settings page writes, and the plugin would silently fall back
 * to its defaults — a form that saves and appears to do nothing.
 *
 * @param {unknown} value - a parsed config value, or any part of one.
 * @returns {unknown} the same value with every reference replaced by its snapshot.
 */
function plain(value) {
  if (isVolatile(value)) return plain(value.get());
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
  }
  return value;
}

/**
 * Resolve the row's configuration over the built-in defaults.
 * @param {Record<string, unknown>} raw - the row's `config` object.
 * @returns {object} the resolved configuration.
 */
function resolveConfig(raw) {
  const config = plain(raw !== null && typeof raw === 'object' ? raw : {});
  const pricing = resolvePricingConfig(config);
  return {
    ...pricing,
    currency: typeof config.currency === 'string' && config.currency !== '' ? config.currency : 'CNY',
    currencySymbol: typeof config.currencySymbol === 'string' && config.currencySymbol !== '' ? config.currencySymbol : '¥',
    budgetTotal: Number.isFinite(config.budgetTotal) && config.budgetTotal > 0 ? config.budgetTotal : 0,
    baselineCost: Number.isFinite(config.baselineCost) ? config.baselineCost : 0,
    balanceRefreshSeconds: Number.isFinite(config.balanceRefreshSeconds) && config.balanceRefreshSeconds >= 30 ? config.balanceRefreshSeconds : 60,
    clientVersion: typeof config.clientVersion === 'string' ? config.clientVersion : '',
  };
}

/**
 * Sum priced days selected by a predicate.
 * @param {Map<string, object>} priced - the priced days from the ledger.
 * @param {(dateKey: string) => boolean} predicate - the day selector.
 * @returns {{ tokens: number, cost: number, calls: number, cacheHitRate: number | null, byModel: Record<string, { tokens: number, cost: number, calls: number }> }}
 *   the period totals.
 */
function sumRange(priced, predicate) {
  let tokens = 0;
  let cost = 0;
  let calls = 0;
  // `day.input` is the whole billed prompt: the three prompt-side buckets are
  // disjoint, so the cached share is measured against their sum.
  let billedInput = 0;
  let cacheRead = 0;
  const byModel = {};
  for (const [dateKey, day] of priced) {
    if (!predicate(dateKey)) continue;
    tokens += day.tokens;
    cost += day.cost;
    calls += day.calls;
    billedInput += day.input;
    cacheRead += day.cacheRead;
    for (const [model, entry] of Object.entries(day.byModel)) {
      const target = (byModel[model] ??= { tokens: 0, cost: 0, calls: 0 });
      target.tokens += entry.tokens;
      target.cost += entry.cost;
      target.calls += entry.calls;
    }
  }
  return { tokens, cost, calls, cacheHitRate: billedInput > 0 ? cacheRead / billedInput : null, byModel };
}

/**
 * Round a cost for transport without losing sub-cent precision.
 * @param {number} value - the raw cost.
 * @returns {number} the rounded cost.
 */
function money(value) {
  return Number(value.toFixed(6));
}

/**
 * The storage directory shared by the ledger and the activation diagnostic.
 * @returns {string} the absolute directory.
 */
function storageDirectory() {
  return path.join(dshHome(), 'storages', 'usage-dashboard');
}

/**
 * The last activation failure, surfaced through the snapshot.
 *
 * dsh's web boot treats ANY entry that does not reach the active state as fatal:
 * it aborts the boot and the desktop app then resets the profile. A dashboard
 * must never be able to do that to a user, so this plugin catches its own
 * activation failures, records them here and on disk, and stays loaded in a
 * degraded state instead of failing the fiber.
 *
 * @type {{ message: string, stack: string | null, at: number } | null}
 */
let activationError = null;

/**
 * Record one activation failure without ever throwing.
 *
 * Diagnostics must not become a second failure: every step here is best-effort,
 * including the write and the console fallback.
 *
 * @param {unknown} error - the thrown value.
 */
function recordActivationFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? null) : null;
  activationError = { message, stack, at: Date.now() };
  try {
    const directory = storageDirectory();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'activation-error.json'), JSON.stringify(activationError, null, 2), 'utf8');
  } catch {
    // The ledger directory may be unwritable; the in-memory copy still reports.
  }
  try {
    console.error(`[usage-dashboard] activation failed: ${message}`);
  } catch {
    // A host without console output still has the snapshot field.
  }
}

/**
 * Resolve the version reported to the Platform in `x-client-version`.
 *
 * This deliberately probes nothing. An earlier version walked host services
 * looking for a version string, which put unguarded property access on the
 * activation path for no functional gain; the header is informational, so an
 * explicit configuration value or the launch environment is enough, and
 * `unknown` is reported rather than an invented number.
 *
 * @param {Record<string, unknown>} config - the resolved configuration.
 * @returns {string} a version string, or `unknown`.
 */
function resolveClientVersion(config) {
  const candidate = (value) => typeof value === 'string' && value.trim() !== '';
  if (candidate(config.clientVersion)) return config.clientVersion.trim();
  if (candidate(process.env.DSH_CLIENT_VERSION)) return process.env.DSH_CLIENT_VERSION.trim();
  return 'unknown';
}

/**
 * Apply to the profile.
 *
 * This function must not throw. dsh's web boot fails outright when any entry
 * does not reach the active state, and the desktop app responds by resetting
 * the profile, so a bug in a dashboard would cost the user their whole
 * configuration. A failed activation is recorded and the plugin stays loaded
 * with reduced function instead.
 *
 * @param {object} ctx - the host plugin context.
 * @param {Record<string, unknown>} rawConfig - the row's `config` object.
 */
export function apply(ctx, rawConfig) {
  try {
    activate(ctx, rawConfig);
  } catch (error) {
    recordActivationFailure(error);
  }
}

/**
 * Register everything the plugin owns.
 *
 * Each registration runs through {@link guard}, so one failing step costs only
 * that step: the route can be missing while the ledger still folds, for example.
 *
 * @param {object} ctx - the host plugin context.
 * @param {Record<string, unknown>} rawConfig - the row's `config` object.
 */
function activate(ctx, rawConfig) {
  /**
   * Run one registration step, recording a failure instead of propagating it.
   * @param {string} label - what the step registers, for the diagnostic.
   * @param {() => void} step - the registration.
   */
  const guard = (label, step) => {
    try {
      step();
    } catch (error) {
      const detail = error instanceof Error ? error : new Error(`${label}: ${String(error)}`);
      recordActivationFailure(detail);
      try {
        ctx.logger?.warn?.(`usage-dashboard: ${label} failed: ${detail.message}`);
      } catch {
        // Logging is best-effort.
      }
    }
  };

  /**
   * Re-resolve the configuration from the fiber's live config.
   *
   * A settings write to a volatile field updates the fiber's config WITHOUT
   * re-running `apply` — that is the whole point of the marker — so a value
   * captured once at activation would ignore every later edit until a restart.
   * Every reader below therefore re-reads rather than closing over the first
   * resolution.
   *
   * @returns {object} the current resolved configuration.
   */
  const currentConfig = () => {
    const live = ctx.fiber?.config;
    return resolveConfig(live === undefined || live === null ? rawConfig : live);
  };

  let config = currentConfig();
  const clientVersion = resolveClientVersion(config);
  const ledger = new Ledger({
    directory: storageDirectory(),
    pricing: () => {
      const live = currentConfig();
      return { holidays: live.holidays, windows: live.peakWindows };
    },
  });
  guard('ledger load', () => ledger.load());

  /** @type {{ table: object, peakWindows: Array<{start: string, end: string}>, source: string, fetchedAt: number | null, warning: string | null, via: string | null }} */
  let pricing = {
    table: config.prices,
    peakWindows: config.peakWindows.length > 0 ? config.peakWindows : DEFAULT_PEAK_WINDOWS,
    source: 'builtin',
    fetchedAt: null,
    warning: null,
    via: null,
  };
  let pricingAttemptedAt = 0;
  let pricingInFlight = false;
  let balance = { available: false, source: 'budget', reason: 'not-read-yet', checkedAt: 0 };
  let greeting = null;
  let snapshotCache = null;

  /**
   * Refresh the pricing document when its cache window has passed.
   * @param {boolean} force - ignore the cache window.
   */
  const refreshPricing = (force = false) => {
    config = currentConfig();
    const staleAfter = config.refreshHours * 3600 * 1000;
    if (pricingInFlight) return;
    const fresh = pricing.fetchedAt !== null && Date.now() - pricing.fetchedAt < staleAfter;
    if (!force && fresh) return;
    if (!force && Date.now() - pricingAttemptedAt < 60000) return;
    pricingAttemptedAt = Date.now();
    pricingInFlight = true;
    void readPricing({ web: ctx.get('web'), url: config.pricingUrl, builtin: config.prices })
      .then((result) => {
        if (result.source === 'live') {
          pricing = { table: result.table, peakWindows: result.peakWindows, source: result.source, fetchedAt: result.fetchedAt, warning: result.warning, via: result.via };
        } else {
          pricing = { ...pricing, warning: result.warning, via: result.via };
        }
        snapshotCache = null;
      })
      .catch((error) => {
        pricing = { ...pricing, warning: { kind: 'unreachable', detail: error instanceof Error ? error.message : String(error) } };
      })
      .finally(() => {
        pricingInFlight = false;
      });
  };

  /**
   * Refresh the account balance when its cache window has passed.
   * @param {boolean} force - ignore the cache window.
   */
  const refreshBalance = (force = false) => {
    config = currentConfig();
    const configured = config.balanceRefreshSeconds * 1000;
    // The Platform is intermittently unreachable, so a failed read is retried on
    // a much shorter clock than a successful one. Waiting the full interval left
    // a stale "unavailable" on screen long after the network had recovered —
    // which is what "sometimes it works, sometimes it doesn't" looked like.
    const waitMs = balance.available === true ? configured : Math.min(configured, BALANCE_RETRY_MS);
    if (!force && Date.now() - (balance.checkedAt ?? 0) < waitMs) return;
    const account = ctx.get('deepseekAccount');
    void readBalance({ account, web: ctx.get('web'), locale: 'zh-CN', clientVersion })
      .then((result) => {
        balance = result;
        if (result.available && typeof result.total === 'string') {
          const numeric = Number(result.total);
          if (Number.isFinite(numeric)) ledger.recordBalance(numeric, result.checkedAt);
        }
        snapshotCache = null;
      })
      .catch(() => {
        // A failed read keeps the previous reading; `checkedAt` gates the retry.
      });
  };

  /** Build the document the client polls. */
  const buildSnapshot = () => {
    const nowMs = Date.now();
    // A settings write reaches the snapshot within one cache window, which is
    // what makes an edited field show up without a restart.
    config = currentConfig();
    if (snapshotCache !== null && nowMs - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache.value;

    const options = { holidays: config.holidays, windows: pricing.peakWindows };
    const priced = ledger.dailyTotals(pricing.table, config.fallbackModel);
    const periods = periodKeys(nowMs);
    const inRange = (dateKey, from, to) => dateKey >= from && dateKey <= to;
    const day = sumRange(priced.days, (key) => key === periods.day);
    const week = sumRange(priced.days, (key) => inRange(key, periods.weekStart, periods.weekEnd));
    const month = sumRange(priced.days, (key) => key.startsWith(periods.month));
    const year = sumRange(priced.days, (key) => key.startsWith(periods.year));
    const previousDay = sumRange(priced.days, (key) => key === periods.prevDay);
    const previousWeek = sumRange(priced.days, (key) => inRange(key, periods.prevWeekStart, periods.prevWeekEnd));
    const previousMonth = sumRange(priced.days, (key) => key.startsWith(periods.prevMonth));

    const series = seriesDates(nowMs).map((dateKey) => {
      const entry = priced.days.get(dateKey);
      return { date: dateKey, tokens: entry?.tokens ?? 0, cost: money(entry?.cost ?? 0) };
    });

    const models = Object.entries(month.byModel)
      .map(([model, entry]) => ({ model, tokens: entry.tokens, cost: money(entry.cost), calls: entry.calls }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

    const bucket = bucketAt(nowMs, options);
    const parts = beijingParts(nowMs);
    const nextAt = nextSwitchAt(nowMs, options);
    const spend = ledger.platformSpend(nowMs);
    const ledgerMonth = money(month.cost);
    const deviationPct = spend.month > 0 && ledgerMonth > 0 ? Number((((spend.month - ledgerMonth) / ledgerMonth) * 100).toFixed(2)) : null;
    const dayOfMonth = parts.day;
    const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
    const averagePerDay = dayOfMonth > 0 ? month.cost / dayOfMonth : 0;
    const spentIncludingBaseline = month.cost + config.baselineCost;
    const remainingFallback = config.budgetTotal > 0 ? Math.max(0, config.budgetTotal - spentIncludingBaseline) : null;

    const value = {
      generatedAt: nowMs,
      currency: config.currency,
      currencySymbol: config.currencySymbol,
      // Surfaced so a degraded activation is visible in the UI instead of
      // looking like an empty dashboard with no explanation.
      pluginError: activationError,
      network: {
        webService: ctx.get('web') === undefined ? 'unavailable' : 'ok',
        directFetch: typeof globalThis.fetch === 'function' ? 'ok' : 'failed',
        clientVersion,
        checkedAt: nowMs,
      },
      greeting: greeting ?? { text: '', from: null, fromWho: null, source: 'pending', fetchedAt: null },
      balance: {
        ...balance,
        usageUrl: balance.usageUrl ?? null,
        topUpUrl: balance.topUpUrl ?? null,
      },
      pricing: {
        table: pricing.table,
        peakWindows: pricing.peakWindows,
        source: pricing.source,
        fetchedAt: pricing.fetchedAt,
        warning: pricing.warning,
        via: pricing.via,
        unknownModels: priced.unknownModels,
      },
      peak: {
        isPeak: bucket === 'peak',
        bucket,
        label: bucket === 'peak' ? 'peak' : 'off',
        beijingIso: parts.iso,
        next: { at: nextAt, bucket: bucketAt(nextAt, options) },
        windows: pricing.peakWindows,
        holidaysConfigured: config.holidays.length > 0,
        holidays: config.holidays,
      },
      periods: {
        day: { label: periods.day, ...day, cost: money(day.cost) },
        week: { label: `${periods.weekStart}..${periods.weekEnd}`, ...week, cost: money(week.cost) },
        month: { label: periods.month, ...month, cost: money(month.cost) },
        year: { label: periods.year, ...year, cost: money(year.cost) },
        prev: {
          day: { label: periods.prevDay, ...previousDay, cost: money(previousDay.cost) },
          week: { label: `${periods.prevWeekStart}..${periods.prevWeekEnd}`, ...previousWeek, cost: money(previousWeek.cost) },
          month: { label: periods.prevMonth, ...previousMonth, cost: money(previousMonth.cost) },
        },
      },
      series: { days: series },
      models,
      reconcile: {
        platformSpend: { day: spend.day, month: spend.month },
        ledgerSpend: { day: money(day.cost), month: ledgerMonth },
        deviationPct,
        topUps: spend.topUps.slice(-20),
      },
      budget: { total: config.budgetTotal, spent: money(spentIncludingBaseline), remainingFallback: remainingFallback === null ? null : money(remainingFallback) },
      forecast: { avgPerDay: money(averagePerDay), monthEnd: money(averagePerDay * daysInMonth), daysInMonth },
      ledger: {
        since: ledger.snapshot().totals.since,
        calls: ledger.snapshot().totals.calls,
        backfillDone: ledger.snapshot().backfill.done,
        backfillError: ledger.snapshot().backfill.error ?? ledger.loadError,
        sessions: ledger.snapshot().backfill.sessions ?? 0,
        badFrames: ledger.snapshot().backfill.badFrames ?? 0,
      },
    };
    snapshotCache = { at: nowMs, value };
    return value;
  };

  // The ledger is durable, so a live event only needs to reach disk eventually.
  guard('ledger flush effect', () => {
    ctx.effect(() => () => ledger.dispose(), 'usage-dashboard: ledger flush');
  });

  guard('session listener', () => {
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = typeof session?.id === 'string' ? session.id : 'unknown';
        ledger.record(sessionId, event);
      } catch (error) {
        recordActivationFailure(error);
      }
    });
  });

  // Backfill after activation: reading every session artifact is synchronous
  // file work, so it must not sit in the plugin's start path.
  guard('backfill effect', () => {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        try {
          ledger.backfill(Date.now());
          snapshotCache = null;
        } catch (error) {
          recordActivationFailure(error);
        }
      }, BACKFILL_DELAY_MS);
      timer.unref?.();
      return () => clearTimeout(timer);
    }, 'usage-dashboard: session backfill');
  });

  // Pricing and balance are network reads: refresh in the background on a
  // cadence, never inside a request.
  guard('source refresh effect', () => {
    ctx.effect(() => {
      refreshPricing();
      refreshBalance();
      const timer = setInterval(() => {
        try {
          refreshPricing();
          refreshBalance();
        } catch (error) {
          recordActivationFailure(error);
        }
      }, 15000);
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'usage-dashboard: source refresh');
  });

  guard('greeting prefetch', () => {
    void fetchGreeting({ web: ctx.get('web') })
      .then((result) => {
        greeting = result;
        snapshotCache = null;
      })
      .catch(() => {
        // `builtinGreeting` already covers the unreachable case on the next read.
      });
  });

  guard('snapshot route', () => {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.effect(
          () =>
            webCtx.webServer.register({
              kind: 'exact',
              path: SNAPSHOT_PATH,
              handler: (request, response) => {
            // The desktop shell is served from the `dsh-app://` custom protocol
            // while the host listens on loopback HTTP, so this route is reached
            // cross-origin and must say so: without these headers the browser
            // blocks the client half from reading the response at all.
            const corsHeaders = {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'GET, HEAD, OPTIONS',
              'access-control-allow-headers': 'accept, content-type',
            };
            if (request.method === 'OPTIONS') {
              response.writeHead(204, corsHeaders);
              response.end();
              return;
            }
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              response.writeHead(405, { ...corsHeaders, allow: 'GET, HEAD, OPTIONS' });
              response.end();
              return;
            }
            /**
             * Serialize the current snapshot and write it.
             */
            const respond = () => {
              try {
                const body = JSON.stringify(buildSnapshot());
                response.writeHead(200, {
                  ...corsHeaders,
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                  'content-length': Buffer.byteLength(body),
                });
                response.end(request.method === 'HEAD' ? undefined : body);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.logger?.warn?.(`usage-dashboard: snapshot failed: ${message}`);
                const body = JSON.stringify({ error: message });
                response.writeHead(500, { ...corsHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                response.end(body);
              }
            };

            let fresh = null;
            try {
              fresh = new URL(request.url ?? SNAPSHOT_PATH, 'http://127.0.0.1').searchParams.get('fresh');
            } catch {
              fresh = null;
            }

            if (fresh !== 'greeting') {
              respond();
              return;
            }
            // A greeting refresh must land in THIS response: answering from the
            // cached snapshot first would make the "another" button look broken
            // until the next poll. The cache is dropped after the fetch, so the
            // rebuilt snapshot carries the new line.
            void fetchGreeting({ web: ctx.get('web') })
              .then((result) => {
                greeting = result;
                snapshotCache = null;
              })
              .catch(() => {
                snapshotCache = null;
              })
              .finally(respond);
          },
        }),
        'usage-dashboard: snapshot route',
      );
      } catch (error) {
        recordActivationFailure(error);
      }
    });
  });

  // A client-side registration failure has no other witness: the page console
  // is not reachable from here. The client half posts it to this route, and it
  // lands in the same diagnostic the host half writes.
  guard('client report route', () => {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.effect(
          () =>
            webCtx.webServer.register({
              kind: 'exact',
              path: '/usage-dashboard/client-report',
              handler: (request, response) => {
                response.writeHead(204, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
                response.end();
                try {
                  const detail = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('detail') ?? '';
                  if (detail === '') return;
                  recordActivationFailure(new Error(`client: ${decodeURIComponent(detail)}`));
                } catch {
                  // A malformed report must not affect the response already sent.
                }
              },
            }),
          'usage-dashboard: client report route',
        );
      } catch (error) {
        recordActivationFailure(error);
      }
    });
  });
}

// No static `inject` is declared on purpose. dsh's web boot counts a *pending*
// entry — one still waiting for a service — as a failure exactly like a crashed
// one, and it aborts the boot either way. Declaring `webServer` here would make
// this entry pending whenever the web server is absent or slow, so the route is
// attached through the dynamic `ctx.inject([...])` below instead, and the entry
// always reaches the active state.
//
// `Config` above needs a real schemastery schema, and this package has no
// dependencies. A workspace bundle is linked into the profile by path while its
// real files stay outside it, so a specifier for a package that ships inside
// dsh's own archive does not resolve from here — and a declared dependency would
// only work on the machine that wrote it, because pnpm reads `.npmrc` from the
// consuming project rather than from a dependency, leaving the junctions this
// loader's resolver does not follow. Both packages are inlined under `vendor/`
// instead; see vendor/README.md.
