// The Bitwarden CLI of the Environment vault, pinned per Platform release
// (decision F43, an addendum of F19): not the latest release, because the CLI
// must stay compatible with the Vaultwarden of every network. bw 2026.9.x
// needs Vaultwarden 1.37.4 or newer (its first unlock posts the user key id
// that 1.37.1 does not know); 2026.7.0 works with 1.37.0 and later, which is
// what the networks run. A new pin is a reviewed change of this file, with the
// digests read from the release and the e2e qualification repeated.

export type BitwardenTarget =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64";

export type BitwardenPin = Readonly<{
  version: string;
  /** The release's download address, without the asset name. */
  release: string;
  /** The OSS build of each target (`bw-oss-…`): one zip with the single
   * entry `bw`, verified against this SHA-256 before it is read. */
  assets: Readonly<
    Record<BitwardenTarget, Readonly<{ name: string; sha256: string }>>
  >;
}>;

export const bitwardenPin: BitwardenPin = Object.freeze({
  version: "2026.7.0",
  release:
    "https://github.com/bitwarden/clients/releases/download/cli-v2026.7.0",
  assets: Object.freeze({
    "linux-x64": {
      name: "bw-oss-linux-2026.7.0.zip",
      sha256:
        "d867a39c28ddd56c09a1a99bdbae3afbca4c295c918d41bbdac8ca25e9bf4073",
    },
    "linux-arm64": {
      name: "bw-oss-linux-arm64-2026.7.0.zip",
      sha256:
        "d3138cb03b6c42271acf83ab962dcbe1423bc69facfd44be1fa0dd1b1e5eb3ad",
    },
    "darwin-x64": {
      name: "bw-oss-macos-2026.7.0.zip",
      sha256:
        "3013eee9970ca2f3e6a54ddbe7ffd377e61bc6dd81f272ff660d6850529dc012",
    },
    "darwin-arm64": {
      name: "bw-oss-macos-arm64-2026.7.0.zip",
      sha256:
        "b07673ed1364df5843d7a02b1fdb58472e67cd4ef45d877fc057c36165007be0",
    },
  }),
});

export function bitwardenTarget(
  platform: string,
  arch: string,
): BitwardenTarget | undefined {
  if (platform !== "linux" && platform !== "darwin") return undefined;
  if (arch !== "x64" && arch !== "arm64") return undefined;
  return `${platform}-${arch}`;
}
