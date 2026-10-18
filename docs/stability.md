# Stability policy

What the Modura schema engine promises from 1.0 on, and what it does not. Status: in force from `1.0.0-rc.1`; until `1.0.0` the items under "Guaranteed" may still change if the release candidate turns up a real problem, and any such change will be listed in the changelog.

## Guaranteed within 1.x

- **The DSL API** in `@modura/schema`: `t.*`, `defineType`, `defineModule`, and the shapes of `ModuleDefinition`, `OperationDefinition` and `EventDefinition`. New optional members may be added; nothing is removed or changes meaning.
- **The IR format** described in [docs/spec/ir-1.0.md](spec/ir-1.0.md) and [ir.schema.json](../packages/compiler/src/ir.schema.json). Minor versions only add optional members.
- **The canonical forms and `irSha256`.** The same document hashes the same in every 1.x release.
- **The compatibility rules** in ADR-0002 and ADR-0010: what is `breaking`, `source` or `safe`, and the version rules. A rule may become stricter only in a major release.
- **Compile errors.** A contract that compiles cleanly under 1.x keeps compiling under later 1.x releases. New warnings may appear.
- **Event semantics.** Consumers ignore unknown payload fields; producers may add optional fields in a minor version of their module.

## Not guaranteed

- Formatting, ordering or helper names inside generated code, beyond the identifiers derived from contract names (`generatedNames` in `@modura/compiler`).
- Error and warning message text. Match on behavior, not wording.
- The command-line interface's output format. Its flags follow the changelog.
- Anything under `@modura/compiler/testing`.

## Deprecation

Something guaranteed is first marked deprecated in a minor release, with a warning from the compiler or CLI and a changelog entry, and is removed no earlier than the next major release.

## How versions move

| Version | Changes when |
|---|---|
| Engine packages (`@modura/schema`, `@modura/compiler`, generators, CLI, SDK runtime) | Semver for the guarantees above. |
| `irVersion` | Minor for new optional members, major for anything else. Independent of the package versions. |
| A module's `version` | Decided by the compatibility rules for that module's contract. Independent of both. |
