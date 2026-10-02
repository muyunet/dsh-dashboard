# Vendored dependencies

Two packages are inlined here so this plugin resolves with **no `node_modules`
and no install step**. Both are MIT; their `LICENSE` files sit beside the code.

| Directory | Package | Version | Upstream |
|---|---|---|---|
| `schemastery/` | `@deepseek-ai/schemastery` | 3.18.4 | `vendor/schemastery` in `deepseek-ai/deepseek-harness`, published on npm |
| `cosmokit/` | `@deepseek-ai/cosmokit` | 1.8.5 | `vendor/cosmokit` in `deepseek-ai/deepseek-harness`, published on npm |

## Why they are inlined

A workspace bundle is linked into the dsh profile by path while its real files
stay outside it, so a specifier for a package that ships **inside dsh's own
archive** does not resolve from here — the plugin cannot `import` the runtime's
own copy of schemastery.

Declaring them as ordinary dependencies works only for the machine that wrote
them. pnpm reads `.npmrc` from the **consuming** project, never from a
dependency, so a consumer installing this package from git gets pnpm's default
isolated layout: junctions, which dsh's loader resolver does not follow. The
result is a plugin whose `node_modules` is present and which still fails to
activate. Inlining removes `node_modules` from the question entirely, and the
plugin becomes what the dsh plugin guide calls a Host-only bundle: no
dependencies, no install scripts, no build tool.

## What was changed

Exactly one line: schemastery's single runtime import of `@deepseek-ai/cosmokit`
now points at `../cosmokit/index.js`. Both files are otherwise byte-identical to
the published ones. `@standard-schema/spec` is a type-only dependency of
schemastery and is not needed at runtime.

## Upgrading

Copy the new `lib/index.mjs` and `lib/index.js` over these files, re-apply that
one import rewrite, and keep the versions above in step with the dsh release
being targeted. `test/config.test.mjs` exercises the vendored schema directly,
including the `volatile` marker the settings page depends on, so a broken copy
fails the suite rather than the boot.
