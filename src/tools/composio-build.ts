// Lazurio's build of the Composio CLI (decision F42, addendum (3) of
// 2026-10-13; the Operator's decision of the same day). Composio's stable CLI
// (0.4.3) cannot remove an account without a prompt, and its `connections
// list` prints no ids and no provider identity, so Apps → Integrace can
// neither offer "Odpojit" nor name an account by more than an alias. The
// build is upstream stable 0.4.3 with exactly four changes, published by the
// fork Lazurio/composio: `connections remove <account> --yes` (and `-y`);
// `connections list` printing every account's `id`, its `alias` and, where
// Composio knows it, its `display_name`; since 0.4.3-lazurio.2
// (Lazurio/composio#3), `composio login --poll` and the browser wait of
// `composio login` checking a pending login every 5 s for up to 10 minutes
// (`--key` about 75 s), where upstream's pause doubles from the sixth check
// on, so the Launchpad's Composio dialog noticed an "Authorize" up to about a
// minute late (read 2026-10-19); and, since 0.4.3-lazurio.3
// (Lazurio/composio#4), `orgs list` printing each organization's
// `created_at`, by which a personal Environment finds the account's default
// organization, its oldest (decision F42, addendum of 2026-10-26).
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
// When it goes away: once a stable release of Composio's own CLI has all
// four changes (proposed upstream: `--yes` in ComposioHQ/composio#4817,
// issue #4816; the list's ids and names in #4809; the login's poll and the
// organizations' dates not yet),
// this file is removed and the recipe returns to Composio's installer and its
// latest stable release, as before 2026-10-13.

const version = "0.4.3-lazurio.3";
/** The fork's commit whose `install.sh` runs: the release's own commit, the
 * squash of Lazurio/composio#4 into `lazurio/cli-0.4.3`. Its installer is
 * byte for byte the one of the merge of #2, strict for this source and
 * checking `COMPOSIO_INSTALL_SHA256`: #3 and #4 changed the CLI, not the
 * installer (compared 2026-10-26). */
const installerCommit = "5bcde7de8dc78681e8d44262fcf134afab19e091";

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
   * archives hash, read 2026-10-26). The pinned installer takes it as
   * `COMPOSIO_INSTALL_SHA256` and refuses any other archive before it
   * extracts or replaces anything: the commit pins the script, these pin the
   * bytes it installs (Pablo's review of #395). */
  archives: Object.freeze({
    "linux-x64":
      "c48497ea9b691933575ab1edc6803b5eceb65d4e2fc32be61ce4803d07603027",
    "linux-arm64":
      "e8404f46d43ca537deb31658d30588e479b46553e02182b8d041db145a5734bc",
    "darwin-x64":
      "7c11326f54ac849a48bc9332032659edcda845e6334c179e89a0731a129fbc13",
    "darwin-arm64":
      "bc757402c3d304acdd46f7bfea435565a5cf538a16c3c0fea9bfa398c1938cb5",
  }),
});
