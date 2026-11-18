import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePersona } from "../src/buddy/persona";
import {
  buddyFolderTarget,
  writeBuddyFolderLocked,
  writeBuddyGen4Locked,
} from "../src/folder/buddy-folder";
import { buddyFolderPaths, renderBuddyFolder } from "../src/folder/buddy-gen4";
import { inspectOutput } from "../src/folder/inventory";
import {
  buddyGeneration,
  parseMachineEntry,
} from "../src/folder/machine-binding";
import { checkOutputDirectories } from "../src/folder/output-directories";
import { buddyLayerPaths } from "../src/folder/outputs";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import {
  initializeMachineFolder,
  RefreshFailedAfterEntry,
  refreshMachineFolder,
  refreshMachineFolderAndLaunchpad,
} from "../src/machine/cli";
import {
  binding,
  entries,
  handoverEntry,
  withBuddy,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// Buddy GEN4 in the handover (plan LZD-0033, Machines#1398):
// `entry.buddy.generation: 4` converts the person, the binding records the
// folder and profile, and every change of the Folder writes Buddy GEN4's
// folder `~/Buddy` instead of Buddy GEN3's layer, which stays as it was.

const FOLDER = "/home/operator/Buddy";
const gen4 = (profile: "buddy" | "employee" = "buddy", origin = false) => ({
  ...entries.personal,
  buddy: {
    generation: 4,
    folder: FOLDER,
    profile,
    ...(origin
      ? {
          external_origin: "https://buddy.example.lazurio.io",
        }
      : {}),
  },
});
const converted = (profile: "buddy" | "employee" = "buddy", origin = false) =>
  binding({ ...personal, entry: gen4(profile, origin) });

test("the binding records Buddy GEN4's folder and profile, and his origin only where the handover keeps it", () => {
  expect(converted("employee").entry).toMatchObject({
    buddyFolder: FOLDER,
    buddyProfile: "employee",
  });
  expect(converted().entry?.buddyOrigin).toBeUndefined();
  expect(converted("buddy", true).entry).toMatchObject({
    buddyFolder: FOLDER,
    buddyProfile: "buddy",
    buddyOrigin: "https://buddy.example.lazurio.io",
  });
  // Buddy GEN3's member is read as before and records no folder.
  const gen3 = binding({ ...personal, entry: withBuddy(entries.personal) });
  expect(gen3.entry?.buddyOrigin).toBe("https://buddy.example.lazurio.io");
  expect(gen3.entry?.buddyFolder).toBeUndefined();
  // One rule for every reader.
  expect(buddyGeneration(converted().entry)).toBe(4);
  expect(buddyGeneration(converted("buddy", true).entry)).toBe(4);
  expect(buddyGeneration(gen3.entry)).toBe(3);
  expect(
    buddyGeneration(binding({ ...personal, entry: entries.personal }).entry),
  ).toBeUndefined();
  expect(buddyGeneration(undefined)).toBeUndefined();
});

test("a work Environment's handover with Buddy GEN4 is refused, and so is an entry with another folder or profile", () => {
  expect(() =>
    binding({
      ...organization,
      entry: {
        ...handoverEntry("workspace.example.lazurio.io"),
        buddy: { generation: 4, folder: FOLDER, profile: "buddy" },
      },
    }),
  ).toThrow();
  const base = {
    externalOrigin: "https://launchpad.example.lazurio.io",
    authCheckUrl: "https://example.lazurio.io/oauth2/auth",
    authCookieName: "__Secure-lazurio-workspace",
    listenPort: 20000,
    t3codeOrigin: "https://t3code.example.lazurio.io",
    moduleOriginTemplate: "https://{module}.example.lazurio.io",
  };
  expect(
    parseMachineEntry({
      ...base,
      buddyFolder: FOLDER,
      buddyProfile: "buddy",
    }).buddyFolder,
  ).toBe(FOLDER);
  for (const [buddyFolder, buddyProfile] of [
    ["/home/operator/Lazurio", "buddy"],
    ["Buddy", "buddy"],
    ["/home/operator/Buddy/", "buddy"],
    ["/home/operator/../other/Buddy", "buddy"],
    [FOLDER, "coordinator"],
    [FOLDER, undefined],
  ])
    expect(() =>
      parseMachineEntry({
        ...base,
        buddyFolder,
        ...(buddyProfile === undefined ? {} : { buddyProfile }),
      }),
    ).toThrow();
});

const noChoices = {
  preset: undefined,
  locale: "cs",
  detail: undefined,
  coordination: undefined,
} as const;

async function home() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "buddy-gen4-")));
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  return { parent, folder };
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
const allowAll = async () => {};
const source = (locale: "cs" | "en" = "cs") => ({
  preset: "local",
  machine: null,
  profile: presetProfile("local", "linux", { locale }),
});

const posix = test.skipIf(process.platform === "win32");

test("the Folder's AGENTS.md says where Buddy GEN4 lives only for a converted person", () => {
  const agents = (machine: ReturnType<typeof binding>) =>
    renderOutputs({
      preset: "hosted-personal",
      machine,
      profile: presetProfile("hosted-personal", "linux", { locale: "cs" }),
    })["AGENTS.md"];
  expect(agents(converted())).toContain(
    "V tomto Prostředí je Buddy vlákno projektu Buddy ve společném T3 Code se složkou `~/Buddy`.",
  );
  expect(
    agents(binding({ ...personal, entry: entries.personal })),
  ).not.toContain("`~/Buddy`");
});

posix(
  "the folder is exactly Buddy of a canonical home of this account: another home, a nested path or a symlinked ancestor is refused",
  async () => {
    const { parent } = await home();
    try {
      expect(await buddyFolderTarget(parent, join(parent, "Buddy"))).toBe(
        join(parent, "Buddy"),
      );
      for (const declared of [
        "/home/other/Buddy",
        join(parent, "nested", "Buddy"),
        join(parent, "Buddy", "Buddy"),
        "Buddy",
      ])
        await expect(buddyFolderTarget(parent, declared)).rejects.toThrow(
          "Buddy folder mismatch",
        );
      // The same home reached through a symlinked ancestor.
      const link = join(parent, "link");
      await mkdir(join(parent, "real"), { mode: 0o700 });
      await symlink(join(parent, "real"), link);
      await expect(
        buddyFolderTarget(link, join(link, "Buddy")),
      ).rejects.toThrow("Unsafe Buddy folder home");
      await expect(
        writeBuddyFolderLocked(
          join(link, "Buddy"),
          renderBuddyFolder(source(), "buddy"),
          allowAll,
        ),
      ).rejects.toThrow("Unsafe Buddy folder parent");
      expect(await exists(join(parent, "real", "Buddy"))).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

// The converted binding of a Folder in `parent`: the handover names the
// operator's home, which on a hosted Environment is the Folder's own; here
// the Folder's temporary home stands for it.
const convertedAt = (
  parent: string,
  profile: "buddy" | "employee" = "buddy",
): ReturnType<typeof binding> => {
  const machine = converted(profile);
  return {
    ...machine,
    entry: {
      ...(machine.entry as NonNullable<typeof machine.entry>),
      buddyFolder: join(parent, "Buddy"),
    },
  };
};
const recordedBuddy = async (folder: string) =>
  JSON.parse(
    await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
  ).machine?.entry?.buddyFolder;
const buddyLine = "`~/Buddy`";

posix(
  "a converted person's Folder: initialization writes ~/Buddy and no Buddy GEN3 layer, and a refresh after Nastavení → Buddy names the persona",
  async () => {
    const { parent, folder } = await home();
    try {
      const machine = convertedAt(parent);
      expect(
        (await initializeMachineFolder(folder, machine, noChoices)).code,
      ).toBe(0);
      const buddy = join(parent, "Buddy");
      expect((await lstat(buddy)).mode & 0o777).toBe(0o700);
      for (const path of buddyFolderPaths)
        expect(await exists(join(buddy, path))).toBe(true);
      for (const path of buddyLayerPaths)
        expect(await exists(join(folder, path))).toBe(false);
      expect(await readFile(join(buddy, "AGENTS.md"), "utf8")).toContain(
        "Jsi Buddy, Buddy",
      );
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        buddyLine,
      );
      await writePersona(
        parent,
        {
          buddyName: "Bertík",
          address: "ty",
          user: { nominative: "Alena", accusative: "Alenu", dative: "Aleně" },
        },
        null,
      );
      expect((await refreshMachineFolder(folder, machine)).code).toBe(0);
      const named = await readFile(join(buddy, "AGENTS.md"), "utf8");
      expect(named).toContain("Jsi Bertík");
      expect(named).toContain("Aleně tykáš");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "a conversion by refresh writes ~/Buddy for the profile and keeps Buddy GEN3's layer byte for byte",
  async () => {
    const { parent, folder } = await home();
    try {
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      expect(await exists(join(parent, "Buddy"))).toBe(false);
      const layer = await Promise.all(
        buddyLayerPaths.map((path) => readFile(join(folder, path), "utf8")),
      );
      expect(
        (await refreshMachineFolder(folder, convertedAt(parent, "employee")))
          .code,
      ).toBe(0);
      expect(
        await Promise.all(
          buddyLayerPaths.map((path) => readFile(join(folder, path), "utf8")),
        ),
      ).toEqual(layer);
      const agents = await readFile(join(parent, "Buddy", "AGENTS.md"), "utf8");
      expect(agents).toContain("0220");
      expect(agents).not.toMatch(/## (Převzetí|Taking over)/);
      expect(await recordedBuddy(folder)).toBe(join(parent, "Buddy"));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "a refused conversion changes nothing, and the retry after the fix converts: another home, then a CLAUDE.md, through the refresh with the Launchpad's restart",
  async () => {
    const { parent, folder } = await home();
    try {
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      const agentsBefore = await readFile(join(folder, "AGENTS.md"), "utf8");
      const unchanged = async () => {
        expect(await recordedBuddy(folder)).toBeUndefined();
        expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
          agentsBefore,
        );
        expect(await exists(join(parent, "Buddy", "AGENTS.md"))).toBe(false);
      };
      const launchpad = { service: async () => null, version: "0.0.0" };
      // The fixture's handover names /home/operator, not this Folder's home.
      await expect(
        refreshMachineFolderAndLaunchpad(
          folder,
          converted(),
          undefined,
          launchpad,
        ),
      ).rejects.toThrow("Buddy folder mismatch");
      await unchanged();
      // The right home, but the person keeps a CLAUDE.md there.
      await mkdir(join(parent, "Buddy"), { mode: 0o700 });
      await writeFile(join(parent, "Buddy", "CLAUDE.md"), "moje\n");
      await expect(
        refreshMachineFolderAndLaunchpad(
          folder,
          convertedAt(parent),
          undefined,
          launchpad,
        ),
      ).rejects.toThrow("Buddy folder has CLAUDE.md");
      await unchanged();
      expect(await readFile(join(parent, "Buddy", "CLAUDE.md"), "utf8")).toBe(
        "moje\n",
      );
      // Moved away: the retry sees the change anew and asks for the restart.
      await rm(join(parent, "Buddy", "CLAUDE.md"));
      const retried = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        launchpad,
      );
      expect(retried.code).toBe(0);
      expect((retried.result as { launchpad?: unknown }).launchpad).toBe(
        "not-supervised",
      );
      expect(await recordedBuddy(folder)).toBe(join(parent, "Buddy"));
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        buddyLine,
      );
      expect(await exists(join(parent, "Buddy", "AGENTS.md"))).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "an initialization that cannot write ~/Buddy starts nothing",
  async () => {
    const { parent, folder } = await home();
    try {
      await mkdir(join(parent, "Buddy", ".claude"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(join(parent, "Buddy", ".claude", "CLAUDE.md"), "x\n");
      await expect(
        initializeMachineFolder(folder, convertedAt(parent), noChoices),
      ).rejects.toThrow("Buddy folder has .claude/CLAUDE.md");
      expect(await exists(join(folder, ".lazurio", "preferences.json"))).toBe(
        false,
      );
      expect(await exists(join(folder, "AGENTS.md"))).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "Buddy GEN4's folder of a home is written with the persona once it is set",
  async () => {
    const { parent } = await home();
    try {
      const buddy = join(parent, "Buddy");
      expect(
        await writeBuddyGen4Locked(parent, buddy, source(), "buddy", allowAll),
      ).toEqual([...buddyFolderPaths]);
      expect((await lstat(buddy)).mode & 0o777).toBe(0o700);
      expect(await readFile(join(buddy, "AGENTS.md"), "utf8")).toContain(
        "Jsi Buddy, Buddy",
      );
      const persona = await writePersona(
        parent,
        {
          buddyName: "Bertík",
          address: "ty",
          user: { nominative: "Alena", accusative: "Alenu", dative: "Aleně" },
        },
        null,
      );
      expect(persona.kind).toBe("written");
      await writeBuddyGen4Locked(parent, buddy, source(), "employee", allowAll);
      const named = await readFile(join(buddy, "AGENTS.md"), "utf8");
      expect(named).toContain("Jsi Bertík");
      expect(named).toContain("Aleně tykáš");
      expect(named).toContain("0220");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "a CLAUDE.md in Buddy's folder is reported and kept, and nothing is written beside it",
  async () => {
    for (const claude of ["CLAUDE.md", ".claude/CLAUDE.md"]) {
      const { parent } = await home();
      try {
        const buddy = join(parent, "Buddy");
        await mkdir(join(buddy, ".claude"), { recursive: true, mode: 0o700 });
        await writeFile(join(buddy, claude), "moje pokyny\n");
        await expect(
          writeBuddyGen4Locked(parent, buddy, source(), "buddy", allowAll),
        ).rejects.toThrow(`Buddy folder has ${claude}`);
        expect(await readFile(join(buddy, claude), "utf8")).toBe(
          "moje pokyny\n",
        );
        expect(await exists(join(buddy, "AGENTS.md"))).toBe(false);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
  },
);

posix(
  "a file of another account is never kept or replaced: the inventory reports it unsafe",
  async () => {
    const { parent } = await home();
    try {
      const buddy = join(parent, "Buddy");
      await mkdir(buddy, { mode: 0o700 });
      await writeFile(join(buddy, "AGENTS.md"), "x\n");
      const uid = process.getuid?.() as number;
      expect((await inspectOutput(buddy, "AGENTS.md", uid)).kind).toBe(
        "regular",
      );
      expect((await inspectOutput(buddy, "AGENTS.md", uid + 1)).kind).toBe(
        "unsafe",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "the check before the change applies the writer's rule to the directories on the way: one of another account is refused",
  async () => {
    const { parent } = await home();
    try {
      const buddy = join(parent, "Buddy");
      await mkdir(join(buddy, ".agents"), { recursive: true, mode: 0o700 });
      const uid = process.getuid?.() as number;
      const skill = ".agents/skills/buddy-vlakna/SKILL.md" as const;
      await checkOutputDirectories(buddy, skill, uid);
      await expect(
        checkOutputDirectories(buddy, skill, uid + 1),
      ).rejects.toThrow("Unsafe output directory: .agents");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

// A failure the check cannot foresee (here a directory of the person's that
// does not let the account write) comes after the change is recorded: the
// Launchpad is restarted on the new entry anyway, and the next refresh
// writes the folder.
const writable = test.skipIf(
  process.platform === "win32" || process.getuid?.() === 0,
);
writable(
  "a write that fails after the change still restarts the Launchpad, and the next refresh completes Buddy's folder",
  async () => {
    const { parent, folder } = await home();
    try {
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      const buddy = join(parent, "Buddy");
      await mkdir(join(buddy, ".agents"), { recursive: true, mode: 0o700 });
      await chmod(join(buddy, ".agents"), 0o500);
      let asked = 0;
      const launchpad = {
        service: async () => {
          asked += 1;
          return null;
        },
        version: "0.0.0",
      };
      await expect(
        refreshMachineFolderAndLaunchpad(
          folder,
          convertedAt(parent),
          undefined,
          launchpad,
        ),
      ).rejects.toThrow("launchpad: not-supervised");
      expect(asked).toBe(1);
      expect(await recordedBuddy(folder)).toBe(buddy);
      await chmod(join(buddy, ".agents"), 0o700);
      expect(
        (await refreshMachineFolder(folder, convertedAt(parent))).code,
      ).toBe(0);
      for (const path of buddyFolderPaths)
        expect(await exists(join(buddy, path))).toBe(true);
    } finally {
      await chmod(join(parent, "Buddy", ".agents"), 0o700).catch(() => {});
      await rm(parent, { recursive: true, force: true });
    }
  },
);

writable(
  "a failed restart after a late failure is reported with the failure",
  async () => {
    const { parent, folder } = await home();
    try {
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      const buddy = join(parent, "Buddy");
      await mkdir(join(buddy, ".agents"), { recursive: true, mode: 0o700 });
      await chmod(join(buddy, ".agents"), 0o500);
      // A unit of this Folder whose restart fails.
      const launchpad = {
        service: async () =>
          ({
            folder,
            restartLaunchpad: async () => {
              throw new Error("unit failed");
            },
            launchpadVersion: async () => null,
          }) as never,
        version: "0.0.0",
        deadlineMs: 10,
      };
      const failure = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        launchpad,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RefreshFailedAfterEntry);
      expect((failure as RefreshFailedAfterEntry).launchpad).toBe(
        "restart-failed",
      );
      expect(String(failure)).toContain("launchpad: restart-failed");
    } finally {
      await chmod(join(parent, "Buddy", ".agents"), 0o700).catch(() => {});
      await rm(parent, { recursive: true, force: true });
    }
  },
);
