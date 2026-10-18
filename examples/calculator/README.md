# Calculator: a Modura example

A command-line calculator built on a Modura contract, small enough to read in a few minutes. It shows the whole path: a contract in the DSL, the files Modura generates from it, and code that uses the generated client.

```sh
pnpm calc 7 / 2                    # 7 / 2 = 3 remainder 1
pnpm calc 6 x 7 --store answer     # 6 x 7 = 42, stored in the slot `answer`
pnpm calc recall answer            # answer = 42
pnpm calc tape                     # every stored result, newest first
pnpm calc 1 / 0                    # calculator.DIVISION_BY_ZERO: Cannot divide by zero.
```

Use `x` for multiplication, because the shell would expand `*`. Memory and the tape are kept in `.calculator-state.json`, or wherever `CALC_STATE` points.

## What is where

| File | What it is |
|---|---|
| [`src/modules/calculator.ts`](src/modules/calculator.ts) | The `calculator` module: `evaluate` and `recall` (queries, exposed to MCP), `store` (an idempotent command), three domain errors, an enum, and the `resultStored` event |
| [`src/modules/tape.ts`](src/modules/tape.ts) | The `tape` module, which subscribes to `calculator.resultStored` and lists what was stored |
| [`modura.config.ts`](modura.config.ts) | Both modules, one service each, where the generated files go, and the release history |
| [`contracts/releases`](contracts/releases) | The contract's published releases, one file each (Modura's file registry) |
| [`generated/`](generated) | The canonical IR, one OpenAPI document per service, and the MCP tools, written by `pnpm generate` |
| [`src/generated/client.ts`](src/generated/client.ts) | The generated TypeScript client |
| [`src/local.ts`](src/local.ts) | Both services, in-process: a `Transport` that answers calls itself instead of sending HTTP, with the event delivered as a function call |
| [`src/main.ts`](src/main.ts) | The CLI, which only talks to the generated client |

A real system would run each service as a server built from its OpenAPI document (the POS in [modura-pos](https://github.com/tonidy/modura-pos) does, in Go and Python) and pass the client an HTTP transport. The local transport keeps the example free of servers. It also trusts its input, where a server would validate every request against the contract.

## Change the contract

Add an operator, say `power`, to `Operator` in `src/modules/calculator.ts`, then:

```sh
pnpm generate     # IR, OpenAPI, client and MCP tools change together
pnpm typecheck    # src/local.ts no longer compiles: its switch does not handle `power`
```

That is the point of a generated client: the contract and the code that implements it cannot drift apart unnoticed. Removing an operator instead is a breaking change, and `pnpm generate` refuses it until the module's version is bumped.

## Release it

The contract's history lives in [`contracts/releases`](contracts/releases), in git, so the example needs no registry server. Once a change is generated and the code compiles again:

```sh
pnpm modura publish                       # writes contracts/releases/000002.json; commit it
pnpm modura compat --against registry     # is the working contract compatible with the last release?
pnpm modura registry verify               # gaps, hand edits, broken hashes (CI adds --since <base branch>)
```

`publish` applies the same rules as `generate`, against the last release rather than the last generated files. Removing `divide` without a version bump gives:

```text
Publish rejected: registry.INCOMPATIBLE_CHANGE
  The release breaks clients: calculator: breaking changes need a major version bump (minor while 0.x), but the version went 0.1.0 -> 0.1.0
```

`pnpm registry-check` runs `registry verify` and `compat --against registry`, and the platform's `pnpm verify` includes it.

The tests in [`src/local.test.ts`](src/local.test.ts) run the calculator through its generated client, and the platform's own generator tests use this contract as their fixture.
