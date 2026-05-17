#!/usr/bin/env bash
# sync-from-main.sh
#
# Mirrors the scraper-relevant lib files from the main RotDotRocks repo into
# this standalone scraper repo. Run this AFTER you fix a scraper bug in
# RotDotRocks so the EC2 cron picks up the fix on its next `git pull`.
#
# Usage:
#   ./scripts/sync-from-main.sh                # default: assumes ../RotDotRocks
#   ./scripts/sync-from-main.sh /path/to/repo  # custom path
#
# After running, review the diff with `git diff`, commit, push, then on EC2:
#   cd /opt/rotrocks-scraper && git pull
#
# IMPORTANT: NEVER edit the copied files directly in this repo — make changes
# in RotDotRocks and re-sync. The main repo's admin UI uses the same files,
# so divergence between the two will cause "works in admin UI but breaks in
# cron" (or vice versa) bugs that are painful to debug.

set -euo pipefail

DEFAULT_MAIN_REPO="$(cd "$(dirname "$0")/../.." && pwd)/RotDotRocks"
MAIN_REPO="${1:-$DEFAULT_MAIN_REPO}"

if [[ ! -d "$MAIN_REPO" ]]; then
  echo "Error: main repo not found at $MAIN_REPO" >&2
  echo "Pass the path as an argument: ./scripts/sync-from-main.sh /path/to/RotDotRocks" >&2
  exit 1
fi

if [[ ! -f "$MAIN_REPO/lib/price-fetcher.ts" ]]; then
  echo "Error: $MAIN_REPO doesn't look like the RotDotRocks repo (no lib/price-fetcher.ts)" >&2
  exit 1
fi

THIS_REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$THIS_REPO/src/lib"

FILES=(
  price-fetcher.ts
  apply-snapshots.ts
  bulk-write.ts
  demand-calculator.ts
  value-interpolation.ts
  value-state.ts
)

echo "Syncing lib files from $MAIN_REPO → $DEST"
echo

for f in "${FILES[@]}"; do
  src="$MAIN_REPO/lib/$f"
  dst="$DEST/$f"
  if [[ ! -f "$src" ]]; then
    echo "  WARN: $src does not exist, skipping"
    continue
  fi
  if cmp -s "$src" "$dst" 2>/dev/null; then
    echo "  unchanged: $f"
  else
    cp "$src" "$dst"
    echo "  updated:   $f"
  fi
done

echo
echo "Done. Review changes with: git diff src/lib/"
echo "Then commit + push, and on EC2: cd /opt/rotrocks-scraper && git pull"
