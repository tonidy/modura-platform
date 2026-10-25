# ADR-0015: Publish to npm only

Status: Accepted. Supersedes the JSR parts of ADR-0013.

## Context

ADR-0013 planned to publish the platform to JSR from a Deno workspace, with JSR's npm layer covering npm users. Since then we build JavaScript and declarations ourselves (`scripts/build-npm.mjs`) and publish to npm with provenance from `publish-npm.yml`. `1.0.0-rc.2` and `1.0.0-rc.3` are on npm. Nothing was ever published to JSR.

Keeping JSR meant two registries with versions in step across ten `deno.json` files, JSR's slow-types rules, a Deno step in CI, and no `bin` entries, so every consumer needed a two-line wrapper script to run the CLI.

## Decision

We publish to npm only and remove Deno from the repository.

- The `deno.json` files and the `deno publish --dry-run` CI step are gone.
- `@modura/cli` has a `modura` bin and `@modura/mcp-server` a `modura-mcp` bin. `build-npm.mjs` adds a shebang to every file a package's `bin` names.
- The calculator example runs `modura` directly instead of a wrapper script.
- Package management stays on pnpm and the runtime on Node. Consumers on Deno or Bun install the npm packages.

## Alternatives considered

- **Keep JSR as a second registry.** It adds TypeScript source publishing and generated API docs, which nobody has asked for. It can come back later without changing the packages.
- **Switch from pnpm to Bun.** The workspace, lockfile, nx and both workflows already use pnpm, and npm consumers run Node, so testing on Node tests what they run.

## Consequences

- Provenance comes from npm (`npm publish --provenance` through trusted publishing), not JSR.
- `@modura/cli/main` and `@modura/mcp-server/main` stay exported, so existing wrapper scripts keep working.
- The `bin` entries ship in the first release after `1.0.0-rc.3`.
