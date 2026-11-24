import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processBrainHost } from "../src/brain/host";
import { initializeMachineFolder } from "../src/machine/cli";
import { binding } from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";

// #1214: an update restarts the Launchpad and then refreshes the Folder; the
// Launchpad's setup of the person's memory reads the Folder meanwhile. A
// Folder in the middle of a change is not a verdict on the Environment: the
// brain's context is `folder-unreadable`, which setup waits for, never
// `not-personal`, which it would take as final.

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test.skipIf(process.platform !== "linux")(
  "a hosted Personal Folder with a change in flight is folder-unreadable, and supported again once it is done",
  async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "brain-host-")));
    const home = join(root, "home");
    const folder = join(home, "Lazurio");
    await mkdir(home, { mode: 0o700 });
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o700 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    await initializeMachineFolder(folder, binding(personal), {
      preset: undefined,
      locale: undefined,
      detail: undefined,
      coordination: undefined,
    });
    const host = processBrainHost({
      hostedFolder: async () => folder,
      env: { HOME: home, PATH: process.env.PATH },
      platform: "linux",
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      service: async () => ({ exitCode: 0, stdout: "" }),
    });
    expect(await host.context()).toEqual({ kind: "supported" });
    // A change in flight: its transaction is there while the refresh writes.
    const transaction = join(folder, ".lazurio", "transaction");
    await mkdir(transaction, { mode: 0o700 });
    expect(await host.context()).toEqual({
      kind: "unsupported",
      reason: "folder-unreadable",
    });
    await rm(transaction, { recursive: true });
    expect(await host.context()).toEqual({ kind: "supported" });
  },
);
