import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRunner } from "../tools/status";
import { ed25519Blob } from "./access-service";
import {
  type EnvironmentSshLocation,
  environmentKeyPath,
  inspectDirectory,
  Refusal,
  readOwnFile,
  replaceFile,
} from "./environments";

// The one key of a source Environment (root decision 0224; Machines
// ACCESS-SERVICE.md, "PUT /v1/source-key"): `~/.ssh/lazurio-environment-ed25519`
// and its `.pub`. Every SSH hop from this Environment to another uses it, one
// key per source, never one per edge. The Platform creates it here with
// `ssh-keygen` when it is missing, and only then. It opens the private key
// file only to check that it is a plain file of this account that nobody
// else may read, and drops its bytes; the public line comes from
// `ssh-keygen -y`, inside the Environment. It never copies, exports or
// prints the private part, and never replaces a key that is there. What it
// hands on is the public line `ssh-ed25519 <blob>`, without a comment.
//
// Refused, changing nothing: a link or another account's file at either
// path, a private key that group or others may read (OpenSSH would refuse
// it too), a `.pub` without its private key, and a pair that does not belong
// together or is not ed25519 (`key-invalid`); the person decides about their
// own files.

export const sourceKeyComment = "lazurio-environment";
const keygenTimeoutMs = 30_000;

export type SourceKeyRefusal =
  | "ssh-directory-unsafe"
  | "file-unsafe"
  | "key-incomplete"
  | "key-invalid";

export type SourceKeyResult =
  | Readonly<{ kind: "present"; publicKey: string }>
  | Readonly<{ kind: "created"; publicKey: string }>
  | Readonly<{ kind: "blocked"; reason: SourceKeyRefusal; path: string }>
  /** `ssh-keygen` is missing, failed or timed out. */
  | Readonly<{ kind: "failed" }>;

const shownPrivate = environmentKeyPath;
const shownPublic = `${environmentKeyPath}.pub`;

/** The `ssh-ed25519 <blob>` of the first line of a `.pub`, or null. */
function publicLine(text: string): string | null {
  const [type, blob] = (text.split("\n", 1)[0] ?? "").trim().split(/\s+/);
  const line = `${type} ${blob}`;
  return ed25519Blob(line) === null ? null : line;
}

/** Makes sure this Environment has its one key and answers its public
 * line. Creates the pair only when neither file exists, and the `.pub` only
 * when the private key exists without it. */
export async function ensureSourceKey(
  location: EnvironmentSshLocation,
  run: ToolRunner,
): Promise<SourceKeyResult> {
  const ssh = join(location.home, ".ssh");
  const name = "lazurio-environment-ed25519";
  const privatePath = join(ssh, name);
  const env = { HOME: location.home, PATH: process.env.PATH ?? "" };
  // The public line ssh-keygen derives from the private key, here.
  const derive = async () => {
    const result = await run(
      ["ssh-keygen", "-y", "-f", privatePath],
      keygenTimeoutMs,
      env,
    );
    if (result === "timeout" || result.exitCode !== 0) return null;
    return publicLine(result.stdout);
  };
  try {
    if ((await inspectDirectory(ssh, "~/.ssh", location.uid)) === "missing")
      await mkdir(ssh, { mode: 0o700 });
    const secret = await readOwnFile(privatePath, location.uid);
    if (secret.kind === "refused")
      throw new Refusal("file-unsafe", shownPrivate);
    // The private key's bytes are dropped at once; only its mode matters.
    if (secret.kind === "file" && (secret.mode & 0o077) !== 0)
      throw new Refusal("file-unsafe", shownPrivate);
    const pub = await readOwnFile(`${privatePath}.pub`, location.uid);
    if (pub.kind === "refused") throw new Refusal("file-unsafe", shownPublic);

    if (secret.kind === "missing") {
      if (pub.kind === "file") throw new Refusal("key-incomplete", shownPublic);
      const result = await run(
        [
          "ssh-keygen",
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-C",
          sourceKeyComment,
          "-f",
          privatePath,
        ],
        keygenTimeoutMs,
        env,
      );
      if (result === "timeout" || result.exitCode !== 0)
        return { kind: "failed" };
      const created = await readOwnFile(`${privatePath}.pub`, location.uid);
      const line =
        created.kind === "file"
          ? publicLine(created.bytes.toString("utf8"))
          : null;
      if (line === null) return { kind: "failed" };
      return { kind: "created", publicKey: line };
    }

    const derived = await derive();
    if (derived === null) throw new Refusal("key-invalid", shownPrivate);
    if (pub.kind === "missing") {
      await replaceFile(
        ssh,
        `${name}.pub`,
        Buffer.from(`${derived} ${sourceKeyComment}\n`, "utf8"),
        0o644,
      );
      return { kind: "created", publicKey: derived };
    }
    if (publicLine(pub.bytes.toString("utf8")) !== derived)
      throw new Refusal("key-invalid", shownPublic);
    return { kind: "present", publicKey: derived };
  } catch (error) {
    if (error instanceof Refusal)
      return {
        kind: "blocked",
        reason: error.reason as SourceKeyRefusal,
        path: error.path,
      };
    throw error;
  }
}
