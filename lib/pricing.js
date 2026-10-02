/**
 * Pricing table, peak/off-peak rules, and the billable-cost function.
 *
 * Prices come from the official DeepSeek pricing page and are quoted in CNY per
 * million tokens. Peak hours are Beijing time (UTC+8), Monday to Friday
 * excluding Chinese statutory holidays, 09:00-12:00 and 14:00-18:00; every
 * other instant is off-peak, and the off-peak price is half the peak price.
 *
 * @module dsh-usage-dashboard/pricing
 */

/** Milliseconds in one hour. */
const HOUR_MS = 3600 * 1000;
/** Beijing is UTC+8 with no daylight saving, so a fixed offset is correct. */
const BEIJING_OFFSET_MS = 8 * HOUR_MS;

/** Official endpoint of the pricing document. */
export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';

/**
 * Built-in price table, used whenever the live page cannot be read or fails
 * validation. Values are the peak prices from the official page; the off-peak
 * price is exactly half.
 * @type {Record<string, { cacheHit: { off: number, peak: number }, cacheMiss: { off: number, peak: number }, output: { off: number, peak: number } }>}
 */
export const DEFAULT_PRICES = {
  'deepseek-flash': {
    cacheHit: { off: 0.02, peak: 0.04 },
    cacheMiss: { off: 1, peak: 2 },
    output: { off: 4, peak: 8 },
  },
  'deepseek-v4-pro': {
    cacheHit: { off: 0.15, peak: 0.3 },
    cacheMiss: { off: 4.5, peak: 9 },
    output: { off: 13.5, peak: 27 },
  },
};

/**
 * Model names the official page documents as served by a current model, mapped
 * to the price row that bills them.
 * @type {Record<string, string>}
 */
export const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/** Built-in peak windows, as `HH:MM` boundaries in Beijing time. */
export const DEFAULT_PEAK_WINDOWS = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '18:00' },
];

/**
 * Parse an `HH:MM` boundary into minutes after midnight.
 * @param {string} value - the boundary text.
 * @returns {number | null} minutes after midnight, or `null` when unparseable.
 */
function minutesOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Render a boundary as zero-padded `HH:MM`, so a window read from the document
 * (`9:00`) compares equal to the built-in one (`09:00`).
 * @param {string} value - the boundary text.
 * @returns {string | null} the normalized boundary, or `null` when unparseable.
 */
function normalizeBoundary(value) {
  const minutes = minutesOfDay(value);
  if (minutes === null) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Break an instant into Beijing-time calendar fields.
 * @param {number} epochMs - the instant.
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number, minuteOfDay: number, dateKey: string, iso: string }}
 *   calendar fields; `weekday` is 0 for Sunday; `dateKey` is `YYYY-MM-DD`.
 */
export function beijingParts(epochMs) {
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const dateKey = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: shifted.getUTCDay(),
    minuteOfDay: hour * 60 + minute,
    dateKey,
    iso: `${dateKey}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`,
  };
}

/**
 * Convert a Beijing-time calendar date and minute-of-day back to an instant.
 * @param {string} dateKey - `YYYY-MM-DD` in Beijing time.
 * @param {number} minuteOfDay - minutes after Beijing midnight.
 * @returns {number} the epoch milliseconds.
 */
function beijingInstant(dateKey, minuteOfDay) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS + minuteOfDay * 60 * 1000;
}

/**
 * Whether the given instant falls inside a peak window.
 *
 * The official wording is "Monday to Friday (excluding Chinese statutory
 * holidays)", so a weekend make-up workday is still off-peak.
 *
 * @param {number} epochMs - the instant to classify.
 * @param {{ holidays?: readonly string[], windows?: readonly { start: string, end: string }[] }} [options] - holiday list and peak windows.
 * @returns {boolean} true when the instant is billed at peak rates.
 */
export function isPeakAt(epochMs, options = {}) {
  const parts = beijingParts(epochMs);
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  const holidays = options.holidays ?? [];
  if (holidays.includes(parts.dateKey)) return false;
  for (const window of options.windows ?? DEFAULT_PEAK_WINDOWS) {
    const start = minutesOfDay(window.start);
    const end = minutesOfDay(window.end);
    if (start === null || end === null) continue;
    if (parts.minuteOfDay >= start && parts.minuteOfDay < end) return true;
  }
  return false;
}

/**
 * The bucket name for an instant.
 * @param {number} epochMs - the instant.
 * @param {{ holidays?: readonly string[], windows?: readonly { start: string, end: string }[] }} [options] - holiday list and peak windows.
 * @returns {'peak' | 'off'} the billing bucket.
 */
export function bucketAt(epochMs, options = {}) {
  return isPeakAt(epochMs, options) ? 'peak' : 'off';
}

/**
 * The instant the current bucket next changes, so the client can count down
 * without polling the host.
 * @param {number} nowMs - the current instant.
 * @param {{ holidays?: readonly string[], windows?: readonly { start: string, end: string }[] }} [options] - holiday list and peak windows.
 * @returns {number} epoch milliseconds of the next bucket change.
 */
export function nextSwitchAt(nowMs, options = {}) {
  const current = bucketAt(nowMs, options);
  const boundaries = [];
  for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
    const dayKey = beijingParts(nowMs + dayOffset * 24 * HOUR_MS).dateKey;
    boundaries.push(beijingInstant(dayKey, 0));
    for (const window of options.windows ?? DEFAULT_PEAK_WINDOWS) {
      const start = minutesOfDay(window.start);
      const end = minutesOfDay(window.end);
      if (start !== null) boundaries.push(beijingInstant(dayKey, start));
      if (end !== null) boundaries.push(beijingInstant(dayKey, end));
    }
  }
  boundaries.sort((a, b) => a - b);
  for (const boundary of boundaries) {
    if (boundary > nowMs && bucketAt(boundary, options) !== current) return boundary;
  }
  return nowMs + 24 * HOUR_MS;
}

/**
 * Resolve the price row and normalized model name for a logged model.
 * @param {string} model - the model name found in a session event.
 * @param {Record<string, unknown>} table - the active price table.
 * @param {string} fallbackModel - the row used for an unknown model.
 * @returns {{ model: string, row: { cacheHit: { off: number, peak: number }, cacheMiss: { off: number, peak: number }, output: { off: number, peak: number } } | null, known: boolean }}
 *   the resolved model, its price row (or `null` when even the fallback is missing) and whether the name was recognized.
 */
export function resolvePriceRow(model, table, fallbackModel = 'deepseek-flash') {
  const direct = typeof model === 'string' ? model : '';
  const aliased = MODEL_ALIASES[direct] ?? direct;
  if (table && Object.prototype.hasOwnProperty.call(table, aliased)) return { model: aliased, row: table[aliased], known: true };
  if (table && Object.prototype.hasOwnProperty.call(table, fallbackModel)) return { model: fallbackModel, row: table[fallbackModel], known: false };
  return { model: aliased || 'unknown', row: null, known: false };
}

/**
 * Bill one model call.
 *
 * The three prompt-side buckets are **disjoint**. The harness documents
 * `billedInputTokens(usage) = uncachedInputTokens + cacheReadTokens +
 * cacheWriteTokens`, and a real logged call confirms it:
 * `{ inputTokens: 298, outputTokens: 289, cacheReadTokens: 13056,
 * totalTokens: 13643 }` sums exactly to `totalTokens`. So `inputTokens` is
 * already the uncached part, and the cached part must not be subtracted from
 * it. Cache writes have no separate official price line and bill at the miss
 * rate.
 *
 * @param {{ model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }} call - one call's numbers.
 * @param {'peak' | 'off'} bucket - the bucket the call happened in.
 * @param {Record<string, unknown>} table - the active price table.
 * @param {string} [fallbackModel] - the price row used for an unrecognized model.
 * @returns {{ cost: number, known: boolean, model: string }} the cost in CNY, whether the model was recognized, and the row used.
 */
export function callCost(call, bucket, table, fallbackModel = 'deepseek-flash') {
  const { model, row, known } = resolvePriceRow(call.model, table, fallbackModel);
  if (row === null) return { cost: 0, known: false, model };
  // The three prompt-side buckets are disjoint, so `inputTokens` IS the
  // uncached part: subtracting the cached part from it billed the prompt at
  // zero whenever a call was mostly cache hits.
  const uncachedInput = call.inputTokens ?? 0;
  const cacheRead = call.cacheReadTokens ?? 0;
  const cacheWrite = call.cacheWriteTokens ?? 0;
  const output = call.outputTokens ?? 0;
  const cost =
    (uncachedInput * row.cacheMiss[bucket] +
      cacheRead * row.cacheHit[bucket] +
      cacheWrite * row.cacheMiss[bucket] +
      output * row.output[bucket]) /
    1e6;
  return { cost, known, model };
}

/**
 * The cache-hit share of a call's billed prompt.
 *
 * The denominator is every prompt-side bucket, matching the harness's
 * `billedInputTokens`. Dividing by `inputTokens` alone (the uncached part)
 * produced hit rates far above 100%.
 *
 * @param {{ inputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} tokens - the call's prompt-side buckets.
 * @returns {number | null} the share in `0..1`, or `null` when there is no prompt.
 */
export function cacheHitShare(tokens) {
  const billed = (tokens.inputTokens ?? 0) + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0);
  if (billed <= 0) return null;
  return (tokens.cacheReadTokens ?? 0) / billed;
}

/**
 * Collapse a day/model/bucket token aggregate into a billable cost.
 * @param {{ in?: number, out?: number, cr?: number, cw?: number }} tokens - the aggregated token counts.
 * @param {string} model - the model the aggregate belongs to.
 * @param {'peak' | 'off'} bucket - the bucket the aggregate belongs to.
 * @param {Record<string, unknown>} table - the active price table.
 * @param {string} [fallbackModel] - the price row used for an unrecognized model.
 * @returns {{ cost: number, known: boolean, model: string }} the cost in CNY.
 */
export function bucketCost(tokens, model, bucket, table, fallbackModel = 'deepseek-flash') {
  return callCost(
    {
      model,
      inputTokens: tokens.in ?? 0,
      outputTokens: tokens.out ?? 0,
      cacheReadTokens: tokens.cr ?? 0,
      cacheWriteTokens: tokens.cw ?? 0,
    },
    bucket,
    table,
    fallbackModel,
  );
}

/**
 * Whether a parsed table is structurally sound.
 *
 * The page states that off-peak prices are exactly half the peak prices, so
 * that identity is the cheapest strong check: random numbers harvested from the
 * wrong part of the document cannot satisfy it.
 *
 * @param {unknown} table - the candidate table.
 * @returns {boolean} true when every model carries six sane, self-consistent prices.
 */
export function isValidPriceTable(table) {
  if (table === null || typeof table !== 'object') return false;
  const models = Object.keys(table);
  if (models.length === 0) return false;
  for (const model of models) {
    const row = table[model];
    if (row === null || typeof row !== 'object') return false;
    for (const category of ['cacheHit', 'cacheMiss', 'output']) {
      const pair = row[category];
      if (pair === null || typeof pair !== 'object') return false;
      const { off, peak } = pair;
      if (!Number.isFinite(off) || !Number.isFinite(peak)) return false;
      if (off <= 0 || peak <= 0 || peak > 1000) return false;
      if (off > peak) return false;
      if (Math.abs(off - peak / 2) > 1e-6) return false;
    }
  }
  return true;
}

/**
 * Flatten the pricing document to plain text: strip tags, table pipes, entity
 * escapes and collapsed whitespace, keeping one logical row per line.
 * @param {string} html - the raw document (or an already-plain rendering).
 * @returns {string[]} the normalized lines.
 */
export function normalizePricingText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:tr|p|div|li|h\d|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\|\s*/g, ' | ').trim())
    .filter((line) => line !== '');
}

/**
 * Read the six prices of each model, in the page's own row order:
 * cache-hit off/peak, cache-miss off/peak, output off/peak — interleaved per
 * model column, so the flattened sequence is off/peak pairs for flash then pro
 * within each category.
 * @param {string[]} lines - normalized document lines.
 * @returns {{ models: string[], values: number[] } | null} the model columns and their prices in page order, or `null` when the table cannot be located.
 */
function extractPriceSequence(lines) {
  const headerIndex = lines.findIndex((line) => line.includes('deepseek-flash') && line.includes('deepseek-v4-pro'));
  if (headerIndex < 0) return null;
  const values = [];
  let stopped = false;
  for (let index = headerIndex; index < lines.length && values.length < 12 && !stopped; index += 1) {
    const line = lines[index];
    if (index > headerIndex && /并发限制|扣费规则/.test(line)) {
      stopped = true;
      break;
    }
    const matches = line.matchAll(/(\d+(?:\.\d+)?)\s*元/g);
    for (const match of matches) {
      values.push(Number(match[1]));
      if (values.length >= 12) break;
    }
  }
  if (values.length < 12) return null;
  return { models: ['deepseek-flash', 'deepseek-v4-pro'], values: values.slice(0, 12) };
}

/**
 * Parse the official pricing document into a price table and peak windows.
 *
 * Returns `null` on any doubt: a wrong price is worse than the built-in one,
 * and the caller reports which source it used.
 *
 * @param {string} html - the raw document body.
 * @returns {{ table: Record<string, unknown>, peakWindows: Array<{ start: string, end: string }> } | null}
 *   the parsed pricing, or `null` when it fails validation.
 */
export function parsePricingPage(html) {
  const lines = normalizePricingText(html);
  const extracted = extractPriceSequence(lines);
  if (extracted === null) return null;

  // Page order inside one category is: flash off, pro off, flash peak, pro peak.
  const [flashHitOff, proHitOff, flashHitPeak, proHitPeak, flashMissOff, proMissOff, flashMissPeak, proMissPeak, flashOutOff, proOutOff, flashOutPeak, proOutPeak] =
    extracted.values;

  const table = {
    'deepseek-flash': {
      cacheHit: { off: flashHitOff, peak: flashHitPeak },
      cacheMiss: { off: flashMissOff, peak: flashMissPeak },
      output: { off: flashOutOff, peak: flashOutPeak },
    },
    'deepseek-v4-pro': {
      cacheHit: { off: proHitOff, peak: proHitPeak },
      cacheMiss: { off: proMissOff, peak: proMissPeak },
      output: { off: proOutOff, peak: proOutPeak },
    },
  };
  if (!isValidPriceTable(table)) return null;

  const windows = [];
  const seen = new Set();
  for (const line of lines) {
    if (!/高峰时段|空闲时段/.test(line)) continue;
    // One footnote line carries every window ("9:00 - 12:00、14:00 - 18:00"),
    // so all ranges on the line are read, not just the first.
    for (const match of line.matchAll(/(\d{1,2}:\d{2})\s*[-–~至]\s*(\d{1,2}:\d{2})/g)) {
      const start = normalizeBoundary(match[1]);
      const end = normalizeBoundary(match[2]);
      if (start === null || end === null) continue;
      const key = `${start}-${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      windows.push({ start, end });
    }
  }
  return { table, peakWindows: windows.length > 0 ? windows : DEFAULT_PEAK_WINDOWS };
}

/**
 * Merge user configuration over the built-in defaults.
 * @param {Record<string, unknown>} config - the row's `config` object.
 * @returns {{ prices: Record<string, unknown>, peakWindows: Array<{ start: string, end: string }>, holidays: string[], fallbackModel: string, refreshHours: number, pricingUrl: string }}
 *   the resolved pricing configuration.
 */
export function resolvePricingConfig(config = {}) {
  const prices = config.prices && typeof config.prices === 'object' && Object.keys(config.prices).length > 0 ? config.prices : DEFAULT_PRICES;
  const peakWindows = Array.isArray(config.peakWindows) && config.peakWindows.length > 0 ? config.peakWindows : DEFAULT_PEAK_WINDOWS;
  const holidays = Array.isArray(config.holidays) ? config.holidays.filter((value) => typeof value === 'string') : [];
  return {
    prices,
    peakWindows,
    holidays,
    fallbackModel: typeof config.fallbackModel === 'string' && config.fallbackModel !== '' ? config.fallbackModel : 'deepseek-flash',
    refreshHours: Number.isFinite(config.refreshHours) && config.refreshHours > 0 ? config.refreshHours : 12,
    pricingUrl: typeof config.pricingUrl === 'string' && config.pricingUrl !== '' ? config.pricingUrl : PRICING_URL,
  };
}
