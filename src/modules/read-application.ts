import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { selectModuleApplication } from "./manifest";
import { planModuleRuntime } from "./runtime";

// Read-only adapter for an explicitly selected, stable, caller-owned module.
// This is neither Organization discovery nor an authorization/process lease.
async function readDeclaration(path: string) {
  const before = await lstat(path);
  const safe = (stat: typeof before) =>
    stat.isFile() &&
    stat.nlink === 1 &&
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o022) === 0 &&
    stat.size <= 1024 * 1024;
  if (!safe(before)) throw new Error("Unsafe declaration file");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (!safe(opened) || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Declaration changed before read");
    // Bounded even if a concurrent writer grows the file after stat.
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(path);
    if (
      !safe(after) ||
      count !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw new Error("Declaration changed during read");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, count),
      ),
    ) as unknown;
  } finally {
    await file.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Declaration object required");
  return value as Record<string, unknown>;
}

export async function readModuleApplication(
  moduleDirectory: string,
  requestedPackage?: string,
) {
  if (process.platform === "win32")
    throw new Error("Unqualified module reader platform");
  const root = await inspectOwnedDirectory(moduleDirectory);
  const manifest = await readDeclaration(
    join(moduleDirectory, "lazurio.module.json"),
  );
  const selection = selectModuleApplication(manifest, requestedPackage);
  if (selection.kind !== "selected") return selection;
  const packagePath = join(moduleDirectory, selection.package);
  // Check each intermediate directory, not just the final package parent.
  let directory = moduleDirectory;
  const parents = dirname(selection.package);
  if (parents !== ".")
    for (const segment of parents.split("/")) {
      directory = join(directory, segment);
      await inspectOwnedDirectory(directory);
    }
  const pkg = record(await readDeclaration(packagePath));
  if (pkg.companyascode && Object.hasOwn(record(pkg.companyascode), "app"))
    throw new Error("Legacy app declaration requires explicit adoption");
  const runtime = record(pkg.lazurio).runtime;
  const plan = planModuleRuntime(
    manifest,
    runtime,
    selection.package,
    pkg.scripts,
  );
  const after = await inspectOwnedDirectory(moduleDirectory);
  if (after.dev !== root.dev || after.ino !== root.ino)
    throw new Error("Module directory changed");
  return Object.freeze({
    ...plan,
    // Include package hooks/toolchain/dependencies, not only the selected script.
    // This is a local change detector, never a publisher or authority proof.
    declarationDigest: createHash("sha256")
      .update(JSON.stringify({ manifest, pkg }))
      .digest("hex"),
  });
}
