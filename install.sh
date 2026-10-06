#!/bin/sh
# Lazurio in one command (docs/update.md "First installation"):
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://lazurio.ai/install | sh
#   curl --proto '=https' --tlsv1.2 -fsSL https://lazurio.ai/install | sh -s -- --service systemd-user --folder /absolute/Folder
#   LAZURIO_VERSION=v1.2.3-rc.1 sh install.sh     # one exact tag instead of the latest release
#
# Installs the Lazurio Platform (the `lazurio` CLI and the Launchpad, one
# program) for the current user. Needs only curl, and sha256sum or shasum. Never uses sudo and never edits a shell profile. Afterwards Lazurio
# updates itself with `lazurio update`.
#
# THE TRUST CHAIN, PLAINLY. This script comes over HTTPS from lazurio.ai (or
# GitHub). The release files come over HTTPS from GitHub Releases. Before
# anything is executed, the downloaded executable is held against the SHA-256
# in the release's manifest: that proves the download is intact and belongs to
# that manifest, not who published it. The executable then verifies the
# release's Sigstore attestation itself (`install --verify-release`), with the
# same code `lazurio update` uses, and refuses to install otherwise: that
# catches a corrupted, mismatched or wrongly published release, but a
# malicious executable could simply skip it, so it is no defence against
# someone who can replace both the script's source and the release files.
# When a signed-in GitHub CLI (`gh`) is present, `gh attestation verify`
# checks the same attestation independently BEFORE anything is executed.
set -eu

main() {
  ORIGIN="https://github.com/Lazurio/LazurioPlatform"
  REPOSITORY="Lazurio/LazurioPlatform"
  umask 077

  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64 | Linux-amd64) TARGET=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) TARGET=linux-arm64 ;;
    Darwin-arm64) TARGET=darwin-arm64 ;;
    # A shell under Rosetta reports x86_64 on an Apple silicon Mac.
    Darwin-x86_64)
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
        TARGET=darwin-arm64
      else
        unsupported
      fi
      ;;
    *) unsupported ;;
  esac
  [ "$(id -u)" != 0 ] ||
    fail "Lazurio installs for one user and never needs sudo. Run this again as the user who will use Lazurio, without sudo."
  [ -n "${HOME:-}" ] || fail "HOME is not set, so there is no home directory to install into."

  # curl only: it can be told to follow redirects over HTTPS and nothing
  # else. wget cannot be, portably, so it is deliberately not a fallback
  # (docs/update.md "First installation").
  command -v curl >/dev/null 2>&1 ||
    fail "Lazurio needs curl to download itself over HTTPS, and curl is not installed. Install it with your system's package manager (for example: sudo apt install curl on Ubuntu or Debian, sudo dnf install curl on Fedora), then run this again."
  if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else
    fail "Lazurio needs sha256sum or shasum to check the download, and neither is installed. Install one of them and run this again."
  fi

  # A private directory (0700) for the downloads, removed whatever happens.
  # Named by its physical path: the executable accepts only a canonical one.
  TEMPORARY=${TMPDIR:-/tmp}
  WORK=$(mktemp -d "${TEMPORARY%/}/lazurio-install.XXXXXXXX") ||
    fail "cannot create a private temporary directory; nothing was installed."
  trap 'rm -rf "$WORK"' EXIT
  trap 'exit 1' HUP INT TERM
  PHYSICAL=$(cd "$WORK" && pwd -P) ||
    fail "cannot use the private temporary directory; nothing was installed."
  WORK=$PHYSICAL

  if [ -n "${LAZURIO_VERSION:-}" ]; then
    TAG=$LAZURIO_VERSION
  else
    TAG=$(latest_tag)
  fi
  printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
    fail "could not find out which release is the latest one; nothing was installed."

  FILE="lazurio-$TARGET"
  printf 'Installing Lazurio %s for %s.\n' "$TAG" "$TARGET"
  for asset in manifest.json "$FILE" lazurio.sigstore.json; do
    fetch "$ORIGIN/releases/download/$TAG/$asset" "$WORK/$asset" ||
      fail "could not download $asset of $TAG from GitHub; nothing was installed."
  done

  # The manifest is written by the release workflow, one member per line.
  EXPECTED=$(awk -v target="\"$TARGET\": {" '
    index($0, target) { found = 1 }
    found && /"sha256":/ { gsub(/[^0-9a-f]/, "", $2); print $2; exit }
  ' "$WORK/manifest.json")
  grep -q "\"version\": \"${TAG#v}\"" "$WORK/manifest.json" ||
    fail "the manifest of $TAG names another version; nothing was installed."
  [ "${#EXPECTED}" -eq 64 ] ||
    fail "release $TAG has no executable for $TARGET; nothing was installed."
  [ "$(sha256 "$WORK/$FILE")" = "$EXPECTED" ] ||
    fail "the downloaded $FILE does not match the SHA-256 in the manifest of $TAG, so it was not run; nothing was installed."
  printf 'Checked: %s matches the SHA-256 in the manifest of %s.\n' "$FILE" "$TAG"

  # The independent second check, before anything is executed.
  if ! command -v gh >/dev/null 2>&1; then
    printf 'The GitHub CLI (gh) is not installed, so there is no independent second check; lazurio verifies the release attestation itself next.\n'
  elif ! gh auth token >/dev/null 2>&1; then
    printf 'The GitHub CLI (gh) is not signed in, so there is no independent second check; lazurio verifies the release attestation itself next.\n'
  else
    for asset in manifest.json "$FILE"; do
      gh attestation verify "$WORK/$asset" \
        --bundle "$WORK/lazurio.sigstore.json" \
        --repo "$REPOSITORY" \
        --signer-workflow "$REPOSITORY/.github/workflows/release.yml" \
        --source-ref "refs/tags/$TAG" >/dev/null ||
        fail "gh attestation verify refused $asset of $TAG, so nothing was run; nothing was installed."
    done
    printf 'Checked by the GitHub CLI: attested by the release workflow of %s at %s.\n' "$REPOSITORY" "$TAG"
  fi

  chmod 700 "$WORK/$FILE"
  # The executable verifies its release, then copies itself into the per-user
  # install base, links ~/.local/bin/lazurio and says what to do next.
  status=0
  "$WORK/$FILE" install --verify-release "$WORK" "$@" </dev/null || status=$?
  [ "$status" -eq 0 ] ||
    fail "lazurio did not install itself; the reason is above."
}

fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

unsupported() {
  fail "Lazurio supports Linux on x64 and arm64, and macOS on Apple silicon (arm64). This computer is $(uname -s) $(uname -m). Windows and Intel Macs are not supported yet; nothing was installed."
}

# One HTTPS download that follows GitHub's redirect into its asset storage;
# every hop must be HTTPS, a downgrade fails the request.
fetch() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --output "$2" "$1"
}

# The tag of the latest release: `latest` is asked once and NOT followed. The
# tag is read from GitHub's FIRST redirect, which must be the exact-tag HTTPS
# URL of this very repository (followed to the end, the URL is signed asset
# storage on another host and names no tag); anything else, an `http://` hop
# included, is refused before another request is made.
latest_tag() {
  FIRST=$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --head \
    --output /dev/null --write-out '%{redirect_url}' \
    "$ORIGIN/releases/latest/download/manifest.json") ||
    fail "cannot reach $ORIGIN; nothing was installed."
  case "$FIRST" in
    "$ORIGIN/releases/download/"*/manifest.json)
      FIRST=${FIRST#"$ORIGIN/releases/download/"}
      printf '%s' "${FIRST%/manifest.json}"
      ;;
    *) fail "the latest release did not redirect to a release of $REPOSITORY; nothing was installed." ;;
  esac
}

main "$@"
