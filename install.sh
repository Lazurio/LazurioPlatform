#!/bin/sh
# First installation of Lazurio (docs/update.md "First installation").
#
#   sh install.sh [arguments of `lazurio install`, e.g. --service systemd-user --folder /absolute/Folder]
#   LAZURIO_VERSION=v1.2.3-rc.1 sh install.sh     # one exact tag instead of the latest release
#
# WHAT THIS TRUSTS, PLAINLY: HTTPS to github.com. The executable is checked
# against the size-and-digest manifest of the same release, which proves the
# download is intact, not who published it. When the GitHub CLI `gh` is present,
# the Sigstore attestation of the release workflow is verified BEFORE anything
# is executed, and a failure stops the installation. Without `gh` that check
# does not happen and this script says so. A check performed by the downloaded
# executable itself would not be authentication and is not offered. Every later
# update is verified by the installed product itself.
set -eu

ORIGIN="https://github.com/Lazurio/LazurioPlatform"
REPOSITORY="Lazurio/LazurioPlatform"

fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) TARGET=linux-arm64 ;;
  Darwin-arm64) TARGET=darwin-arm64 ;;
  *) fail "unsupported platform $(uname -s) $(uname -m); supported: linux-x64, linux-arm64, darwin-arm64" ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi
fetch() { curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location "$@"; }

# `latest` is asked once, only for the tag; everything else by exact tag.
if [ -n "${LAZURIO_VERSION:-}" ]; then
  TAG=$LAZURIO_VERSION
else
  RESOLVED=$(fetch --head --output /dev/null --write-out '%{url_effective}' \
    "$ORIGIN/releases/latest/download/manifest.json") || fail "cannot reach $ORIGIN"
  TAG=${RESOLVED#"$ORIGIN/releases/download/"}
  TAG=${TAG%%/*}
fi
printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
  fail "could not resolve a release tag"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
FILE="lazurio-$TARGET"
for asset in manifest.json "$FILE"; do
  fetch --output "$WORK/$asset" "$ORIGIN/releases/download/$TAG/$asset" ||
    fail "cannot download $asset of $TAG"
done

# The manifest is written by the release workflow, one member per line.
EXPECTED=$(awk -v target="\"$TARGET\": {" '
  index($0, target) { found = 1 }
  found && /"sha256":/ { gsub(/[^0-9a-f]/, "", $2); print $2; exit }
' "$WORK/manifest.json")
grep -q "\"version\": \"${TAG#v}\"" "$WORK/manifest.json" ||
  fail "the manifest of $TAG names another version"
[ "${#EXPECTED}" -eq 64 ] || fail "the manifest of $TAG has no artifact for $TARGET"
[ "$(sha256 "$WORK/$FILE")" = "$EXPECTED" ] ||
  fail "$FILE does not match the digest in the manifest of $TAG"

if command -v gh >/dev/null 2>&1; then
  fetch --output "$WORK/lazurio.sigstore.json" \
    "$ORIGIN/releases/download/$TAG/lazurio.sigstore.json" ||
    fail "cannot download the attestation of $TAG"
  for asset in manifest.json "$FILE"; do
    gh attestation verify "$WORK/$asset" \
      --bundle "$WORK/lazurio.sigstore.json" \
      --repo "$REPOSITORY" \
      --signer-workflow "$REPOSITORY/.github/workflows/release.yml" \
      --source-ref "refs/tags/$TAG" >/dev/null ||
      fail "gh attestation verify refused $asset of $TAG; nothing was executed"
  done
  printf 'Verified: %s was built and attested by the release workflow of %s at %s.\n' "$FILE" "$REPOSITORY" "$TAG"
else
  printf 'NOT verified beyond HTTPS: the GitHub CLI (gh) is not installed, so the attestation of %s was not checked.\n' "$TAG" >&2
fi

chmod 700 "$WORK/$FILE"
# The executable copies itself into the per-user install base.
"$WORK/$FILE" install "$@"
