import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeMachineFolder,
  refreshMachineFolderAndLaunchpad,
} from "../src/machine/cli";
import {
  type LaunchpadSeams,
  recordedEntry,
  restartLaunchpadForEntry,
} from "../src/machine/launchpad-entry";
import type { ServiceControl } from "../src/update/service-control";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// The running Launchpad reads its entry only when it starts: a refresh that
// records a different entry must restart the supervised Launchpad of this
// Folder, or a route the handover gained (the Environment browser) stays
// unknown to it. Found on the first Environment that received the browser:
// the apply recorded `entry.browser` and the Launchpad answered
// `not-declared` until it was restarted by hand.

const host = "workspace.example.lazurio.io";
const noChoices = {
  preset: undefined,
  locale: undefined,
  detail: undefined,
  coordination: undefined,
} as const;

async function adoptedFolder() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "entry-restart-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeMachineFolder(folder, organizationWithEntry(), noChoices);
  return { parent, folder };
}

// The supervised Launchpad of `folder`: it records every restart, and fails
// the restart or never answers again when told to.
function supervised(
  folder: string | undefined,
  options: Readonly<{ fails?: boolean; answers?: boolean }> = {},
) {
  const restarts: number[] = [];
  const service: ServiceControl = {
    folder,
    async restartLaunchpad() {
      restarts.push(Date.now());
      if (options.fails) throw new Error("Service restart failed");
    },
    launchpadVersion: async () => (options.answers === false ? null : "1.0.0"),
  };
  const seams: LaunchpadSeams = {
    service: async () => service,
    version: "1.0.0",
    deadlineMs: 50,
  };
  return { restarts, seams };
}

test("only the installer's unit that starts this Folder is restarted, and it must answer again", async () => {
  const folder = "/home/example/Lazurio";
  const none: LaunchpadSeams = { service: async () => null, version: "1.0.0" };
  expect(await restartLaunchpadForEntry(folder, none)).toBe("not-supervised");
  const unreadable: LaunchpadSeams = {
    service: () => Promise.reject(new Error("no user manager")),
    version: "1.0.0",
  };
  expect(await restartLaunchpadForEntry(folder, unreadable)).toBe(
    "not-supervised",
  );

  const other = supervised("/home/someone/Lazurio");
  expect(await restartLaunchpadForEntry(folder, other.seams)).toBe(
    "not-supervised",
  );
  expect(other.restarts).toHaveLength(0);

  const failing = supervised(folder, { fails: true });
  expect(await restartLaunchpadForEntry(folder, failing.seams)).toBe(
    "restart-failed",
  );
  const silent = supervised(folder, { answers: false });
  expect(await restartLaunchpadForEntry(folder, silent.seams)).toBe(
    "restart-failed",
  );
  expect(silent.restarts).toHaveLength(1);

  const healthy = supervised(folder);
  expect(await restartLaunchpadForEntry(folder, healthy.seams)).toBe(
    "restarted",
  );
  expect(healthy.restarts).toHaveLength(1);
});

test.skipIf(process.platform === "win32")(
  "a refresh that records a different entry restarts the Launchpad once; the same entry again restarts nothing",
  async () => {
    const { parent, folder } = await adoptedFolder();
    try {
      const withBrowser = organizationWithEntry(20000, host, true);
      const before = await recordedEntry(folder);
      expect(before).not.toBeNull();
      expect(before).not.toContain("browserOrigin");

      const { restarts, seams } = supervised(folder);
      expect(
        await refreshMachineFolderAndLaunchpad(
          folder,
          withBrowser,
          undefined,
          seams,
        ),
      ).toEqual({
        code: 0,
        result: { kind: "refreshed", revision: 2, launchpad: "restarted" },
      });
      expect(restarts).toHaveLength(1);
      expect(await recordedEntry(folder)).toContain(
        `"browserOrigin":"https://browser.${host}"`,
      );

      // The same handover again: nothing written, nothing restarted, and the
      // answer is the refresh's own.
      expect(
        await refreshMachineFolderAndLaunchpad(
          folder,
          withBrowser,
          undefined,
          seams,
        ),
      ).toEqual({ code: 0, result: { kind: "unchanged" } });
      expect(restarts).toHaveLength(1);

      // Another Folder's unit: the entry is recorded, the Launchpad takes it
      // at its next start, and the answer says so.
      const elsewhere = supervised("/home/someone/Lazurio");
      expect(
        await refreshMachineFolderAndLaunchpad(
          folder,
          organizationWithEntry(20001, host, true),
          undefined,
          elsewhere.seams,
        ),
      ).toEqual({
        code: 0,
        result: { kind: "refreshed", revision: 3, launchpad: "not-supervised" },
      });
      expect(elsewhere.restarts).toHaveLength(0);

      // Without the Launchpad's seams (the library callers), the refresh
      // restarts nothing and answers as before.
      expect(
        await refreshMachineFolderAndLaunchpad(
          folder,
          organizationWithEntry(20002, host, true),
          undefined,
          undefined,
        ),
      ).toEqual({ code: 0, result: { kind: "refreshed", revision: 4 } });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
