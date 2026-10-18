# ADR-0007: DSL v0.2 and the opaque `json` type

Status: Accepted (M5).

## Context

Dogfooding the registry (plan M5) needed an operation whose input is a whole IR document. The DSL had no way to say that. Two gaps showed up:

- There was no type for "any JSON value".
- The IR's own shape is recursive (an object field can hold an object, an array can hold arrays), and the DSL has no recursive named types, so the IR cannot be described precisely in itself.

This is the kind of finding dogfooding exists for.

## Decision

Add one built-in type, `t.json()`, meaning any JSON value passed through unchecked:

| Surface | Mapping |
|---|---|
| IR | `{ "kind": "json" }`. `irVersion` moves to `0.2.0`. |
| OpenAPI and MCP JSON Schema | An empty schema (`{}`, plus the description), which accepts any value. |
| TypeScript SDK | `JsonValue`, a recursive union of JSON types, declared in the SDK runtime. |
| Go (`oapi-codegen`) | `interface{}`; the registry handler re-marshals it to bytes and parses those strictly. |
| Compatibility check | Same as any kind: changing to or from `json` is a type change, so breaking. A `json` field has no constraints to compare. |

Recursive named types are not added. They would touch the compiler (cycle handling), every generator, and the compatibility checker (which would need cycle-safe comparison), for exactly one consumer. The registry validates the document it receives with a strict Go parser instead (`internal/ir`), so the precision moves from the contract to the provider.

## Consequences

- The contract for `registry.publishRelease` says less than it could: clients learn "send JSON", not "send an IR document". The `INVALID_IR` domain error covers what the type cannot.
- `t.json()` is an escape hatch. It is documented as a last resort; a real type is preferred whenever one fits.
- Bumping `irVersion` changed the checked-in IR and the SDK header, which is how a format change should look in review.

## Evidence

- `modules/registry/src/index.ts`: the only use of `t.json()`.
- `tests/compat-fixtures/fixtures.jsonl`: case "output type changed to json".
- `apps/sales-go/internal/httpapi/registry_test.go`: `INVALID_IR` for a wrong version, a dangling type reference and a non-object document.
