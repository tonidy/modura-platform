# Modura

A contract-first platform for business services. Operations are defined once in a TypeScript DSL, compiled to a canonical JSON IR, and turned into an OpenAPI document per service, a typed TypeScript SDK, Go server interfaces (through `oapi-codegen`), Python models (through `datamodel-code-generator`) and read-only MCP tools. A compatibility checker, implemented in TypeScript and Go and proven equal, refuses releases that break clients without a version bump.

The platform is built and tested against a real application: a point-of-sale system with a Go sales service, a Python reports service fed by a transactional outbox, and a React till. It lives in its own repository, [modura-pos](https://github.com/tonidy/modura-pos), and uses the platform only through published packages ([ADR-0013](docs/adr/0013-split-platform-and-pos.md)).

## Using it

The packages are on npm as `@modura/*`, currently `1.0.0-rc.4`, published with provenance from GitHub Actions. See [docs/stability.md](docs/stability.md) for the versioning policy and [npm publishing](docs/npm-publishing.md) for release setup.

```sh
pnpm add -D @modura/cli @modura/schema
```

```ts
// modura.config.ts
import type { ModuraConfig } from '@modura/cli';
import { orders } from './modules/orders';

const config: ModuraConfig = {
  modules: [orders],
  api: { title: 'Orders API', version: '0.1.0' },
  services: { 'orders-go': { modules: ['orders'], openapi: 'generated/openapi/orders-go.json' } },
  registry: 'file:contracts/releases',
  outputs: { ir: 'generated/ir/modura.ir.json', mcp: 'generated/mcp/tools.json', sdk: 'packages/sdk/src/generated.ts' },
};

export default config;
```

```sh
modura generate                          # IR, OpenAPI per service, SDK, MCP tools; refuses unversioned breaks
modura compat --against main             # compare with the contract at a git ref
modura publish                           # add a release to the registry (files or server)
modura registry list                     # the newest releases, one line each
modura registry verify --since main      # check a file registry is append-only and valid
```

`@modura/cli` installs the `modura` command, and `@modura/mcp-server` installs `modura-mcp` (both since `1.0.0-rc.4`). Run them through package scripts or `pnpm exec`. `modura.config.ts` is loaded by Node's own type stripping, so no TypeScript loader is needed.

## What is in the box

| Package | What it does |
|---|---|
| `@modura/schema` | The DSL: `defineModule`, `defineType`, `t.*` ([spec](docs/spec/dsl.md)) |
| `@modura/compiler` | Validation, lowering to IR 1.0, canonical JSON and hashing, the compatibility check, and the IR JSON Schema ([IR 1.0](docs/spec/ir-1.0.md)) |
| `@modura/generator-openapi`, `-sdk-ts`, `-mcp` | One OpenAPI document per service, a typed client that routes each call to its service, read-only MCP tools |
| `@modura/sdk` | The handwritten transport runtime that generated clients use |
| `@modura/cli` | `generate`, `compat`, `publish`, `registry list`, `registry verify` |
| `@modura/mcp-server` | Serves generated MCP tools over stdio through the SDK, read-only by construction ([ADR-0009](docs/adr/0009-mcp-server.md)) |
| `@modura/module-registry` | The Contract Registry's own contract, written in the DSL |

## The Contract Registry

Releases of a contract can live in a registry service or in files committed to git, with the same commands and the same rules.

- **Server**: [`apps/registry-go`](apps/registry-go), a Go service generated from the registry module. The server, not the client, decides whether a release is allowed: it rejects unversioned breaking changes with `registry.INCOMPATIBLE_CHANGE`, and two publishers racing from the same base get one release and one `STALE_BASE` ([ADR-0008](docs/adr/0008-contract-registry.md)).
- **Worker**: [`apps/registry-worker`](apps/registry-worker), the same service and contract as a Cloudflare Worker with a SQLite-backed Durable Object. It needs no database server, so it runs on the Workers Free plan or on a self-hosted [celld](https://celld.dev) fleet ([ADR-0014](docs/adr/0014-registry-worker.md)).
- **Files**: one canonical JSON file per release. Git provides history and concurrency (two branches publishing the next release conflict on merge), and `registry verify --since` in CI catches gaps, edits and releases that skip the rules ([ADR-0012](docs/adr/0012-file-registry.md)). This repository keeps its own history in [`contracts/releases`](contracts/releases).

```sh
MODURA_PUBLISHER_TOKEN=[secret] pnpm registry            # registry service on :8081
MODURA_REGISTRY_TOKEN=[secret] pnpm modura publish --registry http://localhost:8081
pnpm modura compat --against registry --registry http://localhost:8081
```

The compatibility rules exist in TypeScript and in Go. Both run the same 53 shared fixtures and 400 seeded random contract pairs and must agree line for line, and the Go side is fuzzed ([ADR-0010](docs/adr/0010-schema-engine-1.0.md)).

## What is shipped and what is not

Nothing is listed as shipped unless a command, a test or a file proves it.

| Shipped | Evidence |
|---|---|
| DSL, compiler with compile-time rules, canonical IR 1.0 with a JSON Schema | [`packages/compiler`](packages/compiler), [IR 1.0](docs/spec/ir-1.0.md) |
| Breaking-change detection that blocks unversioned breaks, with change severities | [rules](docs/adr/0002-canonical-ir.md#compatibility-rules), [`compat.ts`](packages/compiler/src/compat.ts) |
| OpenAPI, TypeScript SDK and read-only MCP tool generators, one OpenAPI per service | [`packages/generator-*`](packages), property tests in [`generators.test.ts`](packages/cli/src/generators.test.ts) |
| TypeScript and Go agree on IR validity, canonical hashes and compatibility reports | [`tests/ir-fixtures`](tests/ir-fixtures), [`tests/compat-fixtures`](tests/compat-fixtures), [`scripts/compat-parity.sh`](scripts/compat-parity.sh) |
| Property-based tests and fuzzing for the engine | [`properties.test.ts`](packages/compiler/src/properties.test.ts), Go fuzz targets in `apps/registry-go/internal/{ir,compat}` |
| Contract Registry service with server-side compatibility, idempotent publishing and optimistic concurrency | [`registry_test.go`](apps/registry-go/internal/httpapi/registry_test.go), [`tests/e2e/registry.spec.ts`](tests/e2e/registry.spec.ts) |
| The Go service and the Worker answer the registry's HTTP contract identically | [`tests/registry-conformance`](tests/registry-conformance), run against both in CI |
| File registry, verified append-only, with the same rules as the server | [`file-registry.test.ts`](packages/cli/src/file-registry.test.ts), [`contracts/releases`](contracts/releases) |
| Read-only MCP server over stdio | [`apps/mcp-server`](apps/mcp-server) |
| Packages on npm with provenance, published from a tag | [`publish-npm.yml`](.github/workflows/publish-npm.yml), [npm publishing](docs/npm-publishing.md) |
| A real consumer in its own repository | [modura-pos](https://github.com/tonidy/modura-pos) |

| Not shipped | Status |
|---|---|
| JSR packages | Dropped for npm ([ADR-0015](docs/adr/0015-npm-only.md)); Deno and Bun read npm packages |
| A shared Go runtime library (contract middleware) | Copied between Go services until it is worth a library |
| DevHub, CEL policies, workflows, dynamic fields, a second storage adapter | Post-v1 |


## Development

Requirements: Node 26 and pnpm 12 (pinned in `mise.toml`), Go 1.27, and Docker or Podman with Compose for Postgres.

```sh
pnpm install
pnpm db:up         # Postgres on localhost:55433, for the registry service's tests
pnpm verify        # typecheck, lint, unit and property tests, registry tests against Postgres,
                   # stale-artifact and registry checks, TypeScript/Go random parity, short Go fuzzing
pnpm e2e           # the registry end to end: CLI publish, file registry, MCP client
pnpm generate      # regenerate after a change to the registry contract or the generators
```

Without a database the Go tests are skipped locally; CI sets `MODURA_REQUIRE_DB=1`, which makes them fail instead.

For Claude Code or Claude Desktop, the MCP server with this repository's registry tools:

```json
{
  "mcpServers": {
    "modura-registry": {
      "command": "pnpm",
      "args": ["-s", "--dir", "/path/to/modura", "--filter", "@modura/mcp-server", "start"],
      "env": { "MODURA_SERVICE_URLS": "{\"registry-go\":\"http://localhost:8081\"}" }
    }
  }
}
```

## Layout

```text
packages/schema               DSL types and builders
packages/compiler             validation, lowering, canonical JSON, compatibility check, IR JSON Schema
packages/generator-*          OpenAPI, TypeScript SDK and MCP generators
packages/sdk                  transport runtime for generated clients
packages/cli                  `modura generate`, `compat`, `publish`, `registry list`, `registry verify`
packages/runtime-contracts    canonical error contract
modules/registry              the Contract Registry's contract, in the DSL
apps/registry-go              the registry service, with the Go IR parser and compatibility port
apps/registry-worker          the registry service as a Cloudflare Worker (also runs on celld)
apps/mcp-server               read-only MCP server over stdio
examples/calculator           a runnable example: a calculator CLI on a two-module contract, also the tests' fixture
generated/                    this repository's generated IR, OpenAPI and MCP tools (the registry)
contracts/releases            this repository's release history (file registry)
tests/ir-fixtures             IR documents both validators must judge identically
tests/compat-fixtures         compatibility cases both checkers must report identically
tests/e2e                     the registry end to end
tests/registry-conformance    one HTTP suite, run against the Go service and the Worker
docs/                         plan, spec, stability policy, ADRs
```

## Decisions

- [ADR-0001](docs/adr/0001-why-modura.md) Why Modura instead of TypeSpec, Smithy or Protobuf/buf
- [ADR-0002](docs/adr/0002-canonical-ir.md) Canonical JSON IR, operation traits, HTTP mapping and compatibility
- [ADR-0003](docs/adr/0003-canonical-error-model.md) Canonical error model
- [ADR-0005](docs/adr/0005-generated-sdk-boundary.md) Generated SDK boundary
- [ADR-0007](docs/adr/0007-dsl-json-type.md) DSL v0.2 and the opaque `json` type
- [ADR-0008](docs/adr/0008-contract-registry.md) Contract Registry
- [ADR-0009](docs/adr/0009-mcp-server.md) MCP server boundary
- [ADR-0010](docs/adr/0010-schema-engine-1.0.md) Schema engine 1.0
- [ADR-0012](docs/adr/0012-file-registry.md) File registry: release history in git
- [ADR-0013](docs/adr/0013-split-platform-and-pos.md) Platform and POS in separate repositories
- [ADR-0014](docs/adr/0014-registry-worker.md) Contract Registry on Cloudflare Workers
- [ADR-0015](docs/adr/0015-npm-only.md) Publish to npm only

ADR-0004 (checkout idempotency), ADR-0006 (money) and ADR-0011 (reports service and outbox) are about the POS and live in [modura-pos](https://github.com/tonidy/modura-pos).
