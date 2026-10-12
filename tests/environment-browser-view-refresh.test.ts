import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserEntry,
  browserViewUnit,
  renderBrowserViewUnit,
  restartStaleBrowserView,
} from "../src/browser/units";
import { renderLaunchpadUnit } from "../src/update/install";
import { layout } from "../src/update/layout";
import type { ProcessResult } from "../src/update/self-check";
import { launchpadUnit, unitMarker } from "../src/update/service-control";

// The view keeps running the installation it started with after an update,
// whose convergence does not restart it (its unit text stays the same, #334).
// The supervised Launchpad, which every update restarts, restarts the view
// only when the view's unit is the installer's for this base and entry (its
// marker and its exact ExecStart line), and the Launchpad itself is the
// installed version (Pablo's review of #336).

const entry: BrowserEntry = Object.freeze({
  origin: "https://browser.vm.example.lazurio.io",
  listenPort: 4848,
});
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

/** A home whose user units are as `units` says, and a base in it. `view`
 * gives the view unit's text from the base's selector (null: no unit); the
 * installer's own text by default. */
async function world(
  units: Readonly<{
    launchpad?: "ours" | "other-base" | "none";
    view?: (selector: string) => string | null;
  }> = {},
) {
  const home = await mkdtemp(join(tmpdir(), "view-refresh-"));
  homes.push(home);
  const base = join(home, ".local", "share", "lazurio");
  const directory = join(home, ".config", "systemd", "user");
  await mkdir(directory, { recursive: true });
  const folder = join(home, "Lazurio");
  if ((units.launchpad ?? "ours") === "ours")
    await writeFile(
      join(directory, launchpadUnit),
      renderLaunchpadUnit(base, folder),
    );
  if (units.launchpad === "other-base")
    await writeFile(
      join(directory, launchpadUnit),
      renderLaunchpadUnit(join(home, "other-base"), folder),
    );
  const selector = layout(base).selector;
  const view = (
    units.view ?? ((own: string) => renderBrowserViewUnit(entry, own))
  )(selector);
  if (view !== null) await writeFile(join(directory, browserViewUnit), view);
  return { home, base, selector };
}

const installed = "/versions/0.1.8-rc.52/lazurio";
const older = "/versions/0.1.8-rc.51/lazurio";

function runner(
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

async function refresh(
  w: Awaited<ReturnType<typeof world>>,
  r: ReturnType<typeof runner>,
  options: Readonly<{
    running?: string;
    own?: string;
    readlinkFails?: boolean;
  }> = {},
) {
  return restartStaleBrowserView({
    base: w.base,
    platform: "linux",
    entry,
    run: r.run,
    env: { HOME: w.home },
    executable: "/process/exec/path",
    realpath: async (path) =>
      path === w.selector ? installed : (options.own ?? installed),
    readlink: async () => {
      if (options.readlinkFails) throw new Error("EACCES");
      return options.running ?? older;
    },
  });
}

const restarts = (r: ReturnType<typeof runner>) =>
  r.commands.filter((command) => command.includes("try-restart"));

describe("the supervised Launchpad restarts its own view when it runs another installation", () => {
  test("a view of an older installation is restarted, and one of this installation is not", async () => {
    const w = await world();
    const stale = runner({ pid: "4242" });
    expect(await refresh(w, stale)).toBe("restarted");
    expect(restarts(stale)).toEqual([
      ["systemctl", "--user", "try-restart", browserViewUnit],
    ]);
    const current = runner({ pid: "4242" });
    expect(await refresh(w, current, { running: installed })).toBe("current");
    expect(restarts(current)).toEqual([]);
  });

  test("a view whose file was replaced is restarted", async () => {
    const w = await world();
    const replaced = runner({ pid: "4242" });
    expect(
      await refresh(w, replaced, { running: `${installed} (deleted)` }),
    ).toBe("restarted");
  });

  test("a unit the installer wrote in another version's words is still the view's own", async () => {
    const w = await world({
      view: (own) =>
        renderBrowserViewUnit(entry, own).replace(
          /^Description=.*$/m,
          "Description=The view, as an older installer described it",
        ),
    });
    const r = runner({ pid: "4242" });
    expect(await refresh(w, r)).toBe("restarted");
  });

  test("a unit of the view's name that is not the installer's for this base and entry is never restarted, nor even asked", async () => {
    const others: Readonly<Record<string, (own: string) => string>> = {
      "someone else's": () =>
        "[Unit]\nDescription=someone else's view\n[Service]\nExecStart=/usr/bin/true\n",
      "without the marker": (own) =>
        renderBrowserViewUnit(entry, own).slice(unitMarker.length + 1),
      "of another base": () =>
        renderBrowserViewUnit(entry, "/elsewhere/.local/bin/lazurio"),
      "of another port": (own) =>
        renderBrowserViewUnit({ ...entry, listenPort: 4849 }, own),
      "of another origin": (own) =>
        renderBrowserViewUnit(
          { ...entry, origin: "https://browser.other.example.lazurio.io" },
          own,
        ),
    };
    for (const [name, view] of Object.entries(others)) {
      const w = await world({ view });
      const r = runner({ pid: "4242" });
      expect([name, await refresh(w, r)]).toEqual([name, "foreign-unit"]);
      expect(r.commands).toEqual([]);
    }
  });

  test("an unsupervised base, or the unit of another base, changes nothing", async () => {
    for (const launchpad of ["none", "other-base"] as const) {
      const w = await world({ launchpad });
      const r = runner({ pid: "4242" });
      expect(await refresh(w, r)).toBe("not-supervised");
      expect(r.commands).toEqual([]);
    }
    const w = await world();
    const r = runner({ pid: "4242" });
    expect(
      await restartStaleBrowserView({
        base: w.base,
        platform: "darwin",
        entry,
        run: r.run,
        env: { HOME: w.home },
        executable: installed,
      }),
    ).toBe("not-supervised");
    expect(r.commands).toEqual([]);
  });

  test("a Launchpad that is not the installed version (a source checkout) changes nothing", async () => {
    const w = await world();
    const r = runner({ pid: "4242" });
    expect(await refresh(w, r, { own: "/source/checkout/lazurio" })).toBe(
      "not-installed",
    );
    expect(r.commands).toEqual([]);
  });

  test("no view unit, no running view, an unknown manager or an unreadable process change nothing", async () => {
    const none = await world({ view: () => null });
    const noUnit = runner({ pid: "4242" });
    expect(await refresh(none, noUnit)).toBe("not-running");
    expect(noUnit.commands).toEqual([]);
    const w = await world();
    for (const pid of ["0", "", "x"]) {
      const idle = runner({ pid });
      expect(await refresh(w, idle)).toBe("not-running");
      expect(restarts(idle)).toEqual([]);
    }
    const unknown = runner({ show: "timeout" });
    expect(await refresh(w, unknown)).toBe("unknown");
    const unreadable = runner({ pid: "4242" });
    expect(await refresh(w, unreadable, { readlinkFails: true })).toBe(
      "unknown",
    );
    expect(restarts(unreadable)).toEqual([]);
  });

  test("a restart the manager refuses is reported", async () => {
    const w = await world();
    expect(await refresh(w, runner({ pid: "4242", restart: 1 }))).toBe(
      "failed",
    );
  });
});
