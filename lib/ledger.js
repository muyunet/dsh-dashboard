/**
 * The usage ledger: a durable per-day, per-model, per-bucket token aggregate
 * folded from dsh session logs.
 *
 * Token counts are the source of truth, not money. Keeping counts lets the
 * billable cost be recomputed exactly whenever the price table changes, and it
 * bounds the file: at most one record per day, per model, per bucket.
 *
 * Idempotence comes from a per-session high-water mark on the session sequence:
 * backfill and the live feed share one code path and both advance it, so
 * re-running backfill never double counts.
 *
 * @module dsh-usage-dashboard/ledger
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bucketCost, bucketAt, beijingParts } from './pricing.js';
import { readJsonlLines, zstdAvailable } from './zstd.js';

/** Ledger schema version; bump when the fold semantics change. */
const LEDGER_VERSION = 1;

/** Days kept in the heatmap series, and therefore in `days`. */
export const SERIES_DAYS = 371;

/** Consecutive balance readings kept for the platform-side reconciliation. */
const MAX_BALANCE_SAMPLES = 4000;

/** Debounce window for persisting after a live event. */
const PERSIST_DEBOUNCE_MS = 2000;

/** Shape of one `{ in, out, cr, cw, calls }` aggregate. */
const EMPTY_BUCKET = () => ({ in: 0, out: 0, cr: 0, cw: 0, calls: 0 });

/** Milliseconds in one day. */
const DAY_MS = 24 * 3600 * 1000;

/**
 * Convert a number-ish value to a finite non-negative integer.
 * @param {unknown} value - the raw value.
 * @returns {number} the safe integer.
 */
function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * Resolve the dsh home directory.
 * @returns {string} the absolute path.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

/**
 * Convert a Beijing calendar date to a UTC midnight instant for arithmetic.
 * @param {string} dateKey - `YYYY-MM-DD`.
 * @returns {number} epoch milliseconds at UTC midnight of that date.
 */
function dateKeyToUtc(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Render a UTC midnight instant as a Beijing calendar date.
 * @param {number} utcMs - epoch milliseconds at UTC midnight.
 * @returns {string} `YYYY-MM-DD`.
 */
function utcToDateKey(utcMs) {
  const date = new Date(utcMs);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * Shift a date key by whole days.
 * @param {string} dateKey - `YYYY-MM-DD`.
 * @param {number} days - the signed day delta.
 * @returns {string} the shifted date key.
 */
function shiftDateKey(dateKey, days) {
  return utcToDateKey(dateKeyToUtc(dateKey) + days * DAY_MS);
}

/**
 * The Monday of the week containing a date, matching the pricing page's
 * Monday-to-Friday working week.
 * @param {string} dateKey - `YYYY-MM-DD`.
 * @returns {string} the Monday's date key.
 */
export function mondayOf(dateKey) {
  const weekday = new Date(dateKeyToUtc(dateKey)).getUTCDay();
  return shiftDateKey(dateKey, -((weekday + 6) % 7));
}

/**
 * The period boundaries used by the summary, in Beijing time.
 * @param {number} nowMs - the current instant.
 * @returns {{ day: string, weekStart: string, weekEnd: string, month: string, year: string,
 *   prevDay: string, prevWeekStart: string, prevWeekEnd: string, prevMonth: string }}
 *   the current and previous period keys.
 */
export function periodKeys(nowMs) {
  const today = beijingParts(nowMs).dateKey;
  const weekStart = mondayOf(today);
  const month = today.slice(0, 7);
  const year = today.slice(0, 4);
  const [monthYear, monthNumber] = month.split('-').map(Number);
  const prevMonthDate = new Date(Date.UTC(monthYear, monthNumber - 2, 1));
  const pad = (value) => String(value).padStart(2, '0');
  const prevMonth = `${pad(prevMonthDate.getUTCFullYear())}-${pad(prevMonthDate.getUTCMonth() + 1)}`;
  return {
    day: today,
    weekStart,
    weekEnd: shiftDateKey(weekStart, 6),
    month,
    year,
    prevDay: shiftDateKey(today, -1),
    prevWeekStart: shiftDateKey(weekStart, -7),
    prevWeekEnd: shiftDateKey(weekStart, -1),
    prevMonth,
  };
}

/**
 * The trailing calendar dates the heatmap renders, oldest first, in Beijing
 * time. Dates with no usage still appear so the grid keeps its shape.
 * @param {number} nowMs - the current instant.
 * @returns {string[]} `SERIES_DAYS` date keys ending today.
 */
export function seriesDates(nowMs) {
  const today = beijingParts(nowMs).dateKey;
  const dates = [];
  for (let offset = SERIES_DAYS - 1; offset >= 0; offset -= 1) dates.push(shiftDateKey(today, -offset));
  return dates;
}

/**
 * Extract one billable call from a session event.
 *
 * The shape is taken from real session logs: `assistant/message` carries
 * `data.usage` and the model on `data.message.source`.
 *
 * @param {unknown} event - one session event.
 * @returns {{ seq: number | null, time: number, model: string, provider: string, tokens: { in: number, out: number, cr: number, cw: number } } | null}
 *   the extracted call, or `null` when the event carries no usage.
 */
export function usageFromEvent(event) {
  if (event === null || typeof event !== 'object') return null;
  if (event.type !== 'assistant/message') return null;
  const data = event.data;
  if (data === null || typeof data !== 'object') return null;
  const usage = data.usage;
  if (usage === null || typeof usage !== 'object') return null;
  const source = data.message?.source ?? {};
  const model = typeof source.model === 'string' ? source.model : typeof source.response?.model === 'string' ? source.response.model : 'unknown';
  const provider = typeof source.provider === 'string' ? source.provider : 'unknown';
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now();
  return {
    seq: typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : null,
    time,
    model,
    provider,
    tokens: {
      in: toCount(usage.inputTokens),
      out: toCount(usage.outputTokens),
      cr: toCount(usage.cacheReadTokens),
      cw: toCount(usage.cacheWriteTokens),
    },
  };
}

/** An empty ledger. */
function emptyLedger() {
  return {
    version: LEDGER_VERSION,
    highWater: {},
    days: {},
    balanceSamples: [],
    topUps: [],
    totals: { since: null, calls: 0 },
    backfill: { done: false, at: null, sessions: 0, badFrames: 0, error: null },
  };
}

/**
 * Model the ledger's durability and folding.
 */
export class Ledger {
  /**
   * @param {{ directory: string, pricing: () => object, onChanged?: () => void }} options - storage directory, a live pricing resolver, and a change notifier.
   */
  constructor(options) {
    this.directory = options.directory;
    this.file = path.join(options.directory, 'ledger.json');
    this.pricing = options.pricing;
    this.onChanged = options.onChanged ?? (() => {});
    this.data = emptyLedger();
    this.loadError = null;
    this.dirty = false;
    this.persistTimer = null;
  }

  /** Read the ledger from disk, rebuilding it when the file is unusable. */
  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
      this.data = {
        ...emptyLedger(),
        ...parsed,
        highWater: parsed.highWater ?? {},
        days: parsed.days ?? {},
        balanceSamples: Array.isArray(parsed.balanceSamples) ? parsed.balanceSamples : [],
        topUps: Array.isArray(parsed.topUps) ? parsed.topUps : [],
        totals: parsed.totals ?? { since: null, calls: 0 },
        backfill: { ...emptyLedger().backfill, ...(parsed.backfill ?? {}) },
      };
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // A failed backup must not stop the plugin: the new ledger simply wins.
      }
      this.data = emptyLedger();
    }
  }

  /** Ensure the storage directory exists. */
  ensureDirectory() {
    fs.mkdirSync(this.directory, { recursive: true });
  }

  /** Write the ledger atomically: a temporary file then a rename. */
  persist() {
    if (!this.dirty) return;
    try {
      this.ensureDirectory();
      const temporary = `${this.file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.data), 'utf8');
      fs.renameSync(temporary, this.file);
      this.dirty = false;
    } catch (error) {
      this.data.backfill.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** Mark the ledger dirty and schedule a debounced write. */
  touch() {
    this.dirty = true;
    this.onChanged();
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  /** Flush any pending write and stop the timer. */
  dispose() {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  /**
   * Fold one extracted call into the daily aggregate.
   * @param {{ time: number, model: string, tokens: { in: number, out: number, cr: number, cw: number } }} call - the call to fold.
   * @returns {boolean} whether anything changed.
   */
  fold(call) {
    const parts = beijingParts(call.time);
    const bucket = bucketAt(call.time, this.pricing());
    const day = (this.data.days[parts.dateKey] ??= {});
    const models = (day[call.model] ??= { peak: EMPTY_BUCKET(), off: EMPTY_BUCKET() });
    const target = (models[bucket] ??= EMPTY_BUCKET());
    target.in += call.tokens.in;
    target.out += call.tokens.out;
    target.cr += call.tokens.cr;
    target.cw += call.tokens.cw;
    target.calls += 1;
    this.data.totals.calls += 1;
    if (this.data.totals.since === null || call.time < this.data.totals.since) this.data.totals.since = call.time;
    this.touch();
    return true;
  }

  /**
   * Fold one live session event, respecting the session's high-water mark.
   * @param {string} sessionId - the owning session.
   * @param {unknown} event - the session event.
   * @returns {boolean} whether a call was folded.
   */
  record(sessionId, event) {
    const call = usageFromEvent(event);
    if (call === null) return false;
    if (call.seq !== null) {
      const seen = this.data.highWater[sessionId] ?? -1;
      if (call.seq <= seen) return false;
      this.data.highWater[sessionId] = call.seq;
    }
    return this.fold(call);
  }

  /**
   * Record a balance reading and classify the movement since the previous one.
   *
   * A fall is spend; a rise is a top-up. This is a heuristic second opinion, not
   * an authoritative figure: another client using the same account moves the
   * same number.
   *
   * @param {number} total - the total balance in the account currency.
   * @param {number} at - the reading instant.
   * @returns {boolean} whether the ledger changed.
   */
  recordBalance(total, at = Date.now()) {
    if (!Number.isFinite(total)) return false;
    const previous = this.data.balanceSamples[this.data.balanceSamples.length - 1];
    if (previous !== undefined && previous.total === total) return false;
    if (previous !== undefined && total > previous.total) {
      this.data.topUps.push({ t: at, amount: Number((total - previous.total).toFixed(4)) });
      if (this.data.topUps.length > 500) this.data.topUps.splice(0, this.data.topUps.length - 500);
    }
    this.data.balanceSamples.push({ t: at, total });
    if (this.data.balanceSamples.length > MAX_BALANCE_SAMPLES) {
      this.data.balanceSamples.splice(0, this.data.balanceSamples.length - MAX_BALANCE_SAMPLES);
    }
    this.touch();
    return true;
  }

  /**
   * Prune daily records older than the series window.
   * @param {number} nowMs - the current instant.
   */
  prune(nowMs) {
    const cutoff = shiftDateKey(beijingParts(nowMs).dateKey, -SERIES_DAYS);
    for (const dateKey of Object.keys(this.data.days)) {
      if (dateKey < cutoff) delete this.data.days[dateKey];
    }
  }

  /**
   * Read every session artifact under the sessions root and fold the calls that
   * have not been seen yet.
   *
   * Backfill is best-effort: a missing runtime decoder, an unreadable file or a
   * damaged frame is recorded and skipped, never thrown.
   *
   * @param {number} nowMs - the current instant, used for bookkeeping.
   * @returns {{ sessions: number, calls: number, badFrames: number, error: string | null, unavailable: boolean }}
   *   the backfill outcome.
   */
  backfill(nowMs = Date.now()) {
    const report = { sessions: 0, calls: 0, badFrames: 0, error: null, unavailable: !zstdAvailable() };
    const root = path.join(dshHome(), 'sessions');
    try {
      if (!fs.existsSync(root)) {
        this.data.backfill = { done: true, at: nowMs, sessions: 0, badFrames: 0, error: null };
        this.touch();
        return report;
      }
      for (const workspaceDir of fs.readdirSync(root, { withFileTypes: true })) {
        if (!workspaceDir.isDirectory()) continue;
        const workspacePath = path.join(root, workspaceDir.name);
        for (const sessionDir of fs.readdirSync(workspacePath, { withFileTypes: true })) {
          if (!sessionDir.isDirectory()) continue;
          const sessionPath = path.join(workspacePath, sessionDir.name);
          const artifact = fs.readdirSync(sessionPath).find((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name));
          if (artifact === undefined) continue;
          const compressed = artifact.endsWith('.zstd');
          const buffer = fs.readFileSync(path.join(sessionPath, artifact));
          const { lines, badFrames, unavailable } = readJsonlLines(buffer, compressed);
          if (unavailable) report.unavailable = true;
          report.badFrames += badFrames;
          this.foldSession(sessionDir.name, lines, report);
          report.sessions += 1;
        }
      }
      this.data.backfill = { done: true, at: nowMs, sessions: report.sessions, badFrames: report.badFrames, error: null };
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      this.data.backfill = { done: true, at: nowMs, sessions: report.sessions, badFrames: report.badFrames, error: report.error };
    }
    this.prune(nowMs);
    this.touch();
    return report;
  }

  /**
   * Fold the calls of one session's JSONL lines that the high-water mark has
   * not covered yet.
   * @param {string} sessionId - the session directory name.
   * @param {string[]} lines - the artifact's JSONL lines.
   * @param {{ calls: number }} report - the running report to update.
   */
  foldSession(sessionId, lines, report) {
    let highest = this.data.highWater[sessionId] ?? -1;
    let newest = highest;
    const pending = [];
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const call = usageFromEvent(event);
      if (call === null) continue;
      if (call.seq === null) {
        pending.push(call);
        continue;
      }
      if (call.seq > highest) {
        pending.push(call);
        if (call.seq > newest) newest = call.seq;
      }
    }
    if (pending.length === 0) return;
    for (const call of pending) this.fold(call);
    report.calls += pending.length;
    if (newest > highest) this.data.highWater[sessionId] = newest;
  }

  /**
   * Price every day once, so the period totals and the heatmap series share a
   * single pass over the ledger instead of re-walking it per period.
   * @param {Record<string, unknown>} table - the active price table.
   * @param {string} fallbackModel - the row used for unrecognized models.
   * @returns {{ days: Map<string, { tokens: number, cost: number, calls: number, cacheHitRate: number | null, byModel: Record<string, { tokens: number, cost: number, calls: number }> }>, unknownModels: string[] }}
   *   the priced days, keyed by `YYYY-MM-DD`, and every model name that had no price row.
   */
  dailyTotals(table, fallbackModel) {
    const priced = new Map();
    const unknownModels = [];
    for (const [dateKey, day] of Object.entries(this.data.days)) {
      let tokens = 0;
      let cost = 0;
      let calls = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let billedInputTokens = 0;
      const byModel = {};
      for (const [model, buckets] of Object.entries(day)) {
        for (const bucket of ['peak', 'off']) {
          const entry = buckets?.[bucket];
          if (entry === undefined) continue;
          const total = (entry.in ?? 0) + (entry.out ?? 0);
          if (total === 0 && (entry.calls ?? 0) === 0) continue;
          const result = bucketCost(entry, model, bucket, table, fallbackModel);
          if (!result.known && !unknownModels.includes(model)) unknownModels.push(model);
          const modelEntry = (byModel[model] ??= { tokens: 0, cost: 0, calls: 0 });
          modelEntry.tokens += total;
          modelEntry.cost += result.cost;
          modelEntry.calls += entry.calls ?? 0;
          tokens += total;
          cost += result.cost;
          calls += entry.calls ?? 0;
          // The three prompt-side buckets are disjoint, so the billed prompt is
          // their SUM. Accumulating only `in` here is what made the cache-hit
          // share come out as 9500% instead of 99%.
          billedInputTokens += (entry.in ?? 0) + (entry.cr ?? 0) + (entry.cw ?? 0);
          cacheReadTokens += entry.cr ?? 0;
          cacheWriteTokens += entry.cw ?? 0;
        }
      }
      const cacheHitRate = billedInputTokens > 0 ? cacheReadTokens / billedInputTokens : null;
      priced.set(dateKey, {
        tokens,
        cost,
        calls,
        input: billedInputTokens,
        cacheRead: cacheReadTokens,
        cacheHitRate,
        byModel,
      });
    }
    return { days: priced, unknownModels };
  }

  /**
   * Derive platform-side spend from the recorded balance samples.
   *
   * A fall between two readings is spend attributed to the later reading; a rise
   * is recorded as a top-up and contributes nothing.
   *
   * @param {number} nowMs - the current instant.
   * @returns {{ day: number, month: number, topUps: Array<{ at: number, amount: number }> }}
   *   the platform-side spend and the top-ups in the same window.
   */
  platformSpend(nowMs) {
    const periods = periodKeys(nowMs);
    let day = 0;
    let month = 0;
    const samples = this.data.balanceSamples;
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      if (current.total >= previous.total) continue;
      const delta = previous.total - current.total;
      const dateKey = beijingParts(current.t).dateKey;
      if (dateKey === periods.day) day += delta;
      if (dateKey.startsWith(periods.month)) month += delta;
    }
    return {
      day: Number(day.toFixed(4)),
      month: Number(month.toFixed(4)),
      topUps: this.data.topUps.filter((entry) => beijingParts(entry.t).dateKey.startsWith(periods.month)),
    };
  }

  /** @returns {object} the raw ledger state, for persistence-free inspection. */
  snapshot() {
    return this.data;
  }
}
