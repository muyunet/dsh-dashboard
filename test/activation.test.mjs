/**
 * The activation contract: `apply` must never throw.
 *
 * dsh's web boot fails outright when any entry does not reach the active state,
 * and the desktop app responds by resetting the whole profile. That is exactly
 * what happened once already, so the plugin promises the opposite: every
 * registration step is individually guarded, a failure is recorded instead of
 * propagated, and the entry still activates.
 *
 * This test drives that promise through every failure the host can present:
 * a throwing service lookup, a throwing `effect`, a throwing `on`, a throwing
 * `inject` callback and a throwing route registration.
 *
 * Run: node test/activation.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate every write this test provokes, before anything reads the home path.
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dashboard-activation-'));
process.env.DSH_HOME = scratchHome;

const { apply } = await import('../index.js');

// Every case below provokes a failure on purpose, and the plugin reports each
// one on stderr as well as to disk. The disk copy is what this test asserts, so
// the console copy is muted to keep the run readable.
console.error = () => {};

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

/** The diagnostic the plugin writes when a step fails. */
const diagnosticPath = path.join(scratchHome, 'storages', 'usage-dashboard', 'activation-error.json');

/**
 * Remove the diagnostic so each case starts clean.
 */
function clearDiagnostic() {
  fs.rmSync(diagnosticPath, { force: true });
}

/**
 * Read the recorded diagnostic.
 * @returns {object | null} the parsed diagnostic, or `null`.
 */
function readDiagnostic() {
  try {
    return JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build a context stub whose individual surfaces can be made to throw.
 * @param {{ get?: boolean, effect?: boolean, on?: boolean, inject?: boolean, register?: boolean }} [fail] - which surfaces throw.
 * @returns {object} the context stub.
 */
function makeContext(fail = {}) {
  const ctx = {
    logger: { warn: () => {}, error: () => {} },
    /** @param {string} name - the service key. */
    get: (name) => {
      if (fail.get === true) throw new Error(`get(${name}) exploded`);
      return undefined;
    },
    /**
     * Mimic Cordis: the execute callback runs, and a returned value that is
     * neither a function nor nullish is rejected outright.
     * @param {Function} execute - the effect callback.
     * @param {string} label - the effect label.
     */
    effect: (execute, label) => {
      if (fail.effect === true) throw new Error('effect exploded');
      const dispose = execute();
      if (typeof dispose !== 'function' && dispose !== undefined && dispose !== null) {
        throw new TypeError('Invalid effect');
      }
      return dispose;
    },
    /** @param {string} name - the event name. */
    on: (name) => {
      if (fail.on === true) throw new Error(`on(${name}) exploded`);
      return () => {};
    },
    /**
     * Mimic Cordis: `inject` starts a child plugin whose apply is the callback.
     * @param {string[]} deps - required services.
     * @param {Function} callback - the child apply.
     */
    inject: (deps, callback) => {
      if (fail.inject === true) throw new Error('inject exploded');
      return callback({
        ...ctx,
        webServer: {
          /** @param {object} route - the route to register. */
          register: (route) => {
            if (fail.register === true) throw new Error(`register(${route.path}) exploded`);
            return () => {};
          },
        },
      });
    },
  };
  return ctx;
}

console.log('activation is failsafe');

test('a healthy context activates without recording anything', () => {
  clearDiagnostic();
  apply(makeContext(), {});
  assert.equal(readDiagnostic(), null, 'a clean activation must not write a diagnostic');
});

test('a throwing service lookup does not fail activation', () => {
  clearDiagnostic();
  assert.doesNotThrow(() => apply(makeContext({ get: true }), {}));
  const diagnostic = readDiagnostic();
  assert.notEqual(diagnostic, null, 'the failure must be recorded');
  assert.match(diagnostic.message, /exploded/);
});

test('a throwing effect does not fail activation', () => {
  clearDiagnostic();
  assert.doesNotThrow(() => apply(makeContext({ effect: true }), {}));
  assert.notEqual(readDiagnostic(), null);
});

test('a throwing listener registration does not fail activation', () => {
  clearDiagnostic();
  assert.doesNotThrow(() => apply(makeContext({ on: true }), {}));
  assert.notEqual(readDiagnostic(), null);
});

test('a throwing inject does not fail activation', () => {
  clearDiagnostic();
  assert.doesNotThrow(() => apply(makeContext({ inject: true }), {}));
  assert.notEqual(readDiagnostic(), null);
});

test('a throwing route registration does not fail activation', () => {
  clearDiagnostic();
  assert.doesNotThrow(() => apply(makeContext({ register: true }), {}));
  const diagnostic = readDiagnostic();
  assert.notEqual(diagnostic, null);
  assert.match(diagnostic.message, /register/);
});

test('every surface throwing at once still does not fail activation', () => {
  clearDiagnostic();
  assert.doesNotThrow(() => apply(makeContext({ get: true, effect: true, on: true, inject: true, register: true }), {}));
  assert.notEqual(readDiagnostic(), null);
});

test('the diagnostic carries a message, a timestamp and a stack', () => {
  clearDiagnostic();
  apply(makeContext({ effect: true }), {});
  const diagnostic = readDiagnostic();
  assert.equal(typeof diagnostic.message, 'string');
  assert.ok(diagnostic.message.length > 0);
  assert.equal(typeof diagnostic.at, 'number');
  assert.ok(Number.isFinite(diagnostic.at));
  assert.equal(typeof diagnostic.stack, 'string');
});

test('an unwritable home still does not fail activation', () => {
  // Point the home at a path that cannot be created, so the diagnostic write
  // itself fails: recording a failure must never become a second failure.
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(scratchHome, 'nul\u0000invalid');
  try {
    assert.doesNotThrow(() => apply(makeContext({ effect: true }), {}));
  } finally {
    process.env.DSH_HOME = previous;
  }
});

test('a configuration object is optional', () => {
  clearDiagnostic();
  assert.doesNotThrow(() => apply(makeContext()));
  assert.doesNotThrow(() => apply(makeContext(), undefined));
  assert.doesNotThrow(() => apply(makeContext(), null));
  assert.doesNotThrow(() => apply(makeContext(), 'not an object'));
  assert.doesNotThrow(() => apply(makeContext(), { holidays: 'wrong type', prices: 42, refreshHours: -1 }));
});

fs.rmSync(scratchHome, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
