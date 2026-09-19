import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import { PublishError } from "./errors";
import { timestampPath } from "./metadata";
import type { Plan, PlannedWrite, Tree } from "./repository";

/** Filesystem adapter of the publisher: a directory as the published tree. */
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? "",
  );

export function directoryTree(directory: string): Tree {
  return Object.freeze({
    async read(path: string) {
      try {
        return await readFile(join(directory, path));
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    async list(path: string) {
      try {
        const entries = await readdir(join(directory, path), {
          withFileTypes: true,
        });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
  });
}

export async function hashFile(
  path: string,
): Promise<Readonly<{ sha256: string; length: number }>> {
  const hash = createHash("sha256");
  let length = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    length += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), length };
}

const safePath = (path: string) =>
  /^(metadata|targets)\/[A-Za-z0-9._/+-]+$/.test(path) &&
  !path.split("/").some((part) => part === "" || part === "." || part === "..");

/** Apply a plan to the tree directory.
 *
 * Nothing immutable is ever rewritten: every planned path that already exists
 * must hold exactly the planned bytes, and this is decided for the WHOLE plan
 * before the first byte is written, so a refusal changes nothing. Files are
 * then created exclusively, in plan order; `metadata/timestamp.json` — the
 * one mutable file, and what makes the rest visible — is replaced last, by
 * temporary file and rename. Nothing is deleted.
 */
export async function applyPlan(
  directory: string,
  plan: Pick<Plan<unknown>, "writes">,
): Promise<readonly string[]> {
  const { writes } = plan;
  const timestampAt = writes.findIndex((write) => write.path === timestampPath);
  if (
    writes.some((write) => !safePath(write.path)) ||
    new Set(writes.map((write) => write.path)).size !== writes.length ||
    (timestampAt !== -1 && timestampAt !== writes.length - 1)
  )
    throw new PublishError("invalid-input", "plan");
  const pending: PlannedWrite[] = [];
  for (const write of writes) {
    const path = join(directory, write.path);
    if (write.path === timestampPath) {
      pending.push(write);
      continue;
    }
    const exists = await stat(path).then(
      (entry) => entry.isFile() || "other",
      (error) => {
        if (missing(error)) return false;
        throw error;
      },
    );
    if (exists === false) {
      pending.push(write);
      continue;
    }
    const same =
      exists === true &&
      ("bytes" in write
        ? write.bytes.equals(await readFile(path))
        : (await hashFile(path)).sha256 === write.sha256);
    if (!same) throw new PublishError("immutable-conflict", write.path);
  }
  const written: string[] = [];
  for (const write of pending) {
    const path = join(directory, write.path);
    await mkdir(dirname(path), { recursive: true });
    if (write.path === timestampPath && "bytes" in write)
      await writeDurableFile(dirname(path), "timestamp.json", write.bytes);
    else if ("bytes" in write)
      await writeFile(path, write.bytes, { flag: "wx", mode: 0o644 });
    else {
      if ((await hashFile(write.file)).sha256 !== write.sha256)
        throw new PublishError("invalid-input", write.path);
      await copyFile(write.file, path, 1 /* COPYFILE_EXCL */);
    }
    written.push(write.path);
  }
  return written;
}
