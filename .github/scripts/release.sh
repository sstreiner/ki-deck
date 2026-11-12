#!/bin/sh
# Builds a ki-deck release with `make release` and publishes it on GitHub. Runs on this Mac
# (`make publish`) and in .github/workflows/release.yml, with the same steps.
#
#   .github/scripts/release.sh [vX.Y.Z]               build the tag, then create its GitHub release
#                                                     (or replace the files of an existing one)
#   .github/scripts/release.sh --build-only [vX.Y.Z]  only build: the tag, or this checkout as it is
#
# The tag defaults to "v" plus the version in package.json, and has to be on GitHub already:
#   make version V=0.13.0, commit, git tag -a v0.13.0, git push origin main v0.13.0
# A tag is built in a temporary worktree, from a clean checkout of exactly that tag, so changes
# that are not committed never end up in a release. make.local (signing and notarizing, see the
# Makefile) is used when it exists. The files are copied to dist/ here.
#
# The release takes its title and notes from the tag's message (subject and body), followed by
# GitHub's generated notes. GitHub access goes through gh: GH_TOKEN when set (the workflow sets
# it), else the gh account named like the repository's owner when it is logged in, else gh's
# active account. GH_REPO (owner/name) defaults to the origin remote.
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO"

say() { printf 'release: %s\n' "$*"; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }

publish=1 tag=""
for arg in "$@"; do
  case "$arg" in
    --build-only) publish=0 ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    v*) [ -z "$tag" ] || die "give one tag only"; tag=$arg ;;
    *) die "unknown argument: $arg (see --help)" ;;
  esac
done

command -v node >/dev/null 2>&1 || die "Node.js not found: install Node.js 24 or later"
version=$(node -p "require('./package.json').version")
if [ "$publish" = 1 ] && [ -z "$tag" ]; then tag="v$version"; fi

# The tag: a release version, here, and the version its own package.json gives.
if [ -n "$tag" ]; then
  printf '%s\n' "$tag" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || die "'$tag' is not a release tag like v0.12.0"
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "there is no tag $tag here: create it with git tag -a $tag, or get it with git fetch --tags"
  version=$(git show "refs/tags/$tag:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
  [ "$tag" = "v$version" ] || die "$tag points to a commit whose package.json says $version"
fi

# GitHub, checked before the build: a repository gh can write to, with the same tag.
message=""
if [ "$publish" = 1 ]; then
  command -v gh >/dev/null 2>&1 || die "the gh command is missing: brew install gh"
  if [ -z "${GH_REPO:-}" ]; then
    GH_REPO=${GITHUB_REPOSITORY:-$(git remote get-url origin | sed -E 's#^(https://[^/]+/|ssh://[^/]+/|[^@/]+@[^:]+:)##; s#\.git$##')}
  fi
  printf '%s\n' "$GH_REPO" | grep -Eq '^[^/]+/[^/]+$' || die "cannot tell the GitHub repository from '$GH_REPO': set GH_REPO=owner/name"
  export GH_REPO
  owner=${GH_REPO%%/*}
  if [ -z "${GH_TOKEN:-}" ] && token=$(gh auth token --hostname github.com --user "$owner" 2>/dev/null) && [ -n "$token" ]; then
    GH_TOKEN=$token
    export GH_TOKEN
    say "using the gh account $owner"
  fi
  if [ "${GITHUB_ACTIONS:-}" != true ]; then
    permission=$(gh repo view "$GH_REPO" --json viewerPermission --jq .viewerPermission 2>/dev/null) ||
      die "gh cannot see $GH_REPO: log in with an account that can (gh auth login; an account named $owner is picked by itself), or set GH_TOKEN"
    case "$permission" in
      ADMIN | MAINTAIN | WRITE) ;;
      *) die "gh's account can only read $GH_REPO ($permission)" ;;
    esac
  fi
  ref=$(gh api "repos/$GH_REPO/git/ref/tags/$tag" --jq '.object.type + " " + .object.sha' 2>/dev/null) ||
    die "$tag is not on GitHub yet: git push origin $tag"
  kind=${ref%% *}
  sha=${ref#* }
  commit=$sha
  if [ "$kind" = tag ]; then
    commit=$(gh api "repos/$GH_REPO/git/tags/$sha" --jq .object.sha)
    message=$(gh api "repos/$GH_REPO/git/tags/$sha" --jq .message | sed '/^-----BEGIN [A-Z ]*SIGNATURE-----/,$d')
  fi
  [ "$commit" = "$(git rev-parse "refs/tags/$tag^{commit}")" ] || die "$tag on GitHub points to another commit than here"
fi

# The build: a tag in a clean worktree of it, otherwise this checkout.
build=$REPO
if [ -n "$tag" ]; then
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/ki-deck-release.XXXXXX")
  build="$scratch/tree"
  trap 'git -C "$REPO" worktree remove --force "$build" >/dev/null 2>&1 || true; rm -rf "$scratch"; git -C "$REPO" worktree prune' EXIT
  trap 'exit 1' INT TERM
  git worktree add --quiet --detach "$build" "refs/tags/$tag"
  if [ -f make.local ]; then cp make.local "$build/"; fi
fi
say "building ${tag:-this checkout} (version $version)"
(cd "$build" && npm ci --no-audit --no-fund && make clean && make release)

files="ki-deck-$version.pkg net.streiner.ki-deck.streamDeckPlugin HANDBOOK.pdf SHA256SUMS"
if [ "$build" != "$REPO" ]; then
  mkdir -p dist
  for f in $files; do cp "$build/dist/$f" dist/; done
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "version=$version" >> "$GITHUB_OUTPUT"; fi
if [ "$publish" = 0 ]; then
  say "built in dist/: $files"
  exit 0
fi

set --
for f in $files; do set -- "$@" "dist/$f"; done
if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "$@" --clobber
  say "replaced the files of release $tag"
  exit 0
fi

# Title and notes from the tag's message; without one, a short install note.
title=$(printf '%s\n' "$message" | sed -n '1p')
notes=$(printf '%s\n' "$message" | sed '1d' | sed '/./,$!d')
[ -n "$title" ] || title="ki-deck $version"
[ -n "$notes" ] || notes="**Install:** open \`ki-deck-$version.pkg\` (installs for your user, no administrator password), or double-click \`net.streiner.ki-deck.streamDeckPlugin\` to install through Stream Deck. \`HANDBOOK.pdf\` explains every key; \`SHA256SUMS\` has the checksums."
if ! pkgutil --check-signature "dist/ki-deck-$version.pkg" >/dev/null 2>&1 && ! printf '%s\n' "$notes" | grep -q "Open Anyway"; then
  notes="$notes

The package is not signed: macOS blocks it on the first try. Then choose **Open Anyway** in System Settings > Privacy & Security."
fi
gh release create "$tag" "$@" --verify-tag --title "$title" --notes "$notes" --generate-notes
say "published release $tag"
