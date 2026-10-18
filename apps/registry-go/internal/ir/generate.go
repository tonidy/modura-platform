package ir

// ir.schema.json is a copy of packages/compiler/src/ir.schema.json, the one schema both the
// TypeScript and the Go validator use. go:embed cannot reach outside the module, so
// it is copied; scripts/generate-check.sh fails if the copy is stale.
//go:generate cp ../../../../packages/compiler/src/ir.schema.json ir.schema.json
