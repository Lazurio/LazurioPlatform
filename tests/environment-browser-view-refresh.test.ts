import { describe, expect, test } from "bun:test";
import { restartStaleBrowserView } from "../src/browser/units";
import type { ProcessResult } from "../src/update/self-check";

// The view keeps running the installation it started with after an update,
// whose convergence does not restart it (its unit text stays the same). The
// Launchpad, which every update restarts, restarts a view that runs another
// installation (decision F47).

const own = "/home/person/.local/share/lazurio/versions/0.1.8-rc.52/lazurio";
const older = "/home/person/.local/share/lazurio/versions/0.1.8-rc.51/lazurio";

function harness(
  answers: Readonly<{ pid?: string; show?: ProcessResult; restart?: number }>,
) {
  const commands: string[][] = [];
  const run = async (command: readonly string[]): Promise<ProcessResult> => {
    commands.push([...command]);
    if (command.includes("show"))
      return answers.show ?? { exitCode: 0, stdout: `${answers.pid ?? "0"}\n` };
    return { exitCode: answers.restart ?? 0, stdout: "" };
  };
  return { commands, run };
}

describe("a view that runs another installation is restarted", () => {
  test("a view of an older installation is restarted, and one of this installation is not", async () => {
    const stale = harness({ pid: "4242" });
    expect(
      await restartStaleBrowserView({
        run: stale.run,
        env: {},
        executable: own,
        readlink: async () => older,
        realpath: async (path) => path,
      }),
    ).toBe("restarted");
    expect(stale.commands.at(-1)).toEqual([
      "systemctl",
      "--user",
      "try-restart",
      "lazurio-browser-view.service",
    ]);
    const current = harness({ pid: "4242" });
    expect(
      await restartStaleBrowserView({
        run: current.run,
        env: {},
        executable: own,
        readlink: async () => own,
        realpath: async (path) => path,
      }),
    ).toBe("current");
    expect(current.commands.some((c) => c.includes("try-restart"))).toBe(false);
  });

  test("a view whose file was replaced is restarted", async () => {
    const replaced = harness({ pid: "4242" });
    expect(
      await restartStaleBrowserView({
        run: replaced.run,
        env: {},
        executable: own,
        readlink: async () => `${own} (deleted)`,
        realpath: async (path) => path,
      }),
    ).toBe("restarted");
  });

  test("our executable is compared by its real path", async () => {
    const viaSelector = harness({ pid: "4242" });
    expect(
      await restartStaleBrowserView({
        run: viaSelector.run,
        env: {},
        executable: "/home/person/.local/share/lazurio/bin/lazurio",
        readlink: async () => own,
        realpath: async () => own,
      }),
    ).toBe("current");
  });

  test("no running view, an unknown manager or an unreadable process changes nothing", async () => {
    for (const pid of ["0", "", "x"]) {
      const idle = harness({ pid });
      expect(
        await restartStaleBrowserView({
          run: idle.run,
          env: {},
          executable: own,
          readlink: async () => older,
          realpath: async (path) => path,
        }),
      ).toBe("not-running");
      expect(idle.commands.some((c) => c.includes("try-restart"))).toBe(false);
    }
    const unknown = harness({ show: "timeout" });
    expect(
      await restartStaleBrowserView({
        run: unknown.run,
        env: {},
        executable: own,
      }),
    ).toBe("unknown");
    const unreadable = harness({ pid: "4242" });
    expect(
      await restartStaleBrowserView({
        run: unreadable.run,
        env: {},
        executable: own,
        readlink: async () => {
          throw new Error("EACCES");
        },
        realpath: async (path) => path,
      }),
    ).toBe("unknown");
    expect(unreadable.commands.some((c) => c.includes("try-restart"))).toBe(
      false,
    );
  });

  test("a restart the manager refuses is reported", async () => {
    const refused = harness({ pid: "4242", restart: 1 });
    expect(
      await restartStaleBrowserView({
        run: refused.run,
        env: {},
        executable: own,
        readlink: async () => older,
        realpath: async (path) => path,
      }),
    ).toBe("failed");
  });
});
