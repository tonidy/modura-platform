# ADR-0010: Schema engine 1.0

Status: Accepted (M6).

## Context

By the end of M5 the engine had four modules, two implementing languages and a registry, but its format was still described as experimental, validation lived in two hand-written places, and the only evidence that TypeScript and Go agreed was 38 hand-written cases. Freezing the engine as 1.0 means writing down what is promised and proving it mechanically.

## Decisions

**One JSON Schema, two validators.** `docs/spec/ir.schema.json` (JSON Schema 2020-12) describes the IR 1.0 document. TypeScript validates with ajv, Go with santhosh-tekuri/jsonschema, both against the same file (Go embeds a copy that `go generate` refreshes and a stale check guards). What a schema cannot express (references resolve, no reference cycles, declared permissions and errors, object payloads, subscriptions) is listed once in the IR spec and implemented in both. `tests/ir-fixtures` has 4 valid and 19 invalid documents that both must judge identically.

**Reference cycles are invalid.** Designing the fixtures showed that a published document could contain a type that reaches itself. The DSL cannot produce one, but the compatibility check and generators would recurse forever on it. Both validators now reject cycles.

**Canonical hash, defined and shared.** The compact form is `JSON.stringify` with keys sorted by code point and integers only. Go has its own encoder for it, because `encoding/json` escapes HTML characters and U+2028/U+2029 differently. `tests/ir-fixtures/hashes.json`, written by TypeScript, must match Go for every valid fixture and for the real generated IR, and `modura publish` checks the hash the registry returns.

**Versions.** `irVersion` is `1.0.0`. The registry accepts any 1.x document: a newer minor may only add optional members, which a 1.0 reader ignores; a reader of its own minor rejects unknown members. `0.2.0` stays readable for releases stored before the freeze but cannot be published.

**Events in the IR.** Added before the freeze (plan M6) because the reports service in M7 needs them: `events` and `subscribes` per module, payloads compared like outputs, consumers required to ignore unknown fields. Payload schemas become OpenAPI components marked `x-modura-event`, which needed `skip-prune` in the `oapi-codegen` config so Go keeps their types.

**Change severities.** Every change is `breaking` (wire), `source` (generated code only, such as a renamed named type, or an operation output switching between inline and named) or `safe`. `source` changes need a version bump like `breaking` ones, because the generated SDK is an artifact people build against. A version that goes down is a violation. Safe changes without a minor bump produce a warning. The registry's `Change` type switched from `breaking: boolean` to `severity`, a breaking change to its own contract, released as `registry` 0.2.0; it was the first real use of the new rules.

**Compiler hardening.** Enum values must be lower snake case. Contract names that would collide after a generator transforms them (operation names plus the suffixes the generators and `oapi-codegen` add, event payload names, named types) and names reserved by the SDK runtime or OpenAPI are compile errors. A warnings channel reports unused permissions and unused domain errors, and `generate --strict` (used by `pnpm verify`) fails on them.

**Property-based tests and fuzzing.** fast-check generates valid random contracts, with generator coverage guarded by its own test (every type kind, events, subscriptions, named types, every severity). Properties: compiling is deterministic under key reordering, output validates, keys are ASCII, hashing ignores key order, `compat(x, x)` is empty, an added optional output field is never breaking, edits keep documents valid, and generators never throw and stay deterministic. A seeded script writes 400 random edited pairs whose TypeScript reports Go must reproduce exactly (`pnpm verify` runs it; 1,000 pairs with another seed also passed). Go native fuzz targets for `ir.Parse` and `compat.Check` run for 10 seconds each in `pnpm verify`; 30-second runs executed 224,000 and 716,000 inputs without a failure.

## Deviation from the plan

The plan asked for a warning about unreferenced named types. The compiler cannot see them: named types reach it only through references, so an unused `defineType` never arrives. That warning is dropped rather than faked; a module-level list of declared types could make it possible later.

## Consequences

- The IR, the canonical hash and the compatibility rules can now be implemented in a third language and checked against the same fixtures without reading TypeScript.
- `pnpm verify` takes about 30 seconds longer because of parity and fuzzing. That is the price of the cross-language claim.
- The stability policy (`docs/stability.md`) now binds future changes.

## Evidence

- `packages/compiler/src/ir-fixtures.test.ts`, `apps/sales-go/internal/ir/ir_test.go`: shared IR fixtures and hash parity.
- `packages/compiler/src/compat-fixtures.test.ts`, `apps/sales-go/internal/compat/compat_test.go`: 53 shared compatibility cases.
- `scripts/compat-parity.sh`: seeded random parity.
- `packages/compiler/src/properties.test.ts`, `packages/cli/src/generators.test.ts`: properties.
- `apps/sales-go/internal/ir/fuzz_test.go`, `apps/sales-go/internal/compat/fuzz_test.go`: fuzz targets.
- `packages/compiler/src/rules.test.ts`: events, names and warnings.
