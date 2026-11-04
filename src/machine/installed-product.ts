import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  developmentCommit,
  developmentVersion,
  embeddedFixture,
  embeddedIdentity,
  type ProductIdentity,
} from "../update/identity";
import { executableName } from "../update/layout";
import { MachineContextError } from "./context";

/** The one base trusted to hold the installed product on a hosted
 * Environment: where the Machines role installs it
 * (`lazurio install --base ~/.local/share/lazurio`, docs/machine-handover.md),
 * under the operator's home from the system record. It is not resolved
 * through `XDG_DATA_HOME` or any other variable: a process could point that
 * at a base of its own (decision F68). */
export const trustedInstallBase = (operatorHome: string) =>
  join(operatorHome, ".local", "share", "lazurio");

/** What decides whether this process is the installed product. */
export type RunningProduct = Readonly<{
  identity: ProductIdentity;
  fixture: boolean;
  /** The file this process runs, links resolved. */
  executable: string;
}>;

/** This process, as the kernel and its build say: never from flags, `PATH`
 * or the environment. */
export async function runningProduct(): Promise<RunningProduct> {
  return Object.freeze({
    identity: embeddedIdentity(),
    fixture: embeddedFixture() !== undefined,
    executable: await realpath(
      process.platform === "linux" ? "/proc/self/exe" : process.execPath,
    ),
  });
}

/** Decision F68: an operation that acts on the declared operator's Folder or
 * home from the handover runs only in the installed product. That is a built
 * identity, not a fixture build, running from `versions/<its version>/` under
 * the trusted base. A source run, a test in process and a pull request's own
 * build, wherever it lies, are refused before anything is read for writing.
 * There is no switch. */
export async function requireInstalledProduct(
  running: RunningProduct,
  operatorHome: string,
  resolve: (path: string) => Promise<string> = realpath,
): Promise<void> {
  const refuse = () => new MachineContextError("machine-not-installed-product");
  if (
    running.identity.version === developmentVersion ||
    running.identity.commit === developmentCommit ||
    running.fixture
  )
    throw refuse();
  // The file must lie at exactly versions/<version>/lazurio under the trusted
  // base itself: the base is resolved once (a home may be a link), and below
  // it nothing may be a link, so a version directory or file that links to a
  // build elsewhere (a worktree) is refused. The selector bin/lazurio stays a
  // link: /proc/self/exe already names the file it points to (#789 review).
  let expected: string;
  try {
    const base = await resolve(trustedInstallBase(operatorHome));
    expected = join(base, "versions", running.identity.version, executableName);
    if ((await resolve(expected)) !== expected) throw refuse();
  } catch {
    throw refuse();
  }
  if (running.executable !== expected) throw refuse();
}
