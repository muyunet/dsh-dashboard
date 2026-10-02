/**
 * Static discipline checks for the dashboard bundle.
 *
 * These are the rules that keep the panel looking like part of the harness and
 * make it restyle itself when the token layer changes. They are cheap to state
 * and easy to break silently, so they are asserted rather than trusted.
 *
 * Run: node test/discipline.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/**
 * Read a source file.
 * @param {string} relative - path relative to the package root.
 * @returns {string} the file contents.
 */
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

/** Every source file that ships, excluding artwork. */
const SOURCES = ['index.js', 'client.js', 'lib/zstd.js', 'lib/pricing.js', 'lib/ledger.js', 'lib/sources.js'];

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

/** Offset a string index to a line number, for readable failures. */
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

console.log('colour discipline');

test('no colour literal appears in any source file', () => {
  const offenders = [];
  for (const file of SOURCES) {
    const text = read(file);
    // Hex colours, and functional colour notations. SVG artwork is exempt, and
    // these sources contain none.
    for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/g)) {
      // `#` also starts private class names; only flag six/eight/three-digit hex.
      if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(match[0])) continue;
      offenders.push(`${file}:${lineOf(text, match.index)} ${match[0]}`);
    }
    assert.deepEqual(offenders.filter((entry) => entry.startsWith(`${file}:`)), [], `${file} must contain no colour literal`);
  }
  assert.deepEqual(offenders, [], 'no source file may contain a colour literal');
  void offenders;
});

test('every --dsw-* token used is from a real family', () => {
  const allowed = /^--dsw-(?:alias|specific|font|radius|shadow|elevation|focus-ring|corner-shape|mask|menu|linear|gradient|static)-/;
  const offenders = [];
  for (const file of SOURCES) {
    const text = read(file);
    for (const match of text.matchAll(/--dsw-[a-z0-9-]+/g)) {
      if (!allowed.test(match[0])) offenders.push(`${file}:${lineOf(text, match.index)} ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'no invented --dsw-* token names');
});

test('the plugin declares no colour of its own', () => {
  const css = read('client.js');
  // Custom properties the plugin owns must not be colours: they carry geometry.
  for (const match of css.matchAll(/--dshd-[a-z-]+:\s*([^;]+);/g)) {
    const value = match[1];
    assert.ok(
      !/var\(--dsw-(?:alias|specific)-/.test(value) && !/#|rgb|hsl|color-mix/.test(value),
      `--dshd custom property must not carry a colour, found: ${match[0]}`,
    );
  }
});

console.log('harness conventions');

test('no dark-mode selector exists in the plugin', () => {
  for (const file of SOURCES) {
    assert.ok(!read(file).includes('data-ds-dark-theme'), `${file} must not branch on the dark-mode attribute`);
  }
});

test('styles are injected as one plugin-owned style element inside an effect', () => {
  const client = read('client.js');
  assert.ok(client.includes("tag.dataset.plugin = PLUGIN_ID"), 'the stylesheet must be marked with data-plugin');
  assert.ok(client.includes("ctx.effect(() => {"), 'the stylesheet must be owned by an effect');
  assert.ok(client.includes('tag.remove()'), 'the stylesheet must be removed on disposal');
});

test('the client half requires only what the static table serves', () => {
  // In the browser the module system resolves two specifiers for this plugin:
  // `react` and the shipped atoms package, both from its static table. Anything
  // else would have to come from the bundle and would fail at load.
  const allowed = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives']);
  const text = read('client.js');
  for (const match of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    assert.ok(allowed.has(match[1]), `client.js must not require ${match[1]}`);
  }
});

test('the host half imports only builtins, its own files and vendor/', () => {
  // A workspace bundle is linked into the profile by path while its real files
  // stay outside it, so a specifier for a package that ships *inside* dsh's
  // archive does not resolve from here and would fail the whole boot entry at
  // import time. Everything it needs beyond node: is inlined under vendor/.
  for (const file of ['index.js', 'lib/zstd.js', 'lib/pricing.js', 'lib/ledger.js', 'lib/sources.js']) {
    const text = read(file);
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${file} imports ${specifier}, which cannot resolve from a path-linked bundle; inline it under vendor/`,
      );
    }
  }
});

test('the package installs straight from git, with nothing to fetch or build', () => {
  // The whole point of inlining: pnpm reads .npmrc from the *consuming* project,
  // never from a dependency, so a declared dependency here would land in a layout
  // dsh's loader does not follow. Any of these fields means an install step.
  const manifest = JSON.parse(read('package.json'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(manifest[field], undefined, `${field} would require an install step; inline the code under vendor/ instead`);
  }
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
    assert.equal(manifest.scripts?.[script], undefined, `a ${script} script turns a git install into a build`);
  }
  // A vendor/ directory that nothing imports would be dead weight.
  assert.ok(read('index.js').includes("from './vendor/schemastery/index.mjs'"), 'the schema must come from vendor/');
  assert.ok(read('index.js').includes("from './vendor/cosmokit/index.js'"), 'isVolatile must come from vendor/');
});

test('vendored code keeps its upstream license', () => {
  for (const name of ['schemastery', 'cosmokit']) {
    assert.ok(read(`vendor/${name}/LICENSE`).includes('MIT License'), `vendor/${name} must carry its MIT license`);
  }
});

test('the configuration page edits exactly the fields the host schema declares', () => {
  // The page is handed values and a write queue, not a schema, so its field list
  // is written twice on purpose. This keeps the two copies honest: a field added
  // to the schema but not the page stays visible in the patch and uneditable in
  // the UI, and one added to the page alone writes a key nothing reads.
  const schema = read('index.js');
  const hostFields = [...schema.matchAll(/^ {2}(\w+): z\b/gm)].map((match) => match[1]).sort();
  assert.ok(hostFields.length >= 9, `expected the schema fields, found ${JSON.stringify(hostFields)}`);

  const client = read('client.js');
  const block = /const CONFIG_FIELDS = \[([\s\S]*?)\n    \];/.exec(client);
  assert.notEqual(block, null, 'the configuration page must declare its fields');
  const pageFields = [...block[1].matchAll(/key: '([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(pageFields, hostFields, 'the page and the schema must edit the same fields');

  for (const field of pageFields) {
    assert.ok(client.includes(`'config.${field}'`), `the label for ${field} is missing`);
    assert.ok(client.includes(`'config.${field}.hint'`), `the hint for ${field} is missing`);
  }
});

test('no iframe and no document.body writes', () => {
  const client = read('client.js');
  assert.ok(!/createElement\(\s*['"]iframe['"]/.test(client), 'no iframe');
  assert.ok(!/document\.body\.(?:append|prepend|insert)/.test(client), 'no direct document.body writes');
});

test('the sidebar entry sits directly beneath the Plugins panel', () => {
  const client = read('client.js');
  const block = /ctx\.slots\.register\(\s*\{\s*name: 'sidebar\.panellist',([\s\S]*?)\},/.exec(client);
  assert.notEqual(block, null, 'the sidebar.panellist registration must be present');
  assert.ok(/id: PANEL_ID/.test(block[1]), 'the panellist entry must carry the panel id');
  const order = /order:\s*(\d+)/.exec(block[1]);
  assert.notEqual(order, null, 'the panellist registration must declare an order');
  assert.equal(Number(order[1]), 1, 'Plugins registers 0, so 1 seats this entry directly beneath it');
  assert.ok(/locale:\s*NS/.test(block[1]), 'the panellist entry must declare its locale namespace for the label');
});

console.log('manifest');

test('the bundle manifest declares the patch, the client half and the icon', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.ok(typeof manifest.icon === 'string' && manifest.icon.endsWith('.svg'));
  assert.ok(manifest.files.includes('client.js') && manifest.files.includes('lib'));
});

test('the client module id matches the package name', () => {
  const manifest = JSON.parse(read('package.json'));
  const client = read('client.js');
  assert.ok(client.includes(`id: '${manifest.name}'`), 'the module loader id must equal the package name');
});

test('the patch inserts this package under one row id', () => {
  const patch = read('cordis.patch.yml');
  const manifest = JSON.parse(read('package.json'));
  assert.ok(patch.includes(`name: '${manifest.name}'`), 'the patch must reference the package name');
  assert.ok(/id:\s*usage-dashboard/.test(patch), 'the patch must declare the row id');
});

test('the locale metadata files carry a title and description', () => {
  for (const locale of ['zh', 'en']) {
    const meta = JSON.parse(read(`locale/${locale}.json`));
    assert.ok(typeof meta.meta.title === 'string' && meta.meta.title !== '', `${locale} needs a title`);
    assert.ok(typeof meta.meta.description === 'string' && meta.meta.description !== '', `${locale} needs a description`);
  }
});

console.log(`\n${passed} checks passed`);
