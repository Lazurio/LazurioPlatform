# First release candidate through the real release path — v0.1.0-rc.1, 2026-09-22

Evidence for the [product update contract](../update.md), section *Evidence
required before any Machine depends on this*, second item: one real release
candidate published by `release.yml` and verified by a compiled client. Until this
run the GitHub + Sigstore path had only been exercised against fixtures.

## Repository settings (Organization Admin, 2026-09-22)

- Tag ruleset `release-tags`: active, `refs/tags/v*`, restrict creation, update and
  deletion; bypass: the Repository admin role (an empty bypass list would refuse
  every release tag, including the Admin's).
- Environment `release`: required reviewer `immakermatty`, deployment tags `v*`,
  no secrets, no variables.
- Immutable releases enabled.

## Publishing

- Tag `v0.1.0-rc.1` on `main` `12080866a343baa96e3ac0afab0a0ed3b9362d69`, pushed
  by the Admin.
- Run <https://github.com/Lazurio/LazurioPlatform/actions/runs/35716752920>:
  resolve → check the tagged source → build `linux-x64`, `linux-arm64`,
  `darwin-arm64` on their own runners → *Attest and publish* held for the
  environment reviewer, approved by the Admin, then one Sigstore bundle over the
  manifest and the three binaries and one immutable prerelease with the five
  assets `lazurio-darwin-arm64`, `lazurio-linux-arm64`, `lazurio-linux-x64`,
  `lazurio.sigstore.json`, `manifest.json`.
- Manifest: `version 0.1.0-rc.1`, `source_commit 12080866…`, three targets.

## Verification with GitHub's own verifier (on the operator's Mac)

`gh attestation verify manifest.json --bundle lazurio.sigstore.json` and the same
for `lazurio-linux-arm64` with `--signer-workflow
Lazurio/LazurioPlatform/.github/workflows/release.yml`: both verified against the
public Sigstore instance; the certificate names `sourceRepositoryURI
https://github.com/Lazurio/LazurioPlatform`, `sourceRepositoryRef
refs/tags/v0.1.0-rc.1`, `buildSignerURI …/release.yml@refs/tags/v0.1.0-rc.1`,
issuer `https://token.actions.githubusercontent.com`. A copy of the binary with one
appended byte is refused (`Error: verifying with issuer "sigstore.dev"`).

## Verification by the compiled client on a clean Machine

Fresh disposable Ubuntu 24.04.4 ARM64 clone, no `gh`, `curl` and `sha256sum`
only, real network to `github.com`.

```text
$ LAZURIO_VERSION=v0.1.0-rc.1 sh install.sh
NOT verified beyond HTTPS: the GitHub CLI (gh) is not installed, so the attestation of v0.1.0-rc.1 was not checked.
Lazurio 0.1.0-rc.1 is installed. Put /home/admin/.local/share/lazurio/bin on your PATH.
$ lazurio --version
lazurio 0.1.0-rc.1 (commit 12080866a343baa96e3ac0afab0a0ed3b9362d69, target linux-arm64)
$ lazurio update status --json
{"kind":"status","running":"0.1.0-rc.1","active":"0.1.0-rc.1","previous":null,"highWater":null,"supervised":false,"pending":null,"stateInvalid":null,"lastCheck":null,"updateAvailable":false}
$ lazurio update --check --json
{"kind":"error","code":"release-invalid","context":{"resource":"latest","reason":"not-found"}}
$ lazurio update --check --version v0.1.0-rc.1 --json
{"kind":"up-to-date","running":"0.1.0-rc.1","latest":"0.1.0-rc.1","notesUrl":"https://github.com/Lazurio/LazurioPlatform/releases/tag/v0.1.0-rc.1"}
```

- `install.sh` says exactly what it verified: HTTPS only, because `gh` is absent
  (the contract's stated bootstrap limit).
- The exact-tag check ran the product's own verifier against the real release:
  Sigstore's trust root was fetched by Sigstore's own client into
  `sigstore/tuf-repo-cdn.sigstore.dev` under the install base, and the manifest
  and bundle of `v0.1.0-rc.1` verified against the compiled-in origin, repository
  and owner IDs, the exact-tag workflow identity and the source commit.
- `latest` is `not-found` because no final release exists yet; a prerelease is
  invisible to `latest` by design.

## Not covered by this run

A real update from one published release to another (needs a second release),
`darwin-arm64` and `linux-x64` clients against this release, and the supervised
path on a Machines-delivered VM.
