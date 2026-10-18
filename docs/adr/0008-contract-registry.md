# ADR-0008: Contract Registry

Status: Accepted (M5).

## Context

Until M5, `modura compat` compared the contract with a git ref. That works inside one repository, but the question a team actually asks is "is this compatible with what clients are using?", and the answer belongs to a service, not to a branch. Building that service as a Modura module also dogfoods the platform: Modura's CLI talks to it through the SDK Modura generates.

## Decision

A `registry` module, written in the DSL and served by the existing Go service, with three operations: `publishRelease` (command, idempotent), `listReleases` and `getRelease` (queries, exposed to MCP).

**Release model.**

- A release is one whole IR document with a sequential number. Modules keep their own semver inside it; there is no per-module release number.
- Releases are append-only. A trigger rejects `UPDATE` and `DELETE`, and the nightly demo reset does not touch the table.
- The IR is stored as canonical compact JSON in a `json` column (not `jsonb`), so the exact hashed bytes come back out. `irSha256` is the SHA-256 of those bytes; canonical means object keys sorted, so client formatting does not matter.
- No application-level compression (gzip) or archiving (tar). Postgres already compresses large values transparently (TOAST): the first release is 10,789 bytes of JSON and 3,395 bytes on disk with `pglz`, against 2,987 bytes for gzip. Compressing in the application would save a few hundred bytes per release while making the column opaque to SQL and forcing a decompression step before the hash can be checked or the exact bytes returned. tar does not apply at all: a release is one document. If releases ever grow large or numerous, a migration can switch the column to `lz4` (`ALTER TABLE contract_releases ALTER COLUMN ir SET COMPRESSION lz4`). Tarballs belong to package distribution (section 13 of the plan), built from a release, not to how the registry stores it.

**The server owns compatibility.** `publishRelease` parses the document strictly (`INVALID_IR` for unknown fields, unsupported `irVersion`, dangling references), then runs the ADR-0002 rules against the latest release in Go. Unversioned breaking changes are rejected with `INCOMPATIBLE_CHANGE`, and the details list the changes and violations. The CLI runs the same check first as a preview, but only the server decides.

**Two implementations, one behavior.** The rules exist in TypeScript (`packages/compiler`) and Go (`internal/compat`). The TypeScript side writes `tests/compat-fixtures/fixtures.jsonl` (38 cases covering every row of the ADR-0002 table, both directions, and the version rules), and the Go test demands an identical report for each, line for line. A test also fails if the fixture file is stale. This is the first piece of the provider conformance idea from the plan.

**Concurrency.** A publish states `basedOn`, the release it was compared against. Inside the transaction an advisory lock (keyed on the schema) makes publishes strictly serial, which also covers the very first release when there is no row to lock. If the latest release is not `basedOn`, the publish fails with `STALE_BASE` and the publisher compares again.

**Idempotency.** The same claim-first protocol as checkout (ADR-0004), refactored into shared helpers. A retried publish replays the stored release. Rejections roll back the claim, so a fixed retry can reuse the key.

**Identical documents.** Publishing a document identical to the latest release is rejected with `NOTHING_TO_PUBLISH`, so release numbers always mean a change.

**Permissions.** `registry.read` for cashier, viewer and publisher; `registry.write` only for the publisher, whose token comes from `MODURA_PUBLISHER_TOKEN` and is a real secret. Without it there is no publisher at all, which is how the public demo runs.

## Alternatives considered

- Per-module releases. More flexible, but every consumer would have to assemble a consistent set of module versions. One document per release is what generators consume anyway.
- Trusting a compatibility report computed by the CLI. Simpler, but any client could skip it.
- Calling the TypeScript checker from Go (a Node sidecar or WASM). It avoids the port, but adds a runtime to the service. The shared fixtures make two implementations safe, and they are useful evidence in their own right.
- Accepting identical documents as a no-op success. Rejected so that a release number never names "nothing changed".

## Evidence

- `apps/sales-go/internal/compat/compat_test.go`: Go matches TypeScript on all shared fixtures. It was checked by flipping one Go rule: two fixtures failed.
- `apps/sales-go/internal/httpapi/registry_test.go`: lifecycle, server-side rejection of an unversioned breaking change, `STALE_BASE` under two concurrent publishes, idempotent replay, authorization and IR validation.
- `tests/e2e/registry.spec.ts`: `modura publish` against the running service.
