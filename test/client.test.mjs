/**
 * Execute the client half against a stub environment.
 *
 * There is no browser control in this environment, so the panel cannot be
 * rendered. What *can* be checked without one is everything up to rendering:
 * the factory body runs, the stylesheet is mounted through one `data-plugin`
 * style element inside an effect, and both slot registrations carry the options
 * the host expects. A throw anywhere in those steps is exactly the failure that
 * would leave the sidebar entry missing.
 *
 * Run: node test/client.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

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

/** Minimal React stand-in: enough for module evaluation, no rendering. */
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  Component: class Component {
    /** @param {object} props - props. */
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  },
};

/** Style elements the module appended, in order. */
const styleTags = [];
/** Settings namespaces the client half asked to follow. */
const servedNamespaces = [];
/** Head stand-in that records appended style tags. */
const documentStub = {
  head: {
    /** @param {object} tag - the appended element. */
    appendChild(tag) {
      styleTags.push(tag);
    },
  },
  /**
   * Create an element stand-in.
   * @param {string} tagName - the element name.
   * @returns {object} a minimal element.
   */
  createElement(tagName) {
    return {
      tagName,
      dataset: {},
      textContent: '',
      /** Remove this element from the recorded tags. */
      remove() {
        const index = styleTags.indexOf(this);
        if (index >= 0) styleTags.splice(index, 1);
      },
    };
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { style: { setProperty: () => {} } },
};

/** Slot registrations captured from `apply`. */
const registrations = [];
/** Locale registrations captured from `apply`. */
const locales = [];
/** Effects registered through `ctx.effect`. */
const effects = [];

const ctx = {
  effect: (callback, label) => {
    const disposer = callback();
    effects.push({ label, disposer });
    return () => {
      if (typeof disposer === 'function') disposer();
    };
  },
  on: () => () => {},
  get: () => undefined,
  slots: {
    inject: (slot, callback) => {
      callback();
      return () => {};
    },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

/**
 * Cordis refuses to hand out a service the calling plugin did not inject —
 * `cannot get property "locale" without inject`. That refusal used to abort
 * `apply` on its first line, so the slot registrations never ran and the sidebar
 * entry never appeared, with nothing reported anywhere. Installing these as
 * accessors reproduces the refusal, so a missing inject entry fails this test
 * instead of failing silently in the browser.
 *
 * @param {string[]} injected - the service names the module declared.
 */
function installServiceGuards(injected) {
  Object.defineProperty(ctx, 'locale', {
    configurable: true,
    get() {
      if (!injected.includes('locale')) throw new Error('cannot get property "locale" without inject');
      return {
        register: (ns, dictionaries) => {
          locales.push({ ns, dictionaries });
          return () => {};
        },
        /** @param {string} ns - namespace. @returns {Function} a translator. */
        bind: (ns) => (key) => {
          const table = locales.find((entry) => entry.ns === ns);
          return table?.dictionaries?.zh?.[key] ?? key;
        },
      };
    },
  });
  Object.defineProperty(ctx, 'slots', {
    configurable: true,
    get() {
      if (!injected.includes('slots')) throw new Error('cannot get property "slots" without inject');
      return {
        inject: (slot, callback) => {
          callback();
          return () => {};
        },
        register: (options, component) => {
          registrations.push({ options, component });
          return () => {};
        },
      };
    },
  });
  Object.defineProperty(ctx, 'configForms', {
    configurable: true,
    get() {
      if (!injected.includes('configForms')) throw new Error('cannot get property "configForms" without inject');
      return {
        // The real service registers the page only once the namespace is
        // served; the stub serves it at once so the registration is observable.
        whileServed: (namespaces, register) => {
          servedNamespaces.push(...namespaces);
          const off = register(new Set(namespaces));
          return typeof off === 'function' ? off : () => {};
        },
      };
    },
  });
}

// The module is written for the browser module loader; provide just enough of
// the surrounding globals for the factory and `apply` to run.
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    /**
     * Capture the registered module.
     * @param {{ id: string, factory: Function }} definition - the module definition.
     */
    load(definition) {
      loaded = definition;
    },
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = documentStub;
globalThis.setTimeout = globalThis.setTimeout;
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

console.log('client module');

test('the module registers itself under the package name', () => {
  // eslint-disable-next-line no-new-func -- the source is a browser script, not an ES module
  new Function('window', source)(globalThis.window);
  assert.notEqual(loaded, null, 'window.__ModuleLoader__.load must be called');
  assert.equal(loaded.id, '@muyunet/dsh-dashboard');
  assert.equal(typeof loaded.factory, 'function');
});

/** Records the specifiers the module asked the static table for. */
const requiredSpecifiers = [];

/**
 * The shipped atoms the module resolves from the module system's static table.
 * Stubs are enough here: these checks assert which components the page builds,
 * not how they paint.
 */
const primitivesStub = {
  /** @param {object} props - forwarded. @returns {object} the element. */
  Input: (props) => ({ type: 'input', props }),
  /** @param {object} props - `value`, `options`, `onChange`. @returns {object} the element. */
  SegmentedControl: (props) => ({ type: 'segmented', props }),
  /** @param {object} props - `state`, `labels`, `onSave`. @returns {object} the element. */
  SettingsForm: (props) => ({ type: 'form', props }),
};

const module = loaded.factory((specifier) => {
  requiredSpecifiers.push(specifier);
  if (specifier === 'react') return React;
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
  throw new Error(`unexpected require of ${specifier}`);
});

test('the factory declares every service it touches', () => {
  assert.equal(typeof module.apply, 'function');
  assert.ok(Array.isArray(module.inject), 'inject must be an array');
  // `apply` reads both `ctx.slots` and `ctx.locale`; Cordis refuses an
  // un-injected service, so a missing name here breaks registration.
  for (const service of ['slots', 'locale']) {
    assert.ok(module.inject.includes(service), `the module must inject "${service}"`);
  }
});

test('apply works when every declared service is available', () => {
  installServiceGuards(module.inject);
  assert.doesNotThrow(() => module.apply(ctx));
});

test('apply still registers the panel when ctx.locale is refused', () => {
  // The realistic failure: `slots` is declared, `locale` is not. Cordis throws
  // on the locale access, and the slot registrations must survive it — that is
  // exactly the bug that hid the sidebar entry.
  registrations.length = 0;
  installServiceGuards(['slots']);
  const errors = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => module.apply(ctx));
  } finally {
    console.error = errors;
  }
  assert.ok(
    registrations.some((item) => item.options.name === 'sidebar.panellist'),
    'the sidebar entry must register even when ctx.locale is refused',
  );
  assert.ok(
    registrations.some((item) => item.options.name === 'main'),
    'the main panel must register even when ctx.locale is refused',
  );
  installServiceGuards(module.inject);
});

test('apply mounts one stylesheet through an owned effect', () => {
  registrations.length = 0;
  styleTags.length = 0;
  module.apply(ctx);
  assert.equal(styleTags.length, 1, 'exactly one stylesheet');
  assert.equal(styleTags[0].dataset.plugin, '@muyunet/dsh-dashboard');
  assert.ok(styleTags[0].textContent.includes('.dshd-root'), 'the stylesheet carries the panel rules');
});

test('apply registers both locale dictionaries', () => {
  const entry = locales.find((item) => item.ns === 'usage-dashboard');
  assert.notEqual(entry, undefined, 'the namespace must be registered');
  assert.equal(typeof entry.dictionaries.zh.panel, 'string');
  assert.equal(typeof entry.dictionaries.en.panel, 'string');
  const zhKeys = Object.keys(entry.dictionaries.zh).sort();
  const enKeys = Object.keys(entry.dictionaries.en).sort();
  assert.deepEqual(enKeys, zhKeys, 'both dictionaries must define the same keys');
});

test('the sidebar entry is registered beneath Plugins and addresses the panel', () => {
  const panel = registrations.find((item) => item.options.name === 'sidebar.panellist');
  assert.notEqual(panel, undefined, 'sidebar.panellist must be registered');
  assert.equal(panel.options.id, 'dashboard');
  assert.equal(panel.options.order, 1);
  assert.equal(panel.options.locale, 'usage-dashboard');
  assert.equal(typeof panel.options.label, 'function');
  assert.equal(panel.options.label(), '数据看板', 'the label resolves through the locale thunk');
  assert.equal(typeof panel.component, 'function', 'the icon component must be a function');
});

test('the main panel is registered under the same key', () => {
  const main = registrations.find((item) => item.options.name === 'main');
  assert.notEqual(main, undefined, 'main must be registered');
  assert.equal(main.options.key, 'dashboard', 'the key must equal the sidebar entry id');
  assert.equal(main.options.locale, 'usage-dashboard');
  assert.equal(typeof main.component, 'function');
});

test('the icon renders an svg that inherits the theme colour', () => {
  const panel = registrations.find((item) => item.options.name === 'sidebar.panellist');
  const element = panel.component({ size: 18, active: true });
  assert.equal(element.type, 'svg');
  assert.equal(element.props.stroke, 'currentColor');
  assert.equal(element.props.width, 18);
});

test('the configuration page registers under the key the Plugins page dispatches', () => {
  // dsh keys a row's configuration page by `<package name>#<row id>`, and the
  // settings namespace is the row id — so the client has to follow exactly the
  // id this bundle's patch declares, not the panel id.
  // Earlier checks in this file call `apply` more than once, so this asserts the
  // invariant across every call rather than a single-entry list.
  assert.ok(servedNamespaces.length > 0, 'the page must follow the row settings namespace');
  assert.ok(
    servedNamespaces.every((ns) => ns === 'usage-dashboard'),
    `the followed namespace must be the row id, saw ${JSON.stringify(servedNamespaces)}`,
  );
  const page = registrations.find((item) => item.options.name === 'plugins.row.config');
  assert.notEqual(page, undefined, 'without this occupant the row page shows no configuration');
  assert.equal(page.options.key, '@muyunet/dsh-dashboard#usage-dashboard');
  assert.equal(typeof page.component, 'function');
});

test('the configuration page renders both views the owner asks for', () => {
  const page = registrations.find((item) => item.options.name === 'plugins.row.config');
  const summary = page.component({ view: 'summary' });
  assert.notEqual(summary, undefined, 'the summary view must render something');
  // `page` renders the form; without a live form it must still not throw.
  const body = page.component({ view: 'page' });
  assert.notEqual(body, undefined, 'the page view must render');
  const empty = page.component({ view: 'page', form: { state: { value: { budgetTotal: 100 }, writable: true, revision: 1 }, mutate: () => true } });
  assert.notEqual(empty, undefined, 'a form with values must render');
});

/**
 * Collect every element in a rendered tree that satisfies a predicate.
 *
 * The React stand-in above keeps children on the element rather than inside
 * `props`, so this walks `children` directly.
 *
 * @param {unknown} node - an element, an array of them, or a leaf.
 * @param {(element: object) => boolean} match - the predicate.
 * @param {object[]} [found] - accumulator.
 * @returns {object[]} the matching elements.
 */
function collect(node, match, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, match, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;
  if (node.type !== undefined && match(node)) found.push(node);
  collect(node.children, match, found);
  return found;
}

test('the configuration page builds the shipped controls, not raw elements', () => {
  // The whole point of the page is that it looks like a dsh settings page: the
  // frame, the inputs and the choice controls all come from the atom package.
  assert.ok(
    requiredSpecifiers.includes('@deepseek-ai/dsh-client-ui-primitives'),
    'the page must resolve the shipped atoms from the static table',
  );
  const page = registrations.find((item) => item.options.name === 'plugins.row.config');
  const body = page.component({
    view: 'page',
    form: { state: { value: { currency: 'CNY', refreshHours: 12 }, writable: true, revision: 1 }, mutate: () => true },
  });
  assert.equal(body.type, primitivesStub.SettingsForm, 'the frame is the shipped SettingsForm');
  const segmented = collect(body, (element) => element.type === primitivesStub.SegmentedControl);
  const inputs = collect(body, (element) => element.type === primitivesStub.Input);
  assert.ok(segmented.length >= 4, `bounded fields must be choices, saw ${segmented.length}`);
  assert.ok(inputs.length >= 5, `free fields stay inputs, saw ${inputs.length}`);
  const raw = collect(body, (element) => element.type === 'input' || element.type === 'select' || element.type === 'textarea');
  assert.equal(raw.length, 0, 'no raw element may stand in for a shipped atom');
});

test('a choice field keeps a value the page did not offer', () => {
  // A value from the patch layer must stay selectable: a control showing nothing
  // selected would invite the next save to overwrite an untouched setting.
  const page = registrations.find((item) => item.options.name === 'plugins.row.config');
  const body = page.component({
    view: 'page',
    form: { state: { value: { currency: 'SGD' }, writable: true, revision: 1 }, mutate: () => true },
  });
  const currency = collect(body, (element) => element.props?.id === 'dshd-currency')[0];
  assert.notEqual(currency, undefined, 'the currency field must be a segmented control');
  assert.ok(
    currency.props.options.some((option) => option.value === 'SGD'),
    'an unknown value must be kept as an option rather than silently dropped',
  );
});


test('keeping the stylesheet is owned by an effect, so disposal removes it', () => {
  // Later applies in this file each mount their own tag; disposal must remove
  // exactly the one its effect created.
  const lastEffect = [...effects].reverse().find((entry) => String(entry.label).includes('stylesheet'));
  assert.notEqual(lastEffect, undefined, 'the stylesheet must be registered inside ctx.effect');
  assert.equal(typeof lastEffect.disposer, 'function', 'the effect must return a disposer');
  const before = styleTags.length;
  assert.ok(before > 0, 'at least one stylesheet is mounted');
  lastEffect.disposer();
  assert.equal(styleTags.length, before - 1, 'disposal must remove exactly one stylesheet');
});

console.log(`\n${passed} checks passed`);
