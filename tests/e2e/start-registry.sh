#!/usr/bin/env bash
# Recreates the E2E database, then serves the Contract Registry (apps/registry-go)
# against it, in its own "registry" schema.
set -euo pipefail

cd "$(dirname "$0")"
root="$(cd ../.. && pwd)"

"$root/node_modules/.bin/tsx" create-db.ts

export DATABASE_URL="${E2E_DATABASE_URL:-postgres://modura:modura@localhost:${MODURA_PG_PORT:-55433}/modura_e2e?sslmode=disable}"
export MODURA_MIGRATIONS_DIR="$root/apps/registry-go/migrations"
export MODURA_COMMANDS_PER_MIN=0
export MODURA_PUBLISHER_TOKEN="${E2E_PUBLISHER_TOKEN:-e2e-publisher-secret}"
export PORT="${E2E_REGISTRY_PORT:-18082}"

go -C "$root/apps/registry-go" build -o "$root/apps/registry-go/bin/registry-api" ./cmd/registry-api
exec "$root/apps/registry-go/bin/registry-api" serve
