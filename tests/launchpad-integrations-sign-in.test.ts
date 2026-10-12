import { describe, expect, test } from "bun:test";
import type { MachineEntry } from "../src/folder/machine-binding";
import type { LaunchpadHolder } from "../src/launchpad/new-tab/holder";
import { environmentBrowserOf, launchpadHoldOf } from "../src/launchpad/server";

// An Integrace sign-in opens in the Environment browser and shows in the
// Launchpad's panel, whose strip lists the tabs the Launchpad holds (F47
// point 9's addendum of 2026-10-12). It shows only a tab the Launchpad holds:
// a hold that fails, or a Launchpad with no holder, answers that the browser
// cannot open it now (Pablo's review of #324). The hub opens it, as every
// other tab (root decision 0191's addendum of 2026-10-12, F47 point 6).

const tab = "0123456789ABCDEF0123456789ABCDEF";
const entry = {
  browserOrigin: "https://browser.workspace.example.lazurio.io",
  browserListenPort: 4848,
} as unknown as MachineEntry;
const created = async () => ({ kind: "opened", tab }) as const;

describe("the Integrace sign-in in the Environment browser", () => {
  test("the hub opens it, a window of its own for the Launchpad's strip", async () => {
    const asked: unknown[] = [];
    const open = environmentBrowserOf(
      entry,
      async () => undefined,
      async (browser, url, strip) => {
        asked.push([browser, url, strip]);
        return { kind: "opened", tab } as const;
      },
    );
    expect(await open?.("https://accounts.example.com/sign-in")).toEqual({
      view: `https://browser.workspace.example.lazurio.io/t/${tab}`,
    });
    expect(asked).toEqual([
      [
        {
          origin: "https://browser.workspace.example.lazurio.io",
          listenPort: 4848,
        },
        "https://accounts.example.com/sign-in",
        "launchpad",
      ],
    ]);
  });

  test("a hub that refuses or does not answer opens nothing and holds nothing", async () => {
    const held: string[] = [];
    for (const reason of ["hub-unreachable", "invalid-request"] as const) {
      const open = environmentBrowserOf(
        entry,
        async (target) => {
          held.push(target);
        },
        async () => ({ kind: "refused", reason }) as const,
      );
      expect(await open?.("https://accounts.example.com/sign-in")).toBeNull();
    }
    expect(held).toEqual([]);
  });

  test("shows a tab only once the Launchpad holds it", async () => {
    const held: string[] = [];
    const open = environmentBrowserOf(
      entry,
      async (target) => {
        held.push(target);
      },
      created,
    );
    expect(await open?.("https://accounts.example.com/sign-in")).toEqual({
      view: `https://browser.workspace.example.lazurio.io/t/${tab}`,
    });
    expect(held).toEqual([tab]);
  });

  test("a hold that fails answers that the browser cannot open it now", async () => {
    const open = environmentBrowserOf(
      entry,
      async () => {
        throw new Error("holder full");
      },
      created,
    );
    expect(await open?.("https://accounts.example.com/sign-in")).toBeNull();
  });

  test("without a holder (no usable runtime directory) it fails closed", async () => {
    await expect(launchpadHoldOf(null)(tab)).rejects.toThrow();
    const open = environmentBrowserOf(entry, launchpadHoldOf(null), created);
    expect(await open?.("https://accounts.example.com/sign-in")).toBeNull();
  });

  test("with a holder, the hold goes to it", async () => {
    const held: string[] = [];
    const holder = {
      hold: async (id: string) => {
        held.push(id);
      },
    } as unknown as LaunchpadHolder;
    await launchpadHoldOf(holder)(tab);
    expect(held).toEqual([tab]);
  });

  test("a workstation has no Environment browser, and an entry without its view creates no tab", async () => {
    expect(
      environmentBrowserOf(null, launchpadHoldOf(null), created),
    ).toBeNull();
    let calls = 0;
    const open = environmentBrowserOf(
      {} as unknown as MachineEntry,
      launchpadHoldOf(null),
      async () => {
        calls += 1;
        return { kind: "opened", tab } as const;
      },
    );
    expect(await open?.("https://accounts.example.com/sign-in")).toBeNull();
    expect(calls).toBe(0);
  });
});
