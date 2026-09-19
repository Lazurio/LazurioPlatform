# Release keys: ceremony, custody, rotation, expiry

Status: **procedure for the Principal; not yet performed.** Until it is,
`release/root.json` does not exist, every build embeds **no** trust root,
`lazurio update` answers `trust-missing`, and the release workflow refuses to
build. This document contains names, commands and placeholders only. No real
key, key id, token or secret value belongs in this repository, in an issue, in
a pull request or in a workflow log.

The update mechanism ([product update](update.md)) trusts four TUF roles. Their
separation is the security design; putting two of them in one place removes it.

| Role | What it authorizes | Lifetime | Where the private key lives | Who can use it |
| --- | --- | --- | --- | --- |
| `root` | Which keys are valid for every role | 1 year | **Offline.** The Principal's password manager plus one offline copy (e.g. an encrypted USB medium in a safe). Never on GitHub, never in CI, never on a hosted Machine. | The Principal, by hand, about once a year |
| `targets` | Releases: artifacts, identities, channel documents, promotion | 90 days | GitHub Actions **environment** secret `LAZURIO_TUF_TARGETS_KEY` in environment `release`, which has a **required reviewer** | A workflow job only after a named person approves that run |
| `snapshot` | Consistency of one repository state | 30 days | GitHub Actions **repository** secret `LAZURIO_TUF_SNAPSHOT_KEY` | Release jobs and the daily refresh |
| `timestamp` | Freshness | 7 days | GitHub Actions **repository** secret `LAZURIO_TUF_TIMESTAMP_KEY` | Release jobs and the daily refresh |

Every role has **threshold 1** with one key: the controlled-pilot policy of
[release cycle](release-cycle.md). The disclosed consequence: whoever obtains
the root key alone can replace every other key; whoever obtains the targets key
alone can publish a release that installed Machines accept. Before a broader
release, threshold custody (two of three root keys held by different people)
is evaluated again; the root format already supports it.

Snapshot and timestamp keys are deliberately less protected: they cannot make a
Machine accept an artifact that the targets key did not sign. Stolen, they allow
freezing clients on an old but genuine state until their metadata expires — that
is what the short lifetimes bound. This holds for the publisher too, and only
because it verifies before it signs: the published tree is storage that anyone
with write access to the branch can change, so every run first verifies the
published timestamp, snapshot and targets under the published root and refuses
to continue otherwise. It never adopts unverified entries and signs them again
with the targets key (`tests/publish-repository.test.ts` forges exactly that).
What such a person can still do is present an older genuine state; clients that
have seen a newer one refuse it, and `gh-pages` history shows it.

## What must exist on GitHub (names only)

Settings of `Lazurio/LazurioPlatform`, created by an Organization Admin — no
workflow or agent creates them:

1. **Pages**: Source "Deploy from a branch", branch `gh-pages`, folder `/`.
   The branch is created by the first release. The published origin compiled
   into the product is `https://lazurio.github.io/LazurioPlatform/`
   (`src/update/defaults.ts`). If a custom domain is ever wanted, it must be
   decided **before** the first client installation: the origin is compiled
   into every executable.
2. **Environment `release`**: required reviewers (at least the Principal);
   "Deployment branches and tags" limited to branch `main` and tags `v*`;
   environment secret `LAZURIO_TUF_TARGETS_KEY`.
3. **Repository secrets** `LAZURIO_TUF_SNAPSHOT_KEY` and
   `LAZURIO_TUF_TIMESTAMP_KEY`.
4. **Tag protection / ruleset** for `v*`: only maintainers may create release
   tags; a tag starts a release.
5. **Branch protection for `gh-pages`**: no force push, no deletion. The
   workflows only ever append commits.
6. Recommended: notifications for failed workflow runs of "Update metadata
   refresh" reach a person. That failure is the early warning described below.

Each secret value is the complete text of the corresponding
`<role>.private.pem` file, including its first and last line.

## One-time ceremony

On the Principal's own workstation, from a clean checkout of `main`, with the
pinned Bun. Use a directory **outside every Git repository** on an encrypted
volume; the tool refuses a directory inside a repository, never overwrites a
key, and never prints one.

```sh
KEYS=/absolute/path/outside/any/repository/lazurio-release-keys

for role in root targets snapshot timestamp; do
  bun run scripts/release-keys.ts generate --role "$role" --out "$KEYS"
done

bun run scripts/release-keys.ts init-root \
  --root-key  "$KEYS/root.private.pem" \
  --targets   "$KEYS/targets.public.json" \
  --snapshot  "$KEYS/snapshot.public.json" \
  --timestamp "$KEYS/timestamp.public.json" \
  --out release/root.json
```

Then, in this order:

1. Store `root.private.pem` in the password manager and on the offline medium.
   Verify both copies can be read back.
2. Create the three secrets above from `targets.private.pem`,
   `snapshot.private.pem` and `timestamp.private.pem` (GitHub web UI, or
   `gh secret set <NAME> --env release < file` / `gh secret set <NAME> < file`
   run by the Principal). Keep a second copy of these three in the password
   manager: GitHub never shows a secret again, and a lost targets key costs a
   root rotation.
3. Commit **only** `release/root.json` (public metadata: public keys, role
   thresholds, an expiry, signatures) through a reviewed pull request. The four
   `*.public.json` files are not needed afterwards; the four private files are
   never committed — `bun run check:public` refuses `.pem` paths and private-key
   text even if someone tries.
4. Delete the working directory `"$KEYS"` from the workstation once the copies
   of step 1 and 2 are verified.
5. Record in the private custody record (not here) who holds which copy.

The first release tag after the merge builds executables that embed this root,
creates the `gh-pages` tree with `metadata/1.root.json`, and publishes to
`preview`.

## Everyday operation

- **Release**: push tag `vX.Y.Z` (or `vX.Y.Z-rc.N`). Gates, three native
  builds, one GitHub Release, then the `publish` job waits for the reviewer of
  environment `release` and signs the release into `preview`.
- **Promotion**: "Release" workflow → *Run workflow* → `promote`, with the exact
  version. Approve the environment. `stable` then names the same digests
  `preview` offers; nothing is built. Pre-releases cannot be promoted.
- **Freshness**: "Update metadata refresh" runs daily and needs no person.

## Expiry calendar

| Role | Lifetime | Renewed | By | If missed |
| --- | --- | --- | --- | --- |
| timestamp | 7 days | when fewer than 5 days remain (in practice every 2–3 days) | daily refresh job | no Machine can check or update until renewed |
| snapshot | 30 days | when fewer than 20 days remain | daily refresh job | same |
| targets | 90 days | by every release and promotion; otherwise manually when fewer than **30** days remain | "Release" workflow → `renew-targets`, approved in environment `release` | same |
| root | 365 days | manually when fewer than **60** days remain | the Principal, offline (`rotate-root` below), then a pull request | same, and new installations cannot establish trust |

Expiry never stops an installed product from working; it stops checking and
updating. The daily job prints the remaining validity of every role into its
run summary and **fails** as soon as targets or root is below its margin — 30
and 60 days before anything breaks. A failing "Update metadata refresh" run is
therefore a calendar reminder with a deadline, not noise. GitHub disables
scheduled workflows in a repository without activity for 60 days. Whether the
refresh job's own commits to `gh-pages` count as activity has **not** been
verified; treat GitHub's "scheduled workflow disabled" e-mail as an incident,
because once the job stops, metadata lapses within a week.

Put two reminders in the Principal's calendar on the day of the ceremony: root
renewal at ten months, and a quarterly look at the refresh job's summary.

## Renewing or rotating the root

Renewal (same keys, new expiry) and rotation (new keys) are the same command.
It needs the **current** root key, offline, and produces root N+1 signed by the
outgoing and the incoming root key, so every installation that trusts root N
accepts it.

```sh
# Renew: same keys, one more year.
bun run scripts/release-keys.ts rotate-root \
  --current release/root.json --root-key "$KEYS/root.private.pem" \
  --out release/root.json

# Rotate the targets key (generate the new one first, as in the ceremony).
bun run scripts/release-keys.ts rotate-root \
  --current release/root.json --root-key "$KEYS/root.private.pem" \
  --targets "$NEW/targets.public.json" --out release/root.json

# Rotate the root key itself.
bun run scripts/release-keys.ts rotate-root \
  --current release/root.json --root-key "$KEYS/root.private.pem" \
  --new-root-key "$NEW/root.private.pem" --out release/root.json
```

Commit the new `release/root.json` through a pull request. After the merge:

- replace the GitHub secret of every role whose key changed;
- the next publishing run installs `metadata/<N+1>.root.json` and re-signs
  exactly the roles whose key changed. If the targets key changed, that run
  must be one with the targets key: dispatch `renew-targets`. The daily refresh
  can do it alone only when just snapshot, timestamp or the root key changed.
- Rotate **one version at a time**: publish root N+1 before creating N+2. The
  publisher refuses a root that skips a version, because clients walk the chain
  one step at a time.

New executables embed the new root; installed ones follow the chain from the
root they hold. Old roots stay published forever.

## Compromise or loss

Do not describe the incident, and never paste key material, in a public issue.

- **Timestamp or snapshot key exposed**: generate a replacement, rotate the
  root for that role (above), replace the secret, run the refresh workflow.
  Exposure allowed freezing, not forged releases.
- **Targets key exposed**: treat every release signed since the exposure as
  suspect. Rotate the targets key through the root immediately (that revokes
  the old key for every client on its next check), replace the environment
  secret, dispatch `renew-targets`, then review the `gh-pages` history —
  it is append-only, so every signed state is still there — and publish a
  higher version if a forged release was offered. Remove GitHub Release assets
  that are not yours.
- **Targets, snapshot or timestamp key lost** (not exposed): same rotation,
  without the urgency.
- **Root key exposed**: rotate the root key at once with the still-held key;
  the old key stops being accepted by every client that has seen the new root.
  A Machine that was offline meanwhile can still be shown a forged chain: say
  so publicly and ship a release whose installer embeds the new root.
- **Root key lost**: nothing can be rotated or renewed any more. Before the
  root expires, publish a final release under the old chain that embeds a
  **new** root created by a new ceremony, and tell users to update before the
  date. Machines that miss it need a fresh installation. This is why the root
  key has two verified copies.
- In every case: revoke first, investigate second, and record the incident in
  the private custody record.

## What the tools guarantee, and what they do not

`scripts/release-keys.ts` writes private keys with mode `0600`, refuses to
write inside a Git repository or over an existing file, refuses a private key
file that other accounts can read, and prints only key ids and paths.
`scripts/release-publish.ts` reads keys from the three named environment
variables (or a local `--keys-dir` for rehearsals), refuses a key the current
root does not authorize, and reports refusals by code, never by echoing input.
`bun run check:public` refuses `.pem` files and private-key text anywhere in the
work tree.

They do **not** protect a workstation that is already compromised during the
ceremony, a reviewer who approves the `release` environment without looking, or
a maintainer who can push a `v*` tag of unreviewed source. Those are covered by
the repository rules above, not by code.
