# ADR-0001: Why Modura instead of TypeSpec, Smithy or Protobuf/buf

Status: Accepted (end of M1). Revisit if the stop condition below is triggered later.

## Context

Modura needs one contract that produces OpenAPI, a TypeScript SDK, Go server interfaces and MCP tool definitions. Mature tools already do most of that, so building another one needs a reason that holds up.

## Options

**TypeSpec.** A TypeScript-flavored contract language from Microsoft with a good OpenAPI emitter and support for custom decorators and emitters. It is the closest fit. Permission and MCP metadata could be custom decorators, and a custom emitter could produce MCP tools.

**Smithy.** AWS's model language. Its traits already cover authorization, idempotency tokens and read-only operations, and it generates strong SDKs. The toolchain is JVM-based and heavy for a solo TypeScript and Go project.

**Protobuf with buf.** Excellent for RPC, with real breaking-change detection (`buf breaking`). It is a weaker fit for an HTTP/JSON product, and money, error categories and permissions would all be conventions layered on top.

## Decision

Own a small canonical JSON IR and author it with a TypeScript DSL. Generators read only the IR.

The experiment is about IR semantics, not syntax:

- Permissions are required metadata, and the compiler rejects an operation without one.
- AI exposure rules are compile errors: a command cannot be exposed to MCP in v1.
- Platform errors are derived from traits, so every surface agrees on what an operation can return.

Owning the IR makes those rules cheap to enforce and easy to show in a test. There is also a learning goal here, and it is stated openly rather than dressed up as a technical necessity.

## Consequences

- Modura reimplements things other tools do better, such as breaking-change detection and docs generation. v1 keeps those minimal.
- The DSL is ergonomic for TypeScript authors only. That is acceptable because the IR, not the DSL, is the contract.

## Stop condition

Switch the authoring front end to TypeSpec, keeping the IR and generators, if either is true at the end of M1:

- The DSL and compiler have taken more than three weeks of the schedule.
- A TypeSpec decorator set plus a custom emitter could produce the same IR in under a week.

## Review at the end of M1

The first condition did not trigger. The DSL, compiler, compatibility check, three generators and the CLI were all finished inside the M0 and M1 windows. Together they are about 1,400 lines of TypeScript (schema 180, compiler with compatibility check 600, generators 420, CLI 160), plus tests.

The second condition was judged, not measured with a spike. TypeSpec could carry `requires` and `expose.mcp` as custom decorators, and an emitter could produce the same JSON. The parts that would take the most work there are the ones Modura gets nearly for free by owning the IR: rejecting rule violations at compile time (every operation needs a permission, commands never reach MCP), materializing implied platform errors, and the input/output-aware compatibility rules in ADR-0002. Those would become a TypeSpec linter plus emitter logic, which is unlikely to fit in a week for someone new to the TypeSpec compiler API.

Decision stands. One lesson from M1: `oapi-codegen` and kin-openapi turned out to be the right place to stop building. The Go side reuses them instead of a Modura-specific Go generator, and request validation in Go comes straight from the generated OpenAPI.

## Evidence

- `packages/compiler/src/compile.test.ts`: compile-time rules, including "reports every rule violation in one run".
- `packages/compiler/src/compat.test.ts`: compatibility rules.
- `generated/`: the IR, OpenAPI and MCP output, regenerated and checked on every CI run.
- `apps/sales-go/internal/httpapi/contract_test.go`: the Go service validated against the generated contract.
