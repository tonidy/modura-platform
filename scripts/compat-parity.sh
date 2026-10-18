#!/usr/bin/env bash
# Cross-language random parity for the compatibility check (plan M6): TypeScript
# writes seeded random IR pairs with its reports, Go must produce identical ones.
#
#   bash scripts/compat-parity.sh [seed] [count]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
seed="${1:-20261011}"
count="${2:-400}"
pairs="$(mktemp --suffix=.jsonl)"
trap 'rm -f "$pairs"' EXIT

"$root/node_modules/.bin/tsx" "$root/packages/compiler/scripts/random-pairs.ts" "$pairs" "$seed" "$count"
MODURA_PARITY_FILE="$pairs" go -C "$root/apps/registry-go" test -count=1 -run '^TestRandomParity$' ./internal/compat/
