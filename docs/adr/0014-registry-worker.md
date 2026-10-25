# ADR-0014: Contract Registry on Cloudflare Workers

Status: Accepted.

## Context

The Go registry (ADR-0008) needs a host that runs a Go binary and a Postgres database. Free hosting for that is hard to find. Cloudflare Workers has a free plan with SQLite-backed Durable Objects, and [celld](https://celld.dev) runs the same Worker code on machines we own, so one implementation covers both a free hosted option and self-hosting.

## Decision

We add `apps/registry-worker`, a TypeScript Worker that serves the same HTTP contract as the Go service. The Go service stays.

- **Same contract, same answers.** Routes, error codes, messages, `details`, the `Idempotent-Replayed` header and the order of checks (rate limit, token, permission, input schema) match `apps/registry-go`. One HTTP suite, `tests/registry-conformance`, runs against both: the Worker in workerd and the Go service as a process with its own database. The Worker's own tests cover only its rate limiting.
- **One Durable Object holds everything.** Releases and idempotency keys live in its SQLite storage. A Durable Object handles one event at a time and `publish()` never awaits, so publishes are serial without an advisory lock. `STALE_BASE` and idempotent replay keep their meaning. `IDEMPOTENCY_IN_PROGRESS` cannot happen, because no other request can see a key half-claimed.
- **Append-only is still enforced by the database.** Triggers reject `UPDATE` and `DELETE` on `contract_releases`.
- **The rules come from `@modura/compiler`**, not a third port. The file registry (ADR-0012) already uses the TypeScript validator and compatibility check, and the shared fixtures keep them in line with Go.
- **Schemas are compiled ahead of time.** Workers forbid `new Function`, which Ajv uses to compile a schema. `scripts/generate.ts` writes standalone validators for the IR schema and the operation inputs, and `validateIr` now accepts precompiled checks. `generate-check` fails on stale output.
- **Rate limiting lives in the Durable Object**, as an in-memory token bucket. Like the Go limiter, it resets when the object restarts. The bucket is per client IP only when the IP comes from a header a proxy overwrites: `CF-Connecting-IP` on Cloudflare's edge (`request.cf.colo` is set), or the header named in `MODURA_CLIENT_IP_HEADER`. Without one, as on celld, commands are limited per identity after the token check. A forged header then gains nothing, and a caller without a token cannot use up the publisher's bucket.
- **Only Wrangler keys celld accepts** go in `wrangler.jsonc`, so no `routes` and no rate-limiting binding.

## Alternatives considered

- **D1 instead of a Durable Object.** D1 has no lock or serial transaction across the read-check-insert of a publish. We would rely on the primary key to catch the race, and idempotency would need its own retry logic. The Durable Object gives serial execution for free.
- **Go compiled to WebAssembly in the Worker.** It would reuse the Go code, but it still needs a storage port, and a TinyGo or Go WASM build is a bigger bundle and a less common toolchain than the TypeScript already in the repo.
- **Replacing the Go service.** Teams that already run Postgres keep a working option, and the Go port is the second implementation that the shared fixtures check against.

## Consequences

- Every read also goes through the one Durable Object. That is fine for registry traffic. If reads ever need to scale, they can move to a cache in front.
- There are now two server implementations to keep in step. The conformance suite fails when their answers differ, but it covers what both share: rate limiting is configured differently in each and stays in their own tests.
- We ran the registry under `celld dev` (celld 0.6.3): the CLI publishes and checks compatibility against it, the edge cases behave as on workerd, and releases survive a restart. We have not run a multi-node celld fleet.
- celld does not give a Worker the client's address. Behind celld, a per-IP limit needs `MODURA_CLIENT_IP_HEADER` and a load balancer that overwrites that header. Without it, the limit falls back to per identity, which we checked under `celld dev`.
