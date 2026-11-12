# Build tool for ki-deck on macOS. `make help` lists the targets.
# The work lives in the npm scripts and scripts/*.mjs; this file only puts them in order, so a
# Windows build can call the same scripts later (MULTIOS.md). Rules are written on one line
# (`target: prerequisites ; recipe`) and need no tabs.
#
# Signing and notarizing the installer package (make pkg, make notarize, make release):
#   SIGN_ID        = Developer ID Installer: <Name> (<TEAM ID>)     signs the package
#   SIGN_APP_ID    = Developer ID Application: <Name> (<TEAM ID>)   signs the uninstaller app in it
#   NOTARY_PROFILE = <name>                  from: xcrun notarytool store-credentials <name> ...
# Both identities in your keychain. Pass them on the command line, or put them in make.local
# (git-ignored), one per line as above.

-include make.local
export SIGN_ID SIGN_APP_ID NOTARY_PROFILE

VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null)
PLUGIN  := dist/net.streiner.ki-deck.streamDeckPlugin
PKG     := dist/ki-deck-$(VERSION).pkg

.DEFAULT_GOAL := build
.PHONY: help build check typecheck test validate install handbook plugin pkg notarize release version clean

## build      Icons, profiles, the plugin bundle and the companion .vsix (the default)
build: ; npm run build && npm run companion

## check      Typecheck, tests and Elgato's manifest validation (after a build: it checks the generated files)
check: typecheck test validate
typecheck: ; npm run typecheck
test: ; npm test
validate: build ; npm run validate

## install    Install from this checkout: scripts/install.sh --yes (restarts Stream Deck)
install: ; scripts/install.sh --yes

## handbook   The handbook's pictures (docs/handbook/img/) and dist/HANDBOOK.pdf: scripts/make-handbook.sh
handbook: ; scripts/make-handbook.sh

## plugin     dist/net.streiner.ki-deck.streamDeckPlugin, with the one-click setup inside
plugin: ; npm run package

## pkg        dist/ki-deck-<version>.pkg (with the uninstaller app); signed when SIGN_ID is set
pkg: plugin ; node scripts/pkg/build.mjs

## notarize   Send the signed package to Apple, wait, staple it (needs SIGN_ID, SIGN_APP_ID, NOTARY_PROFILE)
notarize: pkg ; node scripts/pkg/build.mjs notarize

## release    check, plugin, package (notarized when NOTARY_PROFILE is set), handbook PDF, SHA256SUMS
release: check $(if $(NOTARY_PROFILE),notarize,pkg) ; scripts/make-handbook.sh && cd dist && shasum -a 256 $(notdir $(PLUGIN)) $(notdir $(PKG)) HANDBOOK.pdf > SHA256SUMS && cat SHA256SUMS

## version    Set the plugin version everywhere: make version V=0.11.0
version: ; node scripts/version.mjs "$(V)"

## clean      Remove the packaging output (dist/, build/); the linked plugin's own build stays
clean: ; rm -rf dist build

## help       This list
help: ; @sed -n 's/^## /make /p' Makefile
