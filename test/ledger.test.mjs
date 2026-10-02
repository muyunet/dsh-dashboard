/**
 * Cross-check the ledger against an independent scan of the session logs.
 *
 * The ledger walks Zstandard frames, extracts usage and folds it into
 * day/model/bucket aggregates. This test re-derives the same totals by hand
 * from the same artifacts, which is the only check that covers the whole chain:
 * frame scanning, event extraction, folding, and idempotence.
 *
 * Run: node test/ledger.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ledger, dshHome, usageFromEvent } from '../lib/ledger.js';
import { DEFAULT_PRICES, beijingParts } from '../lib/pricing.js';
import { readJsonlLines, zstdAvailable } from '../lib/zstd.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.join(here, '.tmp');

if (!zstdAvailable()) {
  console.log('SKIP: this runtime has no Zstandard decoder, so session logs cannot be read.');
  process.exit(0);
}

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

/**
 * Independently total the tokens in every session artifact.
 * @returns {{ tokens: number, calls: number, sessions: number, byDay: Map<string, number> }}
 *   the hand-counted totals.
 */
function independentScan() {
  const root = path.join(dshHome(), 'sessions');
  const result = { tokens: 0, calls: 0, sessions: 0, byDay: new Map() };
  if (!fs.existsSync(root)) return result;
  for (const workspaceDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!workspaceDir.isDirectory()) continue;
    const workspacePath = path.join(root, workspaceDir.name);
    for (const sessionDir of fs.readdirSync(workspacePath, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue;
      const sessionPath = path.join(workspacePath, sessionDir.name);
      const artifact = fs.readdirSync(sessionPath).find((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name));
      if (artifact === undefined) continue;
      result.sessions += 1;
      const { lines } = readJsonlLines(fs.readFileSync(path.join(sessionPath, artifact)), artifact.endsWith('.zstd'));
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const call = usageFromEvent(event);
        if (call === null) continue;
        const tokens = call.tokens.in + call.tokens.out;
        result.tokens += tokens;
        result.calls += 1;
        const day = beijingParts(call.time).dateKey;
        result.byDay.set(day, (result.byDay.get(day) ?? 0) + tokens);
      }
    }
  }
  return result;
}

/**
 * Total the tokens the ledger folded.
 * @param {Ledger} ledger - the ledger under test.
 * @returns {{ tokens: number, calls: number, byDay: Map<string, number> }} the folded totals.
 */
function ledgerScan(ledger) {
  const result = { tokens: 0, calls: 0, byDay: new Map() };
  for (const [dateKey, day] of Object.entries(ledger.snapshot().days)) {
    let dayTokens = 0;
    for (const buckets of Object.values(day)) {
      for (const entry of Object.values(buckets)) {
        dayTokens += (entry.in ?? 0) + (entry.out ?? 0);
        result.calls += entry.calls ?? 0;
      }
    }
    result.tokens += dayTokens;
    result.byDay.set(dateKey, dayTokens);
  }
  return result;
}

const ledger = new Ledger({ directory: scratch, pricing: () => ({ holidays: [], windows: undefined }) });
ledger.load();
const report = ledger.backfill(Date.now());
const independent = independentScan();
const folded = ledgerScan(ledger);

console.log(`sessions read      : ${report.sessions}`);
console.log(`calls (independent): ${independent.calls}`);
console.log(`tokens (independent): ${independent.tokens}`);
console.log(`calls (ledger)     : ${folded.calls}`);
console.log(`tokens (ledger)    : ${folded.tokens}`);

assert.equal(report.sessions, independent.sessions, 'every session artifact must be read');
assert.equal(folded.tokens, independent.tokens, 'the folded token total must equal the independent scan');
assert.equal(folded.calls, independent.calls, 'the folded call count must equal the independent scan');
assert.deepEqual([...folded.byDay.entries()].sort(), [...independent.byDay.entries()].sort(), 'per-day token totals must match');

// Idempotence: the high-water mark must make a second pass a no-op.
const before = ledgerScan(ledger);
ledger.backfill(Date.now());
const after = ledgerScan(ledger);
assert.equal(after.tokens, before.tokens, 'a second backfill must not double count');
assert.equal(after.calls, before.calls, 'a second backfill must not double count');

// Pricing must be reproducible from the folded counts.
const { days, unknownModels } = ledger.dailyTotals(DEFAULT_PRICES, 'deepseek-flash');
let cost = 0;
for (const day of days.values()) cost += day.cost;
console.log(`billable cost      : ${cost.toFixed(4)} CNY`);
console.log(`unknown models     : ${unknownModels.length === 0 ? 'none' : unknownModels.join(', ')}`);
console.log(`days in ledger     : ${days.size}`);

// The three prompt-side buckets are disjoint, so a day's billed prompt is
// their sum and the cache-hit share can never exceed 1. Accumulating only the
// uncached bucket here once produced a share of 9500%.
for (const [dateKey, day] of days) {
  const buckets = ledger.snapshot().days[dateKey];
  let billed = 0;
  let cacheRead = 0;
  for (const models of Object.values(buckets)) {
    for (const entry of Object.values(models)) {
      billed += (entry.in ?? 0) + (entry.cr ?? 0) + (entry.cw ?? 0);
      cacheRead += entry.cr ?? 0;
    }
  }
  assert.equal(day.input, billed, `${dateKey}: the billed prompt must sum all three buckets`);
  assert.equal(day.cacheRead, cacheRead, `${dateKey}: the cached bucket must be reported as-is`);
  if (day.cacheHitRate !== null) {
    assert.ok(day.cacheHitRate >= 0 && day.cacheHitRate <= 1, `${dateKey}: cache hit share ${day.cacheHitRate} is outside 0..1`);
    assert.equal(Number(day.cacheHitRate.toFixed(9)), Number((cacheRead / billed).toFixed(9)), `${dateKey}: hit share must match the independent arithmetic`);
  }
}
console.log(`cache hit share    : ${[...days.values()].map((day) => (day.cacheHitRate === null ? 'n/a' : `${(day.cacheHitRate * 100).toFixed(2)}%`)).join(', ')}`);

fs.rmSync(scratch, { recursive: true, force: true });
console.log('\nledger cross-check passed (independent scan == folded totals, idempotent, hit share <= 1)');
