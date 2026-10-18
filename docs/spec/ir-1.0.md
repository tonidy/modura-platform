# Modura IR 1.0

Status: normative for `irVersion` 1.x. The machine-readable part is [`ir.schema.json`](../../packages/compiler/src/ir.schema.json), shipped in `@modura/compiler`; this document adds what a JSON Schema cannot say. Decisions behind it are in [ADR-0010](../adr/0010-schema-engine-1.0.md).

## 1. The document

An IR document is one JSON object with four members:

| Member | Content |
|---|---|
| `irVersion` | The format version, `1.MINOR.PATCH`. |
| `modules` | Module name to module. At least one. |
| `types` | Qualified type name (`module.PascalCase`) to type node. |
| `platformErrors` | Platform error code to error definition, copied in so consumers need nothing else. |

A module has `version` (semver), `description`, `dependencies`, `permissions`, `errors`, `operations`, `events` and `subscribes`. All are always present; empty ones are `{}` or `[]`.

An operation has `kind` (`query` or `command`), `description`, `requires` (at least one qualified permission), `idempotent`, `input` (an object type), `output` (any type), `errors` (every code the operation can return, platform and qualified domain codes) and `expose` (`{ "mcp": boolean }`).

An event has `description` and `payload`, a type that is an object or resolves to one.

## 2. Type nodes

| `kind` | Members besides `kind` and optional `description` |
|---|---|
| `string` | `minLength`, `maxLength`, `pattern` (all optional) |
| `integer` | `minimum`, `maximum` (optional, safe integers) |
| `boolean`, `timestamp`, `money`, `json` | none |
| `enum` | `values`: unique, lower snake case (`^[a-z][a-z0-9_]*$`), in authored order |
| `array` | `items`, optional `minItems`, `maxItems` |
| `object` | `fields`: field name to `{ "required": boolean, "type": type }` |
| `ref` | `name`: a key of `types` |

`timestamp` is an RFC 3339 string in UTC. `money` is `{ "amountMinor": integer, "currency": ISO 4217 code }` on the wire. `json` is any JSON value; providers validate it themselves.

Names: modules, operations, permissions, events and fields are lowerCamelCase; error codes UPPER_SNAKE_CASE; type names `module.PascalCase`. All are ASCII, so every language sorts IR keys the same way.

## 3. Semantic rules

A document is valid when it matches `ir.schema.json` and also:

1. Every `ref` names a key of `types`.
2. No named type reaches itself through references, directly or through fields and array items. (A contract written in the DSL cannot express one; a published document could, and every recursive walk over types would loop.)
3. Every entry of an operation's `requires` is a permission declared by some module.
4. Every entry of an operation's `errors` is a platform error or a declared domain error (`module.CODE`).
5. Every event payload is an object type or resolves to one.
6. Every entry of a module's `subscribes` is an event declared by another module.

Both validators apply exactly these rules: `validateIr` in `@modura/compiler` and `ir.Parse` in Go. [`tests/ir-fixtures`](../../tests/ir-fixtures) holds valid and invalid documents they must judge identically.

## 4. Canonical forms

Two serializations are canonical.

**Pretty**, for files checked into a repository: object keys sorted by UTF-16 code unit, two-space indentation, a trailing newline, no `undefined`. Integer-like keys come first in numeric order, as JavaScript enumerates them (this only occurs in OpenAPI output).

**Compact**, for hashing: exactly what `JSON.stringify` produces after sorting object keys by Unicode code point (equivalently, UTF-8 byte order), with no whitespace. Only `"`, `\` and control characters are escaped; control characters other than `\b \f \n \r \t` become `\u00xx` in lowercase hex. Every number is a safe integer and is written in plain decimal. For IR names, which are ASCII, both key orders agree.

`irSha256` is the lowercase hex SHA-256 of the compact form encoded as UTF-8. The registry computes it in Go, `modura publish` in TypeScript, and [`tests/ir-fixtures/hashes.json`](../../tests/ir-fixtures/hashes.json) proves they agree, including for text with quotes, backslashes, HTML characters, control characters, emoji and U+2028.

## 5. Versions

- A newer **minor** version (`1.1.0`) may only add optional members. A 1.0 reader ignores members it does not know. A reader of exactly its own minor version rejects unknown members, so nothing is silently dropped.
- A **patch** version clarifies; it does not change the format.
- A new **major** version is a different format. 1.x readers reject it.
- `0.2.0`, the format before events existed, is still readable so releases stored before 1.0 can be compared against. New releases must use 1.x.

## 6. Events

A payload is something consumers receive, so the compatibility rules compare it like an operation output. Consumers must ignore payload fields they do not know; that is what makes adding a field safe. Delivery semantics (at least once, ordering) belong to the transport and are documented with it, not in the IR.

## 7. What the IR does not contain

HTTP paths and status codes (a generator convention, ADR-0002), storage layout, deployment topology, and implementation code. Those can change without a new IR version.
