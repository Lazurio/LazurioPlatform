import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Key } from "@tufjs/models";
import { PublishError } from "../src/publish/errors";
import {
  generateSigner,
  isRoleName,
  keyFromDocument,
  privateKeyPem,
  publicKeyDocument,
  type Signer,
  signerFromPem,
} from "../src/publish/keys";
import { parseMetadata } from "../src/publish/metadata";
import { initialRoot, nextRoot, rootRoleKeys } from "../src/publish/root";

/** Key tool of the release ceremony (docs/release-keys.md). It runs on the
 * Principal's own Machine, never in CI. It never prints, logs or transmits a
 * private key: the only place private material goes is the `0600` file of
 * `generate`.
 */
export const releaseKeysHelp = `generate --role <root|targets|snapshot|timestamp> --out <absolute directory outside any repository>
  Creates an Ed25519 key: <role>.private.pem (mode 0600, never overwritten) and
  <role>.public.json. Prints the key id and the two paths, never the key.
init-root --root-key <root.private.pem> --targets <targets.public.json>
  --snapshot <snapshot.public.json> --timestamp <timestamp.public.json>
  --out <release/root.json> [--lifetime-days <days, default 365>]
  Writes root version 1 (threshold 1 per role), signed by the root key.
rotate-root --current <release/root.json> --root-key <current root.private.pem>
  [--new-root-key <new root.private.pem>] [--targets <public.json>]
  [--snapshot <public.json>] [--timestamp <public.json>]
  --out <file> [--lifetime-days <days>]
  Writes root N+1 signed by the current and the new root key. Roles without an
  option keep their key, so the same command renews an expiring root.
  --out may equal --current; the previous root stays in Git history and in the
  published tree.`;

type Output = Readonly<{ code: number; stdout: string; stderr: string }>;

async function readPrivateKey(path: string): Promise<Signer> {
  const stat = await lstat(path);
  // Custody: a private key readable by another account is already disclosed.
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new PublishError("key-invalid", "private key file must be 0600");
  return signerFromPem(await readFile(path, "utf8"));
}

async function readPublicKey(path: string): Promise<Key> {
  return keyFromDocument(JSON.parse(await readFile(path, "utf8")));
}

function insideRepository(directory: string): boolean {
  let probe = directory;
  // The nearest existing ancestor decides; the directory may not exist yet.
  for (;;) {
    const result = Bun.spawnSync(
      ["git", "-C", probe, "rev-parse", "--is-inside-work-tree"],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (result.exitCode === 0)
      return result.stdout.toString().trim() === "true";
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
}

const lifetime = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,3}$/.test(value))
    throw new PublishError("invalid-input", "lifetime-days");
  return Number(value);
};

export async function runReleaseKeys(
  args: readonly string[],
  now: () => Date = () => new Date(),
): Promise<Output> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        role: { type: "string" },
        out: { type: "string" },
        "root-key": { type: "string" },
        "new-root-key": { type: "string" },
        current: { type: "string" },
        targets: { type: "string" },
        snapshot: { type: "string" },
        timestamp: { type: "string" },
        "lifetime-days": { type: "string" },
      },
    });
    const out = values.out;
    if (positionals.length !== 1 || out === undefined)
      return { code: 2, stdout: "", stderr: releaseKeysHelp };
    const lifetimeDays = lifetime(values["lifetime-days"]);
    const options = lifetimeDays === undefined ? {} : { lifetimeDays };

    if (positionals[0] === "generate") {
      if (!isRoleName(values.role))
        throw new PublishError("invalid-input", "role");
      if (!isAbsolute(out) || resolve(out) !== out)
        throw new PublishError("invalid-input", "out must be absolute");
      if (insideRepository(out))
        throw new PublishError(
          "invalid-input",
          "keys are never generated inside a repository",
        );
      await mkdir(out, { recursive: true, mode: 0o700 });
      const signer = generateSigner();
      const secretPath = join(out, `${values.role}.private.pem`);
      const publicPath = join(out, `${values.role}.public.json`);
      await writeFile(secretPath, privateKeyPem(signer), {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(
        publicPath,
        `${JSON.stringify(publicKeyDocument(signer), null, 2)}\n`,
        { flag: "wx", mode: 0o644 },
      );
      return {
        code: 0,
        stdout: [
          `role: ${values.role}`,
          `key id: ${signer.key.keyID}`,
          `private key (keep secret, mode 0600): ${secretPath}`,
          `public key: ${publicPath}`,
        ].join("\n"),
        stderr: "",
      };
    }

    if (positionals[0] === "init-root") {
      if (
        !values["root-key"] ||
        !values.targets ||
        !values.snapshot ||
        !values.timestamp
      )
        return { code: 2, stdout: "", stderr: releaseKeysHelp };
      const rootSigner = await readPrivateKey(values["root-key"]);
      const bytes = initialRoot({
        keys: {
          root: [rootSigner.key],
          targets: [await readPublicKey(values.targets)],
          snapshot: [await readPublicKey(values.snapshot)],
          timestamp: [await readPublicKey(values.timestamp)],
        },
        rootSigner,
        now: now(),
        ...options,
      });
      await mkdir(dirname(resolve(out)), { recursive: true });
      await writeFile(out, bytes, { flag: "wx", mode: 0o644 });
      return { code: 0, stdout: describe(bytes, out), stderr: "" };
    }

    if (positionals[0] === "rotate-root") {
      if (!values.current || !values["root-key"])
        return { code: 2, stdout: "", stderr: releaseKeysHelp };
      const current = await readFile(values.current);
      const outgoing = await readPrivateKey(values["root-key"]);
      const incoming =
        values["new-root-key"] === undefined
          ? outgoing
          : await readPrivateKey(values["new-root-key"]);
      const kept = rootRoleKeys(current);
      const replaced = async (
        path: string | undefined,
        keys: readonly Key[],
      ) => (path === undefined ? keys : [await readPublicKey(path)]);
      const bytes = nextRoot({
        current,
        keys: {
          root: [incoming.key],
          targets: await replaced(values.targets, kept.targets),
          snapshot: await replaced(values.snapshot, kept.snapshot),
          timestamp: await replaced(values.timestamp, kept.timestamp),
        },
        rootSigners: [outgoing, incoming],
        now: now(),
        ...options,
      });
      if (resolve(out) === resolve(values.current)) {
        const temporary = `${out}.next`;
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
        await rename(temporary, out);
      } else await writeFile(out, bytes, { flag: "wx", mode: 0o644 });
      return { code: 0, stdout: describe(bytes, out), stderr: "" };
    }
    return { code: 2, stdout: "", stderr: releaseKeysHelp };
  } catch (error) {
    // Never the raw error: a parser may quote its input.
    return {
      code: 1,
      stdout: "",
      stderr:
        error instanceof PublishError
          ? `Refused: ${error.message}`
          : `Refused: ${(error as NodeJS.ErrnoException | undefined)?.code ?? "invalid arguments or input"}`,
    };
  }
}

function describe(rootBytes: Buffer, path: string): string {
  const root = parseMetadata("root", rootBytes).signed;
  return [
    `root version ${root.version}, expires ${root.expires}: ${path}`,
    ...(["root", "targets", "snapshot", "timestamp"] as const).map(
      (role) =>
        `${role}: ${(root.roles[role]?.keyIDs ?? []).join(", ")} (threshold ${root.roles[role]?.threshold})`,
    ),
  ].join("\n");
}

if (import.meta.main) {
  const output = await runReleaseKeys(process.argv.slice(2));
  if (output.stdout) console.log(output.stdout);
  if (output.stderr) console.error(output.stderr);
  process.exitCode = output.code;
}
