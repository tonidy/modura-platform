# Changelog

Engine packages: `@modura/schema`, `@modura/compiler`, `@modura/runtime-contracts`, `@modura/generator-openapi`, `@modura/generator-sdk-ts`, `@modura/generator-mcp`, `@modura/cli`, `@modura/sdk`, and since 1.0.0-rc.2 `@modura/mcp-server` and `@modura/module-registry`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [docs/stability.md](docs/stability.md).

## 1.0.0-rc.2 (unreleased)

The first release published to JSR. Services, for the Python reports service (plan M7, ADR-0011), a file registry (plan M8, ADR-0012), and the split of the platform from the POS (plan M9, ADR-0013).

### Added

- Every package is published to JSR under `@modura`, from a Deno workspace, under the MIT licence.
- `@modura/cli/main` and `@modura/mcp-server/main` entry points, because JSR packages have no `bin` entries.
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
