/**
 * Offline regression for the pricing-document parser.
 *
 * The live document changes shape without notice, so the property under test is
 * not "it parses" but "it refuses": a document that is truncated before its
 * table, or whose prices break the published half-price identity, must yield
 * `null` so the caller keeps the built-in table instead of billing wrong.
 *
 * Run: node test/pricing.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PRICES,
  DEFAULT_PEAK_WINDOWS,
  cacheHitShare,
  callCost,
  isPeakAt,
  isValidPriceTable,
  nextSwitchAt,
  parsePricingPage,
} from '../lib/pricing.js';
import { readPricing } from '../lib/sources.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, 'fixtures', 'pricing.zh.html'), 'utf8');

let passed = 0;
/**
 * Run one assertion group.
 * @param {string} name - the case name.
 * @param {() => void} body - the assertions.
 */
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}

console.log('pricing parser');

test('reads all six prices of both models from the document', () => {
  const parsed = parsePricingPage(fixture);
  assert.notEqual(parsed, null, 'the document must parse');
  assert.deepEqual(parsed.table, DEFAULT_PRICES);
});

test('reads both peak windows from the footnote', () => {
  const parsed = parsePricingPage(fixture);
  assert.deepEqual(parsed.peakWindows, DEFAULT_PEAK_WINDOWS);
});

test('ignores numbers inside script and style bodies', () => {
  // The fixture's <script> carries 384000, 2500 and 27.0; a parser that did not
  // strip it would misalign the sequence and fail validation.
  const parsed = parsePricingPage(fixture);
  assert.equal(parsed.table['deepseek-v4-pro'].output.peak, 27);
  assert.equal(parsed.table['deepseek-flash'].cacheHit.off, 0.02);
});

test('refuses a document truncated before the price table', () => {
  const cut = fixture.slice(0, fixture.indexOf('价格(2)'));
  assert.equal(parsePricingPage(cut), null);
});

test('refuses a document whose prices break the half-price identity', () => {
  const tampered = fixture.replace('0.04元', '0.05元');
  assert.equal(parsePricingPage(tampered), null);
});

test('refuses a document missing one model column', () => {
  const tampered = fixture.replace('deepseek-v4-pro</th>', 'deepseek-v4.1-pro</th>');
  assert.equal(parsePricingPage(tampered), null);
});

test('accepts a genuine price change that keeps the identity', () => {
  const repriced = fixture.replace('0.02元', '0.03元').replace('0.04元', '0.06元');
  const parsed = parsePricingPage(repriced);
  assert.notEqual(parsed, null, 'a consistent repricing must be accepted');
  assert.equal(parsed.table['deepseek-flash'].cacheHit.off, 0.03);
  assert.equal(parsed.table['deepseek-flash'].cacheHit.peak, 0.06);
});

console.log('price table validation');

test('rejects a table with a non-half off-peak price', () => {
  assert.equal(isValidPriceTable({ 'deepseek-flash': { cacheHit: { off: 0.03, peak: 0.04 }, cacheMiss: { off: 1, peak: 2 }, output: { off: 4, peak: 8 } } }), false);
});

test('accepts the built-in table', () => {
  assert.equal(isValidPriceTable(DEFAULT_PRICES), true);
});

console.log('billing');

test('treats the three prompt buckets as disjoint', () => {
  // A real logged call. The buckets sum exactly to `totalTokens`, which only
  // holds if `inputTokens` is already the uncached part — so the cached part
  // must never be subtracted from it.
  const sample = { inputTokens: 298, outputTokens: 289, cacheReadTokens: 13056, cacheWriteTokens: 0, totalTokens: 13643 };
  assert.equal(sample.inputTokens + sample.outputTokens + sample.cacheReadTokens + sample.cacheWriteTokens, sample.totalTokens);

  const { cost } = callCost({ model: 'deepseek-flash', ...sample }, 'off', DEFAULT_PRICES);
  const expected = (298 * 1 + 13056 * 0.02 + 289 * 4) / 1e6;
  assert.equal(Number(cost.toFixed(10)), Number(expected.toFixed(10)));
  assert.ok(cost > 0, 'a mostly-cached call must not bill as zero');
});

test('measures the cache-hit share against the whole billed prompt', () => {
  const share = cacheHitShare({ inputTokens: 298, cacheReadTokens: 13056, cacheWriteTokens: 0 });
  assert.equal(Number(share.toFixed(6)), Number((13056 / (298 + 13056)).toFixed(6)));
  assert.ok(share <= 1, 'a hit share can never exceed 100%');
  assert.equal(cacheHitShare({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
});

test('bills a call with no cache at the miss rate for every input token', () => {
  const { cost } = callCost({ model: 'deepseek-flash', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'off', DEFAULT_PRICES);
  assert.equal(Number(cost.toFixed(10)), Number((1000 / 1e6).toFixed(10)));
});

test('doubles the same call at peak', () => {
  const call = { model: 'deepseek-flash', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const off = callCost(call, 'off', DEFAULT_PRICES).cost;
  const peak = callCost(call, 'peak', DEFAULT_PRICES).cost;
  assert.equal(Number((peak / off).toFixed(9)), 2);
});

test('prices an aliased legacy model with its current row', () => {
  const { model, known } = callCost({ model: 'deepseek-v4-flash', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'off', DEFAULT_PRICES);
  assert.equal(model, 'deepseek-flash');
  assert.equal(known, true);
});

console.log('peak windows (Beijing time, UTC+8)');

test('classifies a Friday 10:00 Beijing instant as peak', () => {
  // 2026-10-02 is a Friday; 02:00Z is 10:00 in Beijing.
  assert.equal(isPeakAt(Date.UTC(2026, 9, 2, 2, 0, 0), { holidays: [] }), true);
});

test('classifies the 12:00-14:00 Beijing gap as off-peak', () => {
  assert.equal(isPeakAt(Date.UTC(2026, 9, 2, 5, 0, 0), { holidays: [] }), false);
});

test('classifies a Saturday as off-peak even inside a window', () => {
  // 2026-10-03 is a Saturday.
  assert.equal(isPeakAt(Date.UTC(2026, 9, 3, 2, 0, 0), { holidays: [] }), false);
});

test('honours a configured holiday', () => {
  assert.equal(isPeakAt(Date.UTC(2026, 9, 2, 2, 0, 0), { holidays: ['2026-10-02'] }), false);
});

test('finds the next bucket change at a window boundary', () => {
  const at = Date.UTC(2026, 9, 2, 5, 30, 0); // 13:30 Beijing, off-peak
  const next = nextSwitchAt(at, { holidays: [] });
  assert.equal(new Date(next).toISOString(), new Date(Date.UTC(2026, 9, 2, 6, 0, 0)).toISOString());
});

test('an unreadable document reports a structured reason, not a sentence', async () => {
  // The client renders the reason in the active language, so the host must not
  // hand it prose: the raw transport text belongs in `detail`, where the card
  // shows it on hover. A sentence here is what put
  // "official pricing document could not be read (web fetch failed: ...)" in the
  // middle of a Chinese card.
  globalThis.fetch = async () => {
    throw new Error('TypeError: fetch failed');
  };
  const result = await readPricing({ url: 'https://example.invalid/pricing' });
  assert.equal(result.source, 'builtin', 'a failed read must fall back to the built-in table');
  assert.equal(typeof result.warning, 'object', 'the warning must be structured');
  assert.equal(result.warning.kind, 'unreachable');
  assert.equal(typeof result.warning.detail, 'string', 'the transport text must survive as detail');
  assert.ok(!/could not be read/i.test(JSON.stringify(result.warning)), 'no prose in the structured field');
});

test('a document that fails validation is reported as invalid', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html><body>nope</body></html>' });
  const result = await readPricing({ url: 'https://example.invalid/pricing' });
  assert.equal(result.source, 'builtin');
  assert.equal(result.warning.kind, 'invalid');
  assert.equal(result.warning.detail, null, 'a validation failure has no transport detail');
});

console.log(`\n${passed} checks passed`);
