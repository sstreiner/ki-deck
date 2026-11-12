#!/bin/sh
# Removes ki-deck. Same as `ki-deck uninstall`, usable from the repository.
#
#   scripts/uninstall.sh [--purge] [--yes]
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
exec "$REPO/bin/ki-deck" uninstall "$@"
