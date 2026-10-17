import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { renameNoReplace } from "../platform/rename";
import type { ContentGit } from "./git";
import { sameRepository } from "./model";

// Materialization of one ABSENT repository (docs/content-sync.md): clone into
// a temporary sibling of the destination on the same filesystem, verify the
// clone (remote identity, branch `main`, the inspected commit and, for an
// Organization root, its declaration), then publish it with a no-replace
// rename. An occupied destination is never touched. An interrupted run leaves
// only its own temporary sibling, recognized by its exact name and marker and
// removed only by this operation, under the content lock, the next time it
// materializes the same destination.

/** The marker file inside every temporary sibling this operation creates. */
export const materializationMarker = ".lazurio-content";
const markerText = "lazurio-content-materialization-v1\n";
const temporaryPattern = (name: string) =>
  new RegExp(
    `^\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.lazurio-content-[0-9a-f]{16}$`,
  );

/** A destination name this operation may create: one path segment, not
 * hidden (hidden entries are never catalog candidates), no separators. */
export const isDestinationName = (name: string) =>
  /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(name) && !name.endsWith(".");

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Whether `directory` is a temporary sibling this operation created: a real
 * directory of the operator holding exactly the marker it writes. */
async function isOwnTemporary(directory: string): Promise<boolean> {
  try {
    await inspectCheckoutDirectory(directory);
    const marker = join(directory, materializationMarker);
    const stat = await lstat(marker);
    if (!stat.isFile() || stat.size !== Buffer.byteLength(markerText))
      return false;
    return (await readFile(marker, "utf8")) === markerText;
  } catch {
    return false;
  }
}

/** Removes this operation's own leftovers for `name` in `parent`; anything
 * else that only looks like one is left exactly as it is. Returns how many
 * were removed. */
export async function removeOwnLeftovers(
  parent: string,
  name: string,
): Promise<number> {
  const pattern = temporaryPattern(name);
  let removed = 0;
  for (const entry of await readdir(parent)) {
    if (!pattern.test(entry)) continue;
    const path = join(parent, entry);
    if (!(await isOwnTemporary(path))) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Whether the destination, or an entry differing from it only by letter
 * case (one entry on a case-insensitive filesystem), is there. */
async function occupied(parent: string, name: string): Promise<boolean> {
  if (await present(join(parent, name))) return true;
  const lower = name.toLowerCase();
  return (await readdir(parent)).some(
    (entry) => entry !== name && entry.toLowerCase() === lower,
  );
}

export type MaterializeRequest = Readonly<{
  /** An existing, real directory of the operator's checkout. */
  parent: string;
  /** The destination's name in `parent` (`isDestinationName`). */
  name: string;
  /** The expected `<owner>/<name>` of the clone's `origin`. */
  repository: string;
  url: string;
  credentialHelper?: string | undefined;
  git: ContentGit;
  /** More verification of the clone before it is published (the
   * declaration of an Organization root): a failure code, or null. */
  verify?: (checkout: string) => Promise<string | null>;
  /** The destination's final name, read from the verified clone: on a public
   * Environment an Organization root's repository name as its own
   * declaration spells it (decision F55's addendum of 2026-10-17), where the
   * request only knows the handover's lowercase slug. It may differ from
   * `name` by letter case only. Absent: `name`. */
  finalName?: (checkout: string) => Promise<string>;
}>;

export type MaterializeResult =
  | Readonly<{ kind: "materialized"; directory: string; commit: string }>
  | Readonly<{ kind: "occupied" }>
  | Readonly<{
      kind: "failed";
      code:
        | "destination-invalid"
        | "clone-failed"
        | "checkout-unexpected"
        | "publish-failed"
        | string;
    }>;

/** What `fill` makes of a temporary sibling's checkout: ready to publish,
 * with what it learned on the way, or a failure code. `name`: the final name
 * the checkout is published under, when the fill learned its spelling; it
 * may differ from the requested name by letter case only. */
export type FillOutcome<T> =
  | Readonly<{ kind: "ready"; value: T; name?: string }>
  | Readonly<{ kind: "failed"; code: string }>;

export type PublishResult<T> =
  | Readonly<{ kind: "published"; directory: string; value: T }>
  | Readonly<{ kind: "occupied" }>
  | Readonly<{ kind: "failed"; code: string }>;

/**
 * Publishes one ABSENT directory `name` in `parent` (see the module comment):
 * `fill` makes it at `checkout`, a path of a temporary sibling that does not
 * exist yet, and answers whether it may be published; only then is it moved
 * into place with a rename that never replaces anything. A clone of
 * `materializeRepository`, and a new module of `lazurio module create`
 * (decision F52). An exception of `fill` is `publish-failed`; the temporary
 * sibling is removed in every case. A final name the fill gives (`FillOutcome`)
 * must be a destination name that differs from `name` by letter case only,
 * and is checked again for an occupant, in any letter case, before the
 * rename: the temporary sibling and its leftovers keep the requested name.
 */
export async function publishNewCheckout<T>(
  request: Readonly<{
    parent: string;
    name: string;
    fill: (checkout: string) => Promise<FillOutcome<T>>;
  }>,
): Promise<PublishResult<T>> {
  if (!isDestinationName(request.name))
    return { kind: "failed", code: "destination-invalid" };
  try {
    await inspectCheckoutDirectory(request.parent);
  } catch {
    return { kind: "failed", code: "destination-invalid" };
  }
  await removeOwnLeftovers(request.parent, request.name);
  if (await occupied(request.parent, request.name)) return { kind: "occupied" };
  const temporary = join(
    request.parent,
    `.${request.name}.lazurio-content-${randomBytes(8).toString("hex")}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    const marker = await open(
      join(temporary, materializationMarker),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await marker.writeFile(markerText);
      await marker.sync();
    } finally {
      await marker.close();
    }
    const checkout = join(temporary, "checkout");
    const filled = await request.fill(checkout);
    if (filled.kind === "failed") return filled;
    const name = filled.name ?? request.name;
    if (name !== request.name) {
      if (
        !isDestinationName(name) ||
        name.toLowerCase() !== request.name.toLowerCase()
      )
        return { kind: "failed", code: "destination-invalid" };
      // The requested name was free in any letter case before the fill; an
      // entry that appeared meanwhile in another one stays untouched, also
      // on a case-sensitive filesystem, where the kernel would not see it.
      if (await occupied(request.parent, name)) return { kind: "occupied" };
    }
    const destination = join(request.parent, name);
    // The kernel decides: an entry that appeared meanwhile stays untouched.
    if (renameNoReplace(checkout, destination) === "exists")
      return { kind: "occupied" };
    return { kind: "published", directory: destination, value: filled.value };
  } catch {
    return { kind: "failed", code: "publish-failed" };
  } finally {
    // Only this run's own temporary sibling: after a publish just the marker.
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Materializes one absent repository; see the module comment. */
export async function materializeRepository(
  request: MaterializeRequest,
): Promise<MaterializeResult> {
  const result = await publishNewCheckout({
    parent: request.parent,
    name: request.name,
    fill: async (checkout): Promise<FillOutcome<string>> => {
      const cloned = await request.git.clone({
        url: request.url,
        directory: checkout,
        branch: "main",
        credentialHelper: request.credentialHelper,
      });
      if (cloned !== "cloned") return { kind: "failed", code: "clone-failed" };
      const observed = await request.git.inspect(checkout);
      if (
        observed.kind !== "checkout" ||
        observed.branch !== "main" ||
        !sameRepository(observed.repository, request.repository)
      )
        return { kind: "failed", code: "checkout-unexpected" };
      const refused = (await request.verify?.(checkout)) ?? null;
      if (refused !== null) return { kind: "failed", code: refused };
      return request.finalName === undefined
        ? { kind: "ready", value: observed.commit }
        : {
            kind: "ready",
            value: observed.commit,
            name: await request.finalName(checkout),
          };
    },
  });
  return result.kind === "published"
    ? {
        kind: "materialized",
        directory: result.directory,
        commit: result.value,
      }
    : result;
}

/** Creates the missing directories of `segments` below `root`, each one a
 * real directory of the operator, and returns the last. Throws when an
 * existing one is not (a link, a file, another account's). */
export async function ensureCheckoutDirectories(
  root: string,
  segments: readonly string[],
  mode = 0o755,
): Promise<string> {
  let directory = root;
  await inspectCheckoutDirectory(directory);
  for (const segment of segments) {
    if (!isDestinationName(segment)) throw new Error("Invalid path segment");
    directory = join(directory, segment);
    try {
      await mkdir(directory, { mode });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await inspectCheckoutDirectory(directory);
  }
  return directory;
}
