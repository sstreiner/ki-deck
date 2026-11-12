#!/bin/sh
# Builds the handbook: the pictures in docs/handbook/img/ (drawn by the plugin's own renderers,
# scripts/make-handbook.mjs) and dist/HANDBOOK.pdf (scripts/make-handbook-pdf.mjs, printed by a
# headless Chromium). Like install.sh, this wrapper only checks what the Node scripts need first.
#
#   scripts/make-handbook.sh [--no-pdf] [--open]
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
PDF=1 OPEN=0

say() { printf '%s\n' "$*"; }
die() { printf 'make-handbook: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: scripts/make-handbook.sh [options]

  --no-pdf     Only draw the pictures (docs/handbook/img/)
  --open       Open the PDF (or, without a PDF, the HTML) when done
  --help, -h   Show this help

The PDF needs Google Chrome, Chromium, Edge or Brave, or set CHROME=/path/to/chrome.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-pdf) PDF=0 ;;
    --open) OPEN=1 ;;
    --help | -h) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $arg" ;;
  esac
done

command -v node >/dev/null 2>&1 || die "Node.js not found: install Node.js 24 or later (https://nodejs.org)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || die "Node.js $(node -v) is too old (24 or later)"
cd "$REPO"
# The pictures are drawn with the plugin's TypeScript, bundled by the pinned Rollup.
if [ ! -d node_modules/rollup ] || [ ! -d node_modules/marked ]; then
  say "Installing the pinned dependencies (npm ci)"
  npm ci
fi

node scripts/make-handbook.mjs
if [ "$PDF" = 1 ]; then node scripts/make-handbook-pdf.mjs; fi

# The pictures are committed: say when this run changed any.
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  changed=$(git status --porcelain -- docs/handbook/img | wc -l | tr -d ' ')
  if [ "$changed" = 0 ]; then
    say "pictures unchanged"
  else
    say "$changed picture file(s) changed in docs/handbook/img: commit them with the change that caused them"
  fi
fi

if [ "$OPEN" = 1 ]; then
  if [ -f dist/HANDBOOK.pdf ] && [ "$PDF" = 1 ]; then open dist/HANDBOOK.pdf
  elif [ -f dist/HANDBOOK.html ]; then open dist/HANDBOOK.html
  else open docs/HANDBOOK.md
  fi
fi
