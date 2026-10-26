# Changelog

Engine packages: `@modura/schema`, `@modura/compiler`, `@modura/runtime-contracts`, `@modura/generator-openapi`, `@modura/generator-sdk-ts`, `@modura/generator-mcp`, `@modura/cli`, `@modura/sdk`, and since 1.0.0-rc.2 `@modura/mcp-server` and `@modura/module-registry`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [docs/stability.md](docs/stability.md).

## 1.0.0-rc.5 (2026-10-26)

### Added

- `modura registry list [--registry <url | file:dir>] [--limit <1-100>]` prints the newest releases, one line each: number, publish time (UTC), publisher, hash prefix and module versions. It reads a server with the viewer token, or a file registry, and lists 20 by default.

### Changed

- `@modura/cli`: every command rejects options it does not take, and options with their value missing. A typo such as `modura publish --dry-run`, or `modura publish --registry` without a target, used to publish to the default registry.

### Fixed

- `@modura/cli`: `modura --help`, `-h`, `help` and `<command> --help` print the usage and exit 0. `modura publish --help` used to publish.

## 1.0.0-rc.4 (2026-10-25)

### Added

- `validateIr(document, checks)` accepts schema checks compiled ahead of time, and `irJsonSchemas()` returns the schemas to compile. Runtimes that forbid code generation, such as Cloudflare Workers, need this (ADR-0014).
- `modura` bin in `@modura/cli` and `modura-mcp` bin in `@modura/mcp-server`, so `pnpm exec modura generate` works without a wrapper script.

### Changed

- `@modura/sdk`: a 429, 502, 503 or 504 response without a Modura error body is `UNAVAILABLE` and retryable, as gateways send these when a service is overloaded or down. It was `INTERNAL`.
- Release candidates take the `latest` dist-tag until a stable version exists, so `npm install @modura/cli` gets this release instead of rc.2. rc.3 went to `next` only.

### Fixed

- `@modura/sdk`: a 2xx response without a JSON body is an `INTERNAL` failure instead of `{ ok: true, value: undefined }`.
- `@modura/sdk`: aborting the signal while the response body is read rethrows the abort, as aborting during `fetch` already did, instead of returning a failure.

### Removed

- JSR publishing: the `deno.json` files and the Deno step in CI. The packages are published to npm only (ADR-0015).

## 1.0.0-rc.3 (2026-10-18)

The same contents as rc.2, published from `publish-npm.yml` with npm provenance. rc.2 was published without provenance.

## 1.0.0-rc.2 (2026-10-18)

The first release on npm. Services, for the Python reports service (plan M7, ADR-0011), a file registry (plan M8, ADR-0012), and the split of the platform from the POS (plan M9, ADR-0013).

### Added

- Every package is published to npm under `@modura` with JavaScript and type declarations built by `scripts/build-npm.mjs`, under the MIT licence.
- `@modura/cli/main` and `@modura/mcp-server/main` entry points, to run the CLI and the MCP server from a wrapper script.
- `ir.schema.json` ships inside `@modura/compiler` (it moved from `docs/spec`).
- File registry: `--registry file:<dir>` for `modura publish` and `modura compat --against registry`, writing one canonical JSON release file per release, with the server's rules and error codes. `registry` in `modura.config.ts` sets the default target.
- `modura registry verify [--since <git-ref>]`: checks a file registry for gaps, renamed, edited or hand-formatted files, invalid IR, and, with `--since`, changed or deleted old releases and new releases that `modura publish` would not have written.
- `services` in `modura.config.ts`: every module belongs to exactly one service, and the CLI refuses a module owned twice or by nobody. `modura generate` writes one OpenAPI document per service.
- `modules` option of `generateOpenApi`: only those modules' operations, their published and subscribed event payloads, and the named types something kept references.
- `services` option of `generateSdk` and `generateMcpTools`. Generated calls pass `service`, and MCP tools carry `_meta["modura/service"]`.
- `serviceUrls` on `createHttpTransport` and `service` on `TransportCallOptions`, so a client calls each service directly.

### Changed

- `@modura/sdk` is the transport runtime only. Generated clients import their types from it (`from '@modura/sdk'` instead of `./runtime`), so a generated client lives in the consumer's own package.
- Relative imports carry explicit `.ts` extensions, which JSR requires.
- The MCP server reads `generated/mcp/tools.json` from the working directory by default, and has no default service URLs.
- `MODURA_REGISTRY_URL` and `--registry` accept `file:<dir>` as well as a server URL.
- `generated/openapi/openapi.json` is replaced by one document per service.
- `generated/ir/modura.ir.sha256` holds the canonical hash of the generated IR, written by `modura generate`, instead of an entry in the fixture hashes.
- The registry module's exported types are annotated (`NamedType`, `ModuleDefinition`), as JSR's slow-types check requires.

## 1.0.0-rc.1

The first release candidate of schema engine 1.0 (plan M6, ADR-0010).

### Added

- IR 1.0, with a normative spec (`docs/spec/ir-1.0.md`) and a JSON Schema (`docs/spec/ir.schema.json`) shared by the TypeScript and Go validators.
- `validateIr` in `@modura/compiler`: the JSON Schema plus the semantic rules, including rejection of reference cycles.
- `irSha256` and `canonicalCompactJson`, matching the registry's Go implementation byte for byte. `modura publish` verifies the hash the registry returns.
- Events: `events` and `subscribes` on modules, with payload types in OpenAPI components (`x-modura-event`) and in the SDK.
- Change severities `breaking`, `source` and `safe`, version-regression violations, and warnings for compatible changes without a minor bump.
- `compileWithWarnings`, the `--strict` flag for `modura generate` and `modura publish`, and warnings for unused permissions and domain errors.
- Compile errors for enum values that are not lower snake case, for contract names that collide in generated code, and for names reserved by generated code.
- `@modura/compiler/testing`: fast-check arbitraries for valid contracts and IR edits.

### Changed

- `irVersion` is now `1.0.0`. IR 0.2.0 documents remain readable but cannot be published.
- `Change` (TypeScript and the registry contract) has `severity` instead of `breaking`. The `registry` module moved to 0.2.0 for it.
- `CompatibilityReport` has a `warnings` list.

## 0.2.0

Contract Registry, MCP server and the `json` type (plan M5, ADR-0007 to ADR-0009).

## 0.1.0

DSL, compiler, OpenAPI, SDK and MCP generators, and the CLI (plan M0 to M4).
