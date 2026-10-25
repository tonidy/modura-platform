# ADR-0013: Platform and POS in separate repositories

Status: Accepted (M9). Publishing to JSR is superseded by [ADR-0015](0015-npm-only.md): the platform is on npm only.

## Context

Until M8 one repository held the contract platform and the point-of-sale application built on it. That made every change easy to test end to end, but it also meant nothing showed the platform working for anyone but its author: the POS imported unpublished sources through `workspace:*`, platform tests used POS modules as fixtures, the POS Go service hosted the platform's registry, and the generated POS client lived inside the platform's SDK package.

## Decision

The platform stays in `modura`; the POS moves to `modura-pos` and consumes the platform the way any other team would.

**What each repository owns.**

- `modura`: the DSL, compiler, generators, CLI, the SDK transport runtime, the MCP server, the registry module and its Go service (`apps/registry-go`, with the Go IR parser and compatibility port), the IR specification and its fixtures, TypeScript/Go parity and fuzzing, and `examples/calculator`, a small runnable project whose contract the platform's tests use as their fixture. (During the split the tests used frozen copies of the POS modules, `examples/pos`, which the calculator replaced.)
- `modura-pos`: the catalog, inventory, sales and reports modules, the generated POS client (`packages/pos-sdk`), the Go sales service, the Python reports service, the cashier UI, the database migrations and seed, the browser E2E suite, the schema-change demo, and everything for deploying the demo.

**Untangle first, split second.** The restructuring happened while both halves were still in one repository, so every test ran throughout: the SDK runtime and the POS client became separate packages, the registry became its own service with its own Postgres schema, and the platform's tests stopped importing POS modules. Only then did files move.

**History is kept on both sides.** `modura-pos` was built with `git filter-repo`, keeping the POS paths and their earlier locations, so `git log --follow` on a POS file reaches back to the milestone that created it. `modura` removed the POS in one commit and keeps its full history.

**Published packages, not paths.** The platform is published to JSR as `@modura/*` from a Deno workspace (one `deno.json` per package; JSR generates JavaScript and type declarations for npm clients, which Node needs because it refuses to strip types inside `node_modules`). The POS declares the platform by version and, until the first release is out, maps those versions to `../modura` through pnpm overrides in one place. Switching to JSR is mechanical: the overrides go, and the version specifiers take pnpm's `jsr:` form. JSR has no `bin` entries, so the CLI and the MCP server are exported as `@modura/cli/main` and `@modura/mcp-server/main`, and a consumer runs them through a two-line wrapper.

**The registry is a platform service.** It runs as `apps/registry-go` with its data in a `registry` schema, so it can share a database with an application without sharing tables. The POS dropped its `contract_releases` table in a new migration rather than by editing old ones.

**Release histories restart at the split.** Both repositories keep a file registry (ADR-0012), but neither can continue the combined history: removing a module is always breaking (ADR-0002), so the platform could not publish a release without the POS modules, nor the POS one without `registry`. Each repository therefore starts at release 1 with its own contract. This is the only time a release file was removed. The combined release stays readable in `modura`'s git history.

**Two remotes per repository.** Each local repository has an internal remote for testing and a public one for the portfolio, with the same history (plan M9). JSR is published from the public platform repository, so the provenance link points at source anyone can read.

## Consequences

- The POS can only use a platform change after a release, which is the point: compatibility promises (`docs/stability.md`) are now tested by a real consumer.
- Changes that touch both repositories need a release in between, or a local override while they are being made.
- Go is not published. The POS Go service uses no platform Go code since the registry moved; the contract middleware is copied between the two Go services until a shared library is worth its upkeep.
- `deno publish` runs with `--no-check`: `tsc` already type-checks every package, and Deno cannot read the types of `@modelcontextprotocol/sdk` subpaths (its `./*` export maps `types.js` to `types.js.d.ts`). JSR's slow-types check still runs.

## Evidence

- `apps/registry-go`: the registry's own tests against Postgres, its E2E (`tests/e2e/registry.spec.ts`), and the Go side of TS/Go parity and fuzzing.
- `deno publish --dry-run` in CI for every platform package.
- `git log --follow apps/sales-go/internal/store/sales.go` in `modura-pos`.
- `contracts/releases/000001.json` in both repositories, each with only its own modules.
