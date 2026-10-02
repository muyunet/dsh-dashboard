/**
 * Config schema checks.
 *
 * The schema is not cosmetic, and two separate gates have to pass before the
 * Plugins page shows anything at all:
 *
 *  1. dsh validates a row's `config` through the schema before `apply` runs, so
 *     a schema that rejects an empty or partial config turns a working plugin
 *     into a failed boot entry.
 *  2. dsh builds a settings page only from fields the schema marks `volatile` —
 *     `volatileForm` walks the node tree and returns nothing when no leaf has
 *     it. A plain schema validates perfectly and still renders no configuration
 *     anywhere, which is exactly how the page ended up empty.
 *
 * A volatile field also parses into `{ get, [write] }` rather than the value, so
 * the third property here is that unwrapping recovers the plain value: skip it
 * and every field silently reads as its default.
 */

import assert from 'node:assert/strict';

import { isVolatile } from '../vendor/cosmokit/index.js';

import { Config } from '../index.js';

let passed = 0;

/**
 * Run one named check.
 * @param {string} name - the check name.
 * @param {() => void} body - the check body.
 */
function test(name, body) {
  body();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * Replica of dsh-settings' `volatileForm`: the fields dsh actually offers.
 * @param {object} schema - a schemastery node.
 * @returns {string[] | undefined} the live field names, or undefined when none is.
 */
function volatileFields(schema) {
  if (schema.meta.volatile) return ['self'];
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileFields(child);
        return field === undefined ? [] : [[key, field]];
      }),
    );
    return Object.keys(dict).length === 0 ? undefined : Object.keys(dict);
  }
  return undefined;
}

/**
 * Strip live references, the way the host half reads its config.
 * @param {unknown} value - a parsed config value.
 * @returns {unknown} the plain value.
 */
function unwrap(value) {
  if (isVolatile(value)) return unwrap(value.get());
  if (Array.isArray(value)) return value.map(unwrap);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrap(child)]));
  }
  return value;
}

/**
 * Validate and unwrap in one step, which is what `resolveConfig` sees.
 * @param {unknown} raw - the row's raw config.
 * @returns {object} the plain parsed config.
 */
function parsed(raw) {
  const result = Config['~standard'].validate(raw);
  assert.equal(result.issues, undefined, `config must validate: ${JSON.stringify(result.issues)}`);
  return unwrap(result.value);
}

const DEFAULTS = {
  budgetTotal: 0,
  baselineCost: 0,
  currencySymbol: '¥',
  currency: 'CNY',
  balanceRefreshSeconds: 60,
  fallbackModel: 'deepseek-flash',
  holidays: [],
  refreshHours: 12,
  pricingUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
};

console.log('config schema');

test('every field is volatile, which is what creates the settings page', () => {
  // Without this the Plugin Manager renders no configuration at all, even
  // though the schema validates and the dashboard itself works.
  const fields = volatileFields(Config);
  assert.notEqual(fields, undefined, 'at least one field must be volatile or dsh builds no page');
  assert.deepEqual(fields.sort(), Object.keys(DEFAULTS).sort());
});

test('a volatile value unwraps to the plain default', () => {
  // The trap: the raw parsed value is a live reference, so `Number.isFinite`
  // over it is false and the plugin would silently ignore every setting.
  const raw = Config['~standard'].validate({}).value;
  assert.equal(isVolatile(raw.budgetTotal), true, 'a volatile field parses into a live reference');
  assert.equal(unwrap(raw.budgetTotal), 0, 'unwrapping must recover the value');
});

test('every field carries a default, so an empty config validates', () => {
  assert.deepEqual(parsed({}), DEFAULTS);
});

test('an absent config behaves exactly like an empty one', () => {
  assert.deepEqual(parsed(undefined), parsed({}));
});

test('explicit values survive the round trip', () => {
  assert.deepEqual(parsed({ budgetTotal: 100, baselineCost: 20, holidays: ['2026-10-01'] }), {
    ...DEFAULTS,
    budgetTotal: 100,
    baselineCost: 20,
    holidays: ['2026-10-01'],
  });
});

test('values outside the documented range are rejected', () => {
  assert.notEqual(Config['~standard'].validate({ budgetTotal: -1 }).issues, undefined, 'negative budget');
  assert.notEqual(Config['~standard'].validate({ baselineCost: -1 }).issues, undefined, 'negative baseline');
  assert.notEqual(
    Config['~standard'].validate({ balanceRefreshSeconds: 5 }).issues,
    undefined,
    'a 5s balance poll is below the floor',
  );
  assert.notEqual(Config['~standard'].validate({ refreshHours: 0 }).issues, undefined, 'a zero-hour refresh');
  assert.notEqual(Config['~standard'].validate({ holidays: [1, 2] }).issues, undefined, 'non-string holidays');
});

test('unknown keys survive validation', () => {
  // `prices` and `peakWindows` are deliberately unmodelled: schemastery keeps
  // unknown keys, so a patch can still override the rate card or the windows.
  const value = parsed({
    prices: { 'deepseek-flash': { input: 1 } },
    peakWindows: [{ start: '08:30', end: '16:30' }],
    clientVersion: '9.9.9',
  });
  assert.deepEqual(value.prices, { 'deepseek-flash': { input: 1 } });
  assert.deepEqual(value.peakWindows, [{ start: '08:30', end: '16:30' }]);
  assert.equal(value.clientVersion, '9.9.9');
});

test('the schema is the vendor Cordis recognises', () => {
  assert.equal(Config['~standard'].vendor, 'schemastery');
});

test('the schema exposes the node shape the manager projects', () => {
  assert.equal(Config.type, 'object');
  assert.equal(typeof Config.dict, 'object');
  for (const [field, node] of Object.entries(Config.dict)) {
    assert.equal(typeof node?.type, 'string', `${field} must project a type`);
    assert.equal(node.meta.volatile, true, `${field} must stay volatile`);
  }
});

test('every field explains itself in the manager', () => {
  for (const [field, node] of Object.entries(Config.dict)) {
    assert.equal(typeof node.meta?.description, 'string', `${field} needs a description`);
    assert.ok(node.meta.description.length > 4, `${field}'s description must be readable`);
  }
});

console.log(`\n${passed} checks passed`);
