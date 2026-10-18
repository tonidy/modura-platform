# ADR-0009: MCP server boundary

Status: Accepted (M5).

## Context

Since M1 the generator has produced MCP tool definitions for read operations, but nothing served them. The plan's claim is "AI is constrained": an assistant can look, not act. That claim needs a running server and a test that tries to break it.

## Decision

`apps/mcp-server` is a small Node server on the official MCP TypeScript SDK, speaking stdio.

- It serves `generated/mcp/tools.json` as-is. Input and output schemas are the generated, fully inlined JSON Schemas, so the low-level `Server` API is used rather than one that wants Zod schemas.
- Every tool call is executed through the Modura SDK transport (`transport.call(operation, args)`). A tool call is therefore an ordinary API request: authenticated, authorized against the contract, validated and rate limited by the Go service.
- The token is the public viewer token by default (`MODURA_MCP_TOKEN`). The viewer holds `catalog.read`, `inventory.read` and `registry.read`, and nothing that writes.
- Tools are exposed only if they are marked `readOnlyHint: true`, carry a `modura/operation` and have an object input schema. Anything else in the file is refused and reported on stderr.
- Canonical Modura errors come back as MCP tool errors (`isError: true`) whose text is the same canonical error JSON as on HTTP. This settles the open question in ADR-0003.
- stdio only. MCP over HTTP is not needed for local assistants (Claude Desktop, Claude Code) and would add an authentication story of its own.

Read-only is therefore enforced in three places: the compiler rejects MCP exposure on commands, the server refuses tools not marked read-only, and the API refuses writes from the viewer token. Only the last one is a security boundary; the other two keep honest mistakes out.

## Consequences

- Adding a read operation with `expose: { mcp: true }` makes a new tool appear after `pnpm generate`, with no MCP server change.
- An AI-initiated write would need a different identity and an approval flow. That stays on the post-v1 roadmap.

## Evidence

- `apps/mcp-server/src/server.test.ts`: tool listing, call mapping, error mapping, and refusal of a tool not marked read-only.
- `tests/e2e/registry.spec.ts`: a real MCP client over stdio reads stock and contract history from the running service, and a tampered `tools.json` that relabels `sales.createSale` as read-only gets `FORBIDDEN` from the API with no sale written.
