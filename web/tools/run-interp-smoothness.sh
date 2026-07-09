#!/usr/bin/env bash
# Run the remote-aircraft interpolation smoothness probe (#81).
# Bundles interp-smoothness.ts (which imports the real net.ts) with esbuild,
# stubbing @mochi/web so the browser-only UI chain doesn't load, then runs it
# under Node. esbuild is a transitive dep (via vite), located in the pnpm store.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)" # monorepo root
esbuild="$(find "$root/node_modules/.pnpm" -maxdepth 6 -type f -path '*/esbuild/bin/esbuild' 2>/dev/null | head -1)"
if [ -z "$esbuild" ]; then echo "esbuild not found under $root/node_modules/.pnpm" >&2; exit 1; fi
out="$(mktemp --suffix=.mjs)"
trap 'rm -f "$out"' EXIT
node "$esbuild" "$here/interp-smoothness.ts" \
  --bundle --platform=node --format=esm \
  --alias:@mochi/web="$here/mochi-web-stub.ts" \
  --outfile="$out" --log-level=error
node "$out"
