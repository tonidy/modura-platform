# Modura Contract Registry (Cloudflare Worker)

The Contract Registry as a Cloudflare Worker with one SQLite-backed Durable Object. It serves the same HTTP contract as [`apps/registry-go`](../registry-go) (`generated/openapi/registry-go.json`), so the CLI, the SDK and the MCP server work against either one. See [ADR-0014](../../docs/adr/0014-registry-worker.md).

It needs no database server, so it runs on the Workers Free plan. The same `wrangler.jsonc` also deploys to a self-hosted [celld](https://celld.dev) fleet.

## Run locally

```sh
pnpm --filter @modura/registry-worker dev     # wrangler dev on :8787
MODURA_REGISTRY_TOKEN=[secret] pnpm modura publish --registry http://localhost:8787
```

For a local publisher token, put `MODURA_PUBLISHER_TOKEN=...` in `apps/registry-worker/.dev.vars`.

## Deploy

To Cloudflare:

```sh
cd apps/registry-worker
npx wrangler secret put MODURA_PUBLISHER_TOKEN   # without it, publishing is off
pnpm run deploy
```

`pnpm run deploy` sets `MODURA_VERSION` to the current commit, which `GET /` reports as `{"name":"modura-registry","version":"<sha>"}`. Use `pnpm run deploy`, not `pnpm deploy`, which is a built-in pnpm command.

To celld: `celld deploy` in this folder, or `celld dev . --port 8787` to try it locally. celld bundles with esbuild, so if it isn't on your `PATH`, set `CELLD_ESBUILD=../../node_modules/.bin/esbuild`. Local state goes in `.celld/`, and `celld dev` reads `.dev.vars` too.

celld does not give the Worker the client's address, and it passes `CF-Connecting-IP` through as the client sent it. So the Worker trusts `CF-Connecting-IP` only on Cloudflare's edge (when `request.cf.colo` is set). Elsewhere, commands are limited per identity after the token check, unless you set `MODURA_CLIENT_IP_HEADER` to a header your load balancer overwrites (for example `X-Forwarded-For`).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODURA_PUBLISHER_TOKEN` | unset | Secret token with `registry.read` and `registry.write`. Unset means nobody can publish. |
| `MODURA_VIEWER_TOKEN` | `demo-viewer` | Public read token. |
| `MODURA_CASHIER_TOKEN` | `demo-cashier` | Public read token kept for the POS demo. |
| `MODURA_COMMANDS_PER_MIN` | `30` | Commands per client IP (or per identity, without a trusted IP) per minute. `0` turns the limit off. |
| `MODURA_CLIENT_IP_HEADER` | unset | Header holding the client IP, set by a proxy you trust. Unset means `CF-Connecting-IP` on Cloudflare's edge and no IP elsewhere. |

## Generated files

`src/generated/` holds the IR schema and the operation input schemas compiled ahead of time with Ajv (Workers forbid code generation at runtime), plus the operations and error catalog. `pnpm generate` rewrites them and `generate-check` fails when they are stale.
