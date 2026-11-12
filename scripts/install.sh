#!/bin/sh
# Installs the Kiro side of ki-deck and, from the repository, the Stream Deck plugin.
# Safe to re-run: unchanged files are skipped, changed ones are backed up first.
#
#   scripts/install.sh [--yes] [--dry-run] [--gate shell,write,mcp] [--skip-plugin] [--dev]
#
# The work happens in scripts/install.mjs (Node built-ins only), which a packaged plugin's
# one-click setup also runs, with Stream Deck's own Node. This wrapper only finds Node.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "macOS only for now (MULTIOS.md has the plan for Windows)"
command -v node >/dev/null 2>&1 || die "Node.js not found: install Node.js 24 or later (https://nodejs.org), then run this again"
exec node "$REPO/scripts/install.mjs" "$@"
