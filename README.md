# @muyunet/dsh-dashboard

A **data dashboard** panel for the dsh web client: a random greeting, a
GitHub-style heatmap of daily token usage, a peak/off-peak indicator with a live
clock, day/week/month token and spend totals, and the remaining account balance.
Every card can be moved, resized and hidden, and the layout survives a reload.

It appears in the sidebar directly beneath **Plugins**.

<!-- A screenshot belongs here. Drop one in and replace this comment. -->

## Requirements

| | |
|---|---|
| dsh | **0.2.0-rc.2** — the version this was built and tested against. Nothing else has been tried. |
| Dependencies | **none** |
| Build step | **none** |

The plugin imports nothing outside Node's builtins and its own `vendor/`
directory, so it can be installed straight from git with no install script. The
two packages it needs are inlined; see [`vendor/README.md`](vendor/README.md) for
why that is load-bearing rather than tidiness.

## Install

```sh
dsh plugin --profile <profile> add github:muyunet/dsh-dashboard
```

Then enable the bundle. Or do it from the UI: **Plugins** page → **Add** → paste
`github:muyunet/dsh-dashboard`, then switch the bundle on.

Check what the install reported: `applied` means it is live, `restart-required`
means restart dsh so the browser loads the new client module, and
`failed` / `overridden` means diagnose before assuming anything works.

The host half is verifiable without a browser — it serves one JSON document:

```sh
curl -s http://127.0.0.1:19387/usage-dashboard/snapshot | head -c 400
```

## Using it

| | |
|---|---|
| Move a card | Drag it by its header while **edit** mode is on. |
| Resize | Drag the bottom-right handle. |
| Hide / show | The eye toggle in edit mode; hidden cards keep their place. |
| Reset | Export / import the layout as JSON from the toolbar. |
| Configure | **Plugins** → this package → its row. The settings form is there, not in the panel. |

## Data sources

| What | Source | Live? |
|---|---|---|
| Greeting | `v1.hitokoto.cn`, then its international mirror, then a built-in list | yes, per "换一条" |
| Balance | `ctx.deepseekAccount.getBalance()` — the Platform wallets, queried live | yes, every 60s |
| Balance fallback | `GET api.deepseek.com/user/balance` with the same stored grant | best-effort, independent endpoint |
| Pricing + peak windows | the official pricing document | every 12h, else built-in |
| Token usage and spend | **this machine's session logs** | after every model call |

### Why there are two balance paths

dsh reads the wallets from the Platform's `/api/v0/users/get_user_summary` and
validates the payload against `{ normal_wallets: [...], bonus_wallets: [...] }`.
Its `readAccountDetail` folds **every** failure — a network error and a payload
that fails that schema alike — into `{ status: 'failed' }`, and its own account
section renders "View on Platform" when that happens, so `getBalance()` failing
is not by itself evidence of anything. There is no other shipped method to copy:
`dsh-api-account-controller`'s `getBalance` is a one-line forward to the same
service.

What this plugin can do is repeat the very same request and read it leniently.
`resolveToken` issues the stored grant only for the inference origin, and that
grant is the one dsh sends to the Platform, so the fallback asks for it there and
uses it against `{platform-origin}/api/v0/users/get_user_summary` with the same
five client headers `platformClientHeaders` builds — and with the grant in
**`x-dsh-auth-token`**, the header dsh's own `accountHeaders` uses. A bearer
header is the *API* spelling and the Platform rejects it, so a fallback using
Authorization would fail even on a working network. The response is scanned for
any array of `{ currency, balance }` pairs rather than two exact key names, so a
shape dsh refuses still yields a balance. A second fallback tries the public
API's `GET /user/balance`, where Authorization *is* correct.

An account can carry wallets in both CNY and USD, and the first one listed is not
necessarily the one holding money — reporting it produced a confident `$0.00` for
an account whose CNY wallet was not empty. The non-empty wallet wins; ties and
all-empty accounts fall back to CNY, the currency this deployment bills in.

When none of them yields a figure the card stays in budget mode and the reason
records **why**, naming the payload keys that actually arrived or the transport
message — so a failure is a report rather than a shrug. `test/balance.test.mjs`
drives the whole path against a stubbed fetch, including a summary whose keys dsh
would reject.

Both paths failing leaves the card in budget mode, where it still reports the
month's spend from the ledger and names the missing figure instead of showing a
bare dash.

**There is no official usage API.** The published endpoints are Chat
Completions, Responses, FIM, Lists Models, Get User Balance and Files — none
reports token totals. Usage therefore comes from the session artifacts under
`$DSH_HOME/sessions`, which carry `data.usage` on every `assistant/message`
event. That is more precise than an endpoint would be, but it only covers
sessions on this machine, and it cannot see session-title LLM calls (those
events carry no usage).

## Pricing and peak hours

Built-in prices, CNY per million tokens, from the official pricing page:

| Model | cache hit off | cache hit peak | cache miss off | cache miss peak | output off | output peak |
|---|---|---|---|---|---|---|
| `deepseek-flash` | 0.02 | 0.04 | 1 | 2 | 4 | 8 |
| `deepseek-v4-pro` | 0.15 | 0.30 | 4.5 | 9.0 | 13.5 | 27.0 |

Peak hours are **Beijing time (UTC+8), Monday to Friday, 09:00–12:00 and
14:00–18:00, excluding Chinese statutory holidays**; everything else is
off-peak, and the off-peak price is exactly half the peak price.

Because the official wording says "Monday to Friday", a weekend make-up workday
is still billed as off-peak.

### How a call is billed

The three prompt-side buckets are **disjoint**, which the harness states
directly — `billedInputTokens(usage) = uncachedInputTokens + cacheReadTokens +
cacheWriteTokens` — and a real logged call confirms: `{ inputTokens: 298,
outputTokens: 289, cacheReadTokens: 13056, totalTokens: 13643 }` sums exactly to
`totalTokens`.

So `inputTokens` is **already the uncached part** and is billed at the miss
rate; the cached bucket is billed at the hit rate on top of it:

```
cost = (inputTokens·missPrice + cacheReadTokens·hitPrice
        + cacheWriteTokens·missPrice + outputTokens·outputPrice) / 1e6
```

Subtracting `cacheReadTokens` from `inputTokens` — the obvious-looking mistake —
bills the prompt at zero whenever a call is mostly cache hits, and makes the
cache-hit share exceed 100%. The share is measured against all three buckets,
so it stays within `0..1`.

Because the ledger stores raw token buckets rather than money, correcting the
formula reprices the whole history on the next read; no migration is needed.

### How the live pricing document is used

The parser refuses anything it is unsure about, because a wrong price is worse
than a stale one. It reads the twelve prices in page order and accepts them only
when every model has six sane prices and each off-peak price is exactly half its
peak price. A document that is truncated before its table, or that breaks that
identity, is discarded and the built-in table stays in use. The Today card always
shows which source is in force.

Set `Config.holidays` to make the holiday exclusion exact — the default is an
empty list, and the Peak card says so rather than guessing dates.

## Configuration

Every setting below has a default, so an empty or absent `config` behaves exactly
like the built-in defaults and can never fail an activation.

**Where the form lives.** Plugins page → this bundle's package → its row. That
row's page carries the form. Two separate pieces have to exist for it to appear,
and having only one produces a page that silently shows nothing:

1. The fields must be marked **`volatile()`** in the schema. dsh builds a
   settings page only from fields a schema marks volatile — `volatileForm` walks
   the node tree and returns nothing when no leaf has it — so a plain schema
   validates perfectly and renders no configuration anywhere.
2. The client half must register an occupant of the **`plugins.row.config`**
   slot, keyed `<package name>#<row id>`. The host schema alone creates the
   settings namespace but no page.

Volatile fields update the fiber's config **without re-running `apply`** — that
is what the marker is for — so every reader re-resolves from `ctx.fiber.config`
rather than closing over the value from activation, and the snapshot picks up an
edit within one cache window. A volatile field also parses into `{ get, [write] }`
rather than the value, so the host half unwraps before reading; without that,
every field would silently read as its default.

**The controls.** The page is built from dsh's own atoms — `SettingsForm` for the
frame, `Input` for free text, `SegmentedControl` for anything with a bounded set
of sensible answers — resolved from the module system's static table with
`require('@deepseek-ai/dsh-client-ui-primitives')`. Nothing is hand-rolled, so it
matches the built-in Settings pages rather than approximating them. The require is
guarded: an unavailable table falls back to plain elements instead of failing the
module, because a throw there would cost the whole client half including the
sidebar entry.

`currency`, `currencySymbol`, `balanceRefreshSeconds` and `refreshHours` are
choices rather than free text. A value that came from the patch layer instead of
this page is kept as an extra option, so a control never shows nothing selected
and invites the next save to overwrite a setting nobody touched.

Values can also be written straight into the row:

```yaml
- id: usage-dashboard
  name: '@muyunet/dsh-dashboard'
  config:
    currencySymbol: '¥'
    # Chinese statutory holidays, so peak windows exclude them.
    holidays:
      - '2026-10-01'
      - '2026-10-02'
    # Total budget, used for the remaining-balance fallback when the
    # live balance cannot be read. 0 disables budget mode.
    budgetTotal: 0
    # Spend that happened before this plugin was installed, so the budget
    # fallback starts from the right place.
    baselineCost: 0
    refreshHours: 12
    balanceRefreshSeconds: 60
    fallbackModel: deepseek-flash
    peakWindows:
      - { start: '09:00', end: '12:00' }
      - { start: '14:00', end: '18:00' }
    # Full replacement price table, same shape as the built-in one.
    prices:
      deepseek-flash:
        cacheHit: { off: 0.02, peak: 0.04 }
        cacheMiss: { off: 1, peak: 2 }
        output: { off: 4, peak: 8 }
```

`prices`, `peakWindows` and `clientVersion` are deliberately **not** in the
schema. The schema is validated before `apply` runs, and schemastery preserves
unknown keys, so they stay patch-editable without the rate card being declared in
two places that then drift apart. Everything the schema does declare matches the
default `resolveConfig` falls back to.

### Why this package has no dependencies

A workspace bundle is linked into the profile by path while its real files stay
outside it, so a specifier for a package that ships *inside* dsh's own archive
does not resolve from here. The `Config` schema and the volatile unwrapping need
two real packages, and neither can be imported from the runtime:

| Package | Version | Why |
|---|---|---|
| `@deepseek-ai/schemastery` | 3.18.4 | the `Config` schema, which must be a real schemastery schema |
| `@deepseek-ai/cosmokit` | 1.8.5 | `isVolatile`, to unwrap volatile field references |

Declaring them as ordinary dependencies works **only on the machine that wrote
them**: pnpm reads `.npmrc` from the *consuming* project, never from a dependency,
so anyone installing from git gets pnpm's default isolated layout — junctions,
which dsh's loader resolver does not follow. Their `node_modules` would be
present and the plugin would still fail to activate.

So both are inlined under [`vendor/`](vendor/README.md), byte-identical apart from
one rewritten import. That is what makes this a plain bundle with nothing to
fetch and nothing to build.

The ledger stores **token counts**, not money, so changing `prices` reprices the
whole history on the next read.

## Activation safety

`apply` **must not throw**, and it is written so that it cannot.

dsh's web boot treats any entry that has not reached the active state as fatal —
a crashed fiber and one still *waiting* for a service are both failures — and it
aborts the boot. The desktop app then rescues itself by rewriting the profile,
which costs the user their whole configuration over a bug in a dashboard. That
happened once during development, so the plugin is built the other way round:

- the whole body of `apply` runs inside one try/catch; a throw is recorded, not
  propagated, and the entry still activates;
- every registration step (`ctx.effect`, `ctx.on`, `ctx.inject`, and the route)
  is individually guarded, so one failure costs only that step — the route can be
  missing while the ledger still folds;
- the ledger read, the backfill timer, the refresh interval and the session
  listener each catch their own errors;
- **no static `inject` is declared.** Declaring `webServer` would leave the entry
  *pending* whenever the web server is absent or slow, which fails the boot just
  as surely as a crash. The route attaches through the dynamic
  `ctx.inject(['webServer'], ...)` instead, which is the pattern the shipped
  client-modules package uses.

A recorded failure is written to
`$DSH_HOME/storages/usage-dashboard/activation-error.json` and published in the
snapshot as `pluginError`, so a degraded dashboard reports *why* instead of
looking empty. `test/activation.test.mjs` drives every failure surface to prove
the contract.

Because the host module is cached per generation, edits to the plugin only take
effect after dsh restarts; a bundle disable/enable re-registers the *existing*
module instance.

## Styling

Colours come only from the harness's semantic tokens (`--dsw-alias-*`, with
`--dsw-specific-*` where a surface token is the right one); type, radii,
elevation and focus use `--dsw-font-*`, `--dsw-radius-*`, `--dsw-elevation-*` and
`--dsw-focus-ring-*`. There is not one colour literal in the plugin, and no
`data-ds-dark-theme` selector: light and dark resolve through the token layer, so
changing that layer restyles this panel with no code change here. The plugin's
own custom properties hold geometry only.

The heatmap's four intensity levels are `color-mix(in srgb, var(--dsw-alias-brand-primary) N%, transparent)`,
which is the same derivation the harness uses for its own document-selection
token.

Styles are mounted through one `<style data-plugin="@muyunet/dsh-dashboard">`
element owned by `ctx.effect`, so they are removed with the plugin.

## Ledger

`$DSH_HOME/storages/usage-dashboard/ledger.json`, written atomically (temporary
file then rename) and debounced by two seconds. Shape:

```jsonc
{
  "version": 1,
  "highWater": { "session-<id>": 542 },        // idempotence cursor per session
  "days": {
    "2026-10-02": { "deepseek-flash": {
      "peak": { "in": 0, "out": 0, "cr": 0, "cw": 0, "calls": 0 },
      "off":  { "in": 9119, "out": 140, "cr": 1920, "cw": 0, "calls": 1 } } }
  },
  "balanceSamples": [ { "t": 1790917528123, "total": 17.34 } ],
  "topUps": [ { "t": 1790917528123, "amount": 50 } ],
  "totals": { "since": 1790916967145, "calls": 329 },
  "backfill": { "done": true, "at": 1790917528123, "sessions": 2, "badFrames": 0, "error": null }
}
```

A damaged file is renamed to `ledger.json.corrupt-<timestamp>` and rebuilt. A
damaged Zstandard frame inside a session log is skipped and counted in
`backfill.badFrames` instead of aborting the read.

## Reading session logs

Session artifacts are a **concatenated-frame** Zstandard container: each appended
batch is its own frame, and `zstdDecompressSync` decodes only the first one and
silently ignores the rest. `lib/zstd.js` walks the frame boundaries itself
(RFC 8878 §3) and decodes each frame separately. Reading the whole file with a
single call returns the session header and no usage at all — a failure mode that
looks like "there is no data" rather than an error.

## Tests

Everything runs on plain Node — no dependencies, no install step:

```sh
for f in test/*.test.mjs; do node "$f" || exit 1; done
```

or one at a time:

```sh
node test/pricing.test.mjs     # parser, refusal cases, billing, peak windows
node test/ledger.test.mjs      # independent re-scan of real logs == folded totals
node test/discipline.test.mjs  # colour literals, conventions, packaging invariants
node test/client.test.mjs      # the client module executes and registers its slots
node test/activation.test.mjs  # apply() survives every host failure without throwing
node test/config.test.mjs      # the Config schema cannot fail an activation
node test/balance.test.mjs     # wallets survive a payload dsh's schema rejects
```

84 checks in total, plus the ledger cross-check, which needs a real
`$DSH_HOME/sessions` to have anything to compare — it passes vacuously on a
machine with no sessions yet.

`test/ledger.test.mjs` re-derives the token totals straight from the session
artifacts and asserts they equal the ledger's fold, byte for byte, that a second
backfill changes nothing, and that the cache-hit share is within `0..1` and
matches the independent arithmetic.

`test/activation.test.mjs` proves the promise that matters most: a throwing
service lookup, a throwing `effect`, a throwing `on`, a throwing `inject`
callback, a throwing route registration, all of them at once, and an unwritable
home — none of them makes `apply` throw.

`test/client.test.mjs` runs the client half against a stub `window`, `document`
and `react`, so it proves the module evaluates, mounts exactly one
`data-plugin` stylesheet inside an effect, and registers both slots with the
options the host expects. It does **not** render anything — visual behaviour is
not covered by any test. It also reproduces Cordis's refusal to hand out an
un-injected service, so a missing `inject` entry fails the suite instead of
silently costing the sidebar entry.

`test/config.test.mjs` pins the properties that keep the schema from turning a
working plugin into a failed boot entry: every field defaults, so an empty or
absent `config` validates, every field is `volatile` so dsh builds a settings page
at all, and unknown keys survive so `prices` and `peakWindows` stay
patch-editable.

`test/pricing.test.mjs` includes the cases that matter most: a document
truncated before its table, one whose prices break the half-price identity, and
one missing a model column must all be **refused**, while a consistent genuine
repricing must be accepted.

`test/discipline.test.mjs` is the packaging guard: it fails if any host file
imports something that cannot resolve from a path-linked bundle, if the manifest
gains a dependency or a lifecycle script, or if the vendored code loses its
licence.

## License

GPL-3.0-only — see [LICENSE](LICENSE).

The two packages under `vendor/` are MIT, © their authors; their licences are
kept beside them. MIT is compatible with the GPL, and the attribution is the
reason those files are there rather than copied quietly.

## Known limitations

1. **No usage API exists**, so totals cover this machine's session logs only.
2. **Session-title LLM calls are not counted** — their events carry no usage.
3. **The holiday list defaults to empty**; peak detection then assumes Monday to
   Friday. Dates are never guessed.
4. **The platform cross-check is a heuristic**: it infers spend from balance
   drops and top-ups from balance rises, so another client using the same
   account shows up here too.
5. **Pricing depends on the official page's shape.** A redesign falls back to the
   built-in table, which the Today card reports.
6. **The snapshot route has no authentication** — it is loopback-only and exposes
   aggregate figures and the balance, never credentials.
7. **A layout is stored per browser** (`localStorage`), so it does not follow you
   to another machine.
