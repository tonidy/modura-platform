# ADR-0002: Canonical JSON IR, operation traits and versioning

Status: Accepted (M1). Extended by [ADR-0010](0010-schema-engine-1.0.md): IR 1.0, change severities (`breaking`, `source`, `safe`), version regressions, warnings, and event payloads, which compare like outputs.

## Context

Several generators in two languages must agree on one contract. If each generator interpreted the DSL itself, or applied its own defaults, the surfaces would drift.

## Decision

- The compiler emits one JSON document, `generated/ir/modura.ir.json`, and generators read nothing else. The CLI parses the serialized IR back before handing it to generators, so declaration order in the DSL source never leaks into generated output.
- Serialization is canonical: keys sorted by UTF-16 code unit (never locale order), two-space indent, trailing newline, no `undefined`. Integer-like keys come first in numeric order, as JavaScript enumerates them. Same input, same bytes.
- Generated files are checked in. `pnpm verify` regenerates them in memory and fails on any difference. CI also runs `pnpm generate && git diff --exit-code`.
- Every operation trait is explicit with defaults applied: `kind`, `requires`, `idempotent`, `expose.mcp`.
- Traits describe behavior, not transport. `idempotent: true` does not mention HTTP. The OpenAPI and SDK generators map it to an `Idempotency-Key` header.
- Named types are stored once under `types` with qualified names (`catalog.ProductId`) and referenced elsewhere as `{ "kind": "ref" }`.
- Each module lists its computed `dependencies`, so cross-module coupling is visible in review.
- Two version numbers: `irVersion` for the document format, and a semver `version` per module for its contract.

## HTTP mapping

HTTP paths are a generator convention, not part of the IR. Every operation is `POST /v1/{module}.{operation}` with a JSON body, in the style of Twirp and Connect. Inputs are typed objects, so there are no rules to invent for encoding nested types in URLs. The cost is that queries are not cacheable by HTTP intermediaries, which a POS does not need.

## Compatibility rules

`checkCompatibility` in the compiler compares two IR documents. In inputs, anything that rejects a request that used to be valid is breaking. In outputs, anything an existing client may not be ready to receive is breaking:

| Change | Input | Output |
|---|---|---|
| Field removed | breaking | breaking |
| Field added | breaking if required | safe |
| Optional becomes required | breaking | safe |
| Required becomes optional | safe | breaking |
| Bound narrowed (min up, max down) | breaking | safe |
| Bound widened | safe | breaking |
| Enum value added | safe | breaking |
| Enum value removed | breaking | safe |
| Pattern or type changed | breaking | breaking |

Operation-level: removing an operation or module, changing `kind`, adding a required permission and becoming idempotent are breaking. New error codes, removed permissions and MCP exposure changes are reported but safe.

A breaking change needs a major version bump of the module, or a minor bump while it is 0.x. `pnpm generate` refuses to overwrite the IR otherwise (`--allow-breaking` overrides), and CI runs `modura compat --against origin/<base>` on pull requests.

## Evidence

- `packages/compiler/src/compile.test.ts`: reordered source produces byte-identical output.
- `packages/compiler/src/compat.test.ts`: the rules above.
- `packages/cli/src/main.ts`: `generate --check` and `compat --against`.
