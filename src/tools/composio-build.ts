// Lazurio's build of the Composio CLI (decision F42, addendum (3) of
// 2026-10-13; the Operator's decision of the same day). Composio's stable CLI
// (0.4.3) cannot remove an account without a prompt, and its `connections
// list` prints no ids and no provider identity, so Apps → Integrace can
// neither offer "Odpojit" nor name an account by more than an alias. The
// build is upstream stable 0.4.3 with exactly two changes, published by the
// fork Lazurio/composio: `connections remove <account> --yes` (and `-y`), and
// `connections list` printing every account's `id`, its `alias` and, where
// Composio knows it, its `display_name`.
//
// Why a pin: the curated installation (decision F19) and `lazurio tools
// update composio` install exactly this release, and the installed `composio
// --version` must print exactly `version`. Composio's installer served at
// https://composio.dev/install accepts an explicit version only as `X.Y.Z`
// or `X.Y.Z-beta.N` and resolves "latest" only among plain
// `@composio/cli@X.Y.Z` tags, so it cannot install this build. The recipe
// runs Composio's installer from Lazurio's fork instead: the fork's
// `install.sh` is upstream's with that one version check widened to accept
// `-lazurio.N`. It is pinned by commit, so its URL is immutable: what runs is
// exactly the reviewed script, whatever later happens to a branch or a tag.
// Its environment points it at the fork's releases and pins the tag.
// `composio upgrade` is not the update: from Composio's CLI it reaches the
// fork only with overrides, and from a build of the fork it moves to the
// highest release there by semver, not to this one.
//
// The tag and the installer's commit come from the same release of the fork
// and change together, here: a new build is a reviewed change of both.
//
// When it goes away: once a stable release of Composio's own CLI has both
// changes (proposed upstream: `--yes` in ComposioHQ/composio#4817, issue
// #4816; the list's ids and names in #4809), this file is removed and the
// recipe returns to Composio's installer and its latest stable release, as
// before 2026-10-13.

const version = "0.4.3-lazurio.1";
/** The fork's commit whose `install.sh` runs: the commit the release is
 * cut from, the merge of Lazurio/composio#1 into `lazurio/cli-0.4.3`. */
const installerCommit = "c2cecf946112bf87ea8d7553e3bd2e7e1e1e69e0";

export const composioBuild = Object.freeze({
  /** The fork whose GitHub releases publish the build: the assets
   * `composio-<target>.zip` and `checksums.txt`, as Composio's do. */
  owner: "Lazurio",
  repository: "composio",
  /** What `composio --version` prints for this build. */
  version,
  /** The release's tag. */
  tag: `@composio/cli@${version}`,
  installerCommit,
  /** Composio's installer from the fork, pinned by commit: immutable. */
  installer: `https://raw.githubusercontent.com/Lazurio/composio/${installerCommit}/install.sh`,
  /** The SHA-256 of each target's release archive (`composio-<target>.zip`,
   * as the release's `checksums.txt` lists them and as the downloaded
   * archives hash, read 2026-10-13). The pinned installer takes it as
   * `COMPOSIO_INSTALL_SHA256` and refuses any other archive before it
   * extracts or replaces anything: the commit pins the script, these pin the
   * bytes it installs (Pablo's review of #395). */
  archives: Object.freeze({
    "linux-x64":
      "a87cc25373ebe1efc6d819e8dd8b40cc54f96bfa71916cac5755623ca1892b19",
    "linux-arm64":
      "c5dac856c31bc22d9b9bf9bd275b6a637359fca08d93f0e6aa1a36ff283d1488",
    "darwin-x64":
      "e7fee0737a3816fe004efe950d1373e12bd7fa8071fe6ebf0acbabf288dc9a5b",
    "darwin-arm64":
      "be9a2c84c32621dff02b9c96b727e478372ba0c7348904197dce8f6353b9b588",
  }),
});
