#!/usr/bin/env bash
# Fails if a file `go generate` produces is stale: the oapi-codegen output for the
# current generated/openapi/registry-go.json, or the embedded copy of the IR schema.
set -euo pipefail

cd "$(dirname "$0")/.."

fresh="$(mktemp)"
trap 'rm -f "$fresh"' EXIT
stale=0

go tool oapi-codegen -config oapi-codegen.yaml -o "$fresh" ../../generated/openapi/registry-go.json
if ! cmp -s "$fresh" internal/api/api.gen.go; then
  echo "apps/registry-go/internal/api/api.gen.go is stale." >&2
  stale=1
fi

if ! cmp -s ../../packages/compiler/src/ir.schema.json internal/ir/ir.schema.json; then
  echo "apps/registry-go/internal/ir/ir.schema.json differs from packages/compiler/src/ir.schema.json." >&2
  stale=1
fi

if [ "$stale" -ne 0 ]; then
  echo "Run \`pnpm generate\` and commit the result." >&2
  exit 1
fi
echo "Go generated files are up to date."
