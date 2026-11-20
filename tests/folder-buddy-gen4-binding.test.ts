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
  BuddyFolderRefused,
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
import { neededRefresh } from "../src/folder/refresh-needed";
import { instructionTemplateRevision } from "../src/folder/render";
import { refreshFolder } from "../src/folder/update-profile";
import {
  initializeMachineFolder,
  machineFailureAnswer,
  refreshMachineFolder,
  refreshMachineFolderAndLaunchpad,
} from "../src/machine/cli";
import { entryDigest, restartOwedFor } from "../src/machine/launchpad-entry";
import { refreshFolderWhenBehind } from "../src/update/folder-refresh";
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
// refresh reports it in `buddyFolder` and keeps its code, the Launchpad
// follows the new entry as after any refresh, and the next refresh writes
// the folder.
const writable = test.skipIf(
  process.platform === "win32" || process.getuid?.() === 0,
);
writable(
  "a write that fails after the change is reported, the Launchpad follows the new entry, and the next refresh completes Buddy's folder",
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
      const first = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        launchpad,
      );
      expect(first.code).toBe(0);
      const result = first.result as {
        kind: string;
        buddyFolder?: { state: string; error: string };
        launchpad?: string;
      };
      expect(result.kind).toBe("refreshed");
      expect(result.buddyFolder?.state).toBe("failed");
      expect(result.launchpad).toBe("not-supervised");
      expect(asked).toBe(1);
      expect(await recordedBuddy(folder)).toBe(buddy);
      await chmod(join(buddy, ".agents"), 0o700);
      const retry = await refreshMachineFolder(folder, convertedAt(parent));
      expect(retry.code).toBe(0);
      expect("buddyFolder" in retry.result).toBe(false);
      for (const path of buddyFolderPaths)
        expect(await exists(join(buddy, path))).toBe(true);
    } finally {
      await chmod(join(parent, "Buddy", ".agents"), 0o700).catch(() => {});
      await rm(parent, { recursive: true, force: true });
    }
  },
);

writable(
  "a failed restart after a reported write is in the answer as after any refresh",
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
      const answer = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        launchpad,
      );
      const result = answer.result as {
        buddyFolder?: { state: string };
        launchpad?: string;
      };
      expect(result.buddyFolder?.state).toBe("failed");
      expect(result.launchpad).toBe("restart-failed");
    } finally {
      await chmod(join(parent, "Buddy", ".agents"), 0o700).catch(() => {});
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("a refusal before the change is the command's blocked answer with its reason, never internal", () => {
  for (const reason of [
    "buddy-folder-mismatch",
    "buddy-folder-claude-md",
    "buddy-folder-unsafe",
  ] as const) {
    const answer = machineFailureAnswer(
      new BuddyFolderRefused(reason, "detail"),
    );
    expect(answer.code).toBe(2);
    expect(answer.result).toMatchObject({
      kind: "blocked",
      reason,
      detail: "detail",
    });
  }
});

// A Launchpad of this Folder that reports the entry it started with.
function supervised(
  folder: string,
  running: () => string,
  restart: () => Promise<void>,
) {
  let restarts = 0;
  return {
    get restarts() {
      return restarts;
    },
    seams: {
      service: async () =>
        ({
          folder,
          restartLaunchpad: async () => {
            restarts += 1;
            await restart();
          },
          launchpadVersion: async () => "0.0.0",
          launchpadEntry: async () => running(),
        }) as never,
      version: "0.0.0",
      deadlineMs: 10,
    },
  };
}

posix(
  "a failed restart is owed: the retry restarts the Launchpad that still reports the old entry, and a current one is left alone",
  async () => {
    const { parent, folder } = await home();
    try {
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      const old = entryDigest(plain.entry);
      let running = old;
      // The conversion's restart fails: the Launchpad stays on the old entry.
      const failing = supervised(
        folder,
        () => running,
        async () => {
          throw new Error("unit failed");
        },
      );
      const first = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        failing.seams,
      );
      expect((first.result as { launchpad?: string }).launchpad).toBe(
        "restart-failed",
      );
      // The retry finds the Folder unchanged and still restarts it.
      const working = supervised(
        folder,
        () => running,
        async () => {
          running = entryDigest(convertedAt(parent).entry);
        },
      );
      const retry = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        working.seams,
      );
      expect(retry.result.kind).toBe("unchanged");
      expect((retry.result as { launchpad?: string }).launchpad).toBe(
        "restarted",
      );
      expect(working.restarts).toBe(1);
      expect(running).not.toBe(old);
      // Current now: nothing owed, nothing restarted.
      const again = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        working.seams,
      );
      expect("launchpad" in again.result).toBe(false);
      expect(working.restarts).toBe(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "a CLAUDE.md that appears after the change committed is reported, not answered as nothing changed, and the next refresh completes",
  async () => {
    const { parent, folder } = await home();
    try {
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      const buddy = join(parent, "Buddy");
      const result = await refreshFolder(
        folder,
        convertedAt(parent),
        async (step) => {
          if (step === "finalized") {
            await mkdir(buddy, { recursive: true, mode: 0o700 });
            await writeFile(join(buddy, "CLAUDE.md"), "moje\n");
          }
        },
      );
      expect(result).toMatchObject({
        kind: "refreshed",
        buddyFolder: { state: "failed", reason: "buddy-folder-claude-md" },
      });
      expect(await recordedBuddy(folder)).toBe(buddy);
      expect(await readFile(join(buddy, "CLAUDE.md"), "utf8")).toBe("moje\n");
      await rm(join(buddy, "CLAUDE.md"));
      expect(
        (await refreshMachineFolder(folder, convertedAt(parent))).code,
      ).toBe(0);
      expect(await exists(join(buddy, "AGENTS.md"))).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "while Buddy GEN3 is in the home, ~/Buddy/AGENTS.md says to leave him alone; once he is gone, update asks for the refresh that drops it",
  async () => {
    const { parent, folder } = await home();
    try {
      await mkdir(join(parent, ".t3-buddy"));
      expect(
        (await initializeMachineFolder(folder, convertedAt(parent), noChoices))
          .code,
      ).toBe(0);
      const agents = () => readFile(join(parent, "Buddy", "AGENTS.md"), "utf8");
      expect(await agents()).toContain("~/.t3-buddy");
      expect(
        await neededRefresh(folder, instructionTemplateRevision, folder),
      ).toBeNull();
      // R9 removed Buddy GEN3: the text is behind, and the refresh drops it.
      await rm(join(parent, ".t3-buddy"), { recursive: true });
      expect(
        (await neededRefresh(folder, instructionTemplateRevision, folder))
          ?.command,
      ).toEqual(["machine", "folder-refresh"]);
      expect(
        (await refreshMachineFolder(folder, convertedAt(parent))).code,
      ).toBe(0);
      expect(await agents()).not.toContain("~/.t3-buddy");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "lazurio update asks for a refresh while ~/Buddy lacks what the product renders, and reports a refresh that could not write it as a failure",
  async () => {
    const { parent, folder } = await home();
    try {
      expect(
        (await initializeMachineFolder(folder, convertedAt(parent), noChoices))
          .code,
      ).toBe(0);
      // Current: nothing needed.
      expect(
        await neededRefresh(folder, instructionTemplateRevision, folder),
      ).toBeNull();
      // A file of Buddy's folder missing: the operator's refresh is needed,
      // but not for doctor, which names no operator.
      await rm(join(parent, "Buddy", "AGENTS.md"));
      expect(
        (await neededRefresh(folder, instructionTemplateRevision, folder))
          ?.command,
      ).toEqual(["machine", "folder-refresh"]);
      expect(
        await neededRefresh(folder, instructionTemplateRevision, undefined),
      ).toBeNull();
      // The refresh's answer with a failed write is the update's failure.
      const outcome = await refreshFolderWhenBehind({
        base: parent,
        folder,
        product: instructionTemplateRevision,
        env: {},
        operatorFolder: async () => folder,
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            kind: "refreshed",
            revision: 2,
            buddyFolder: {
              state: "failed",
              reason: "buddy-folder-claude-md",
              error: "x",
            },
          }),
        }),
      });
      expect(outcome).toEqual({
        state: "failed",
        reason: "buddy-folder-claude-md",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "a failed restart is kept as owed in the install base and made by the retry, also for a Launchpad that reports no entry or does not answer",
  async () => {
    for (const reports of ["no-entry", "no-answer"] as const) {
      const { parent, folder } = await home();
      try {
        const owed = join(
          parent,
          "base",
          "update",
          "launchpad-restart-owed.json",
        );
        const plain = binding({ ...personal, entry: entries.personal });
        expect(
          (await initializeMachineFolder(folder, plain, noChoices)).code,
        ).toBe(0);
        let restarts = 0;
        let fail = true;
        const seams = {
          service: async () =>
            ({
              folder,
              restartLaunchpad: async () => {
                restarts += 1;
                if (fail) throw new Error("unit failed");
              },
              launchpadVersion: async () => "0.0.0",
              // An older release reports no entry; a Launchpad that does
              // not answer reports null.
              ...(reports === "no-answer"
                ? { launchpadEntry: async () => null }
                : {}),
            }) as never,
          version: "0.0.0",
          deadlineMs: 10,
          owed,
        };
        const first = await refreshMachineFolderAndLaunchpad(
          folder,
          convertedAt(parent),
          undefined,
          seams,
        );
        expect((first.result as { launchpad?: string }).launchpad).toBe(
          "restart-failed",
        );
        expect(await restartOwedFor(owed, folder)).toBe(true);
        expect((await lstat(owed)).mode & 0o777).toBe(0o600);
        fail = false;
        const retry = await refreshMachineFolderAndLaunchpad(
          folder,
          convertedAt(parent),
          undefined,
          seams,
        );
        expect(retry.result.kind).toBe("unchanged");
        expect((retry.result as { launchpad?: string }).launchpad).toBe(
          "restarted",
        );
        expect(restarts).toBe(2);
        expect(await restartOwedFor(owed, folder)).toBe(false);
        const again = await refreshMachineFolderAndLaunchpad(
          folder,
          convertedAt(parent),
          undefined,
          seams,
        );
        expect("launchpad" in again.result).toBe(false);
        expect(restarts).toBe(2);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
  },
);

posix(
  "lazurio update reports a failed restart and runs the refresh again while the restart is owed",
  async () => {
    const { parent, folder } = await home();
    try {
      expect(
        (await initializeMachineFolder(folder, convertedAt(parent), noChoices))
          .code,
      ).toBe(0);
      const base = join(parent, "base");
      const commands: string[][] = [];
      const answer = (body: object) => async (command: readonly string[]) => {
        commands.push([...command]);
        return { exitCode: 0, stdout: JSON.stringify(body) };
      };
      const input = {
        base,
        folder,
        product: instructionTemplateRevision,
        env: {},
        operatorFolder: async () => folder,
      };
      // Current and nothing owed: no refresh.
      expect(
        await refreshFolderWhenBehind({
          ...input,
          run: answer({ kind: "unchanged" }),
        }),
      ).toBeNull();
      expect(commands).toEqual([]);
      // A restart owed: the operator's refresh runs, and its failed restart
      // is the update's failure.
      await mkdir(join(base, "update"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(base, "update", "launchpad-restart-owed.json"),
        JSON.stringify({ folder, token: "owed" }),
      );
      const outcome = await refreshFolderWhenBehind({
        ...input,
        run: answer({
          kind: "unchanged",
          revision: 2,
          launchpad: "restart-failed",
        }),
      });
      expect(outcome).toEqual({
        state: "failed",
        reason: "launchpad-restart-failed",
      });
      expect(commands.at(-1)?.slice(-2)).toEqual(["machine", "folder-refresh"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "a service lookup that fails keeps the restart owed, and the refresh retries it once the lookup works",
  async () => {
    const { parent, folder } = await home();
    try {
      const owed = join(
        parent,
        "base",
        "update",
        "launchpad-restart-owed.json",
      );
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      let lookup: "fails" | "works" = "fails";
      let restarts = 0;
      const seams = {
        service: async () => {
          if (lookup === "fails") throw new Error("no user manager");
          return {
            folder,
            restartLaunchpad: async () => {
              restarts += 1;
            },
            launchpadVersion: async () => "0.0.0",
          } as never;
        },
        version: "0.0.0",
        deadlineMs: 10,
        owed,
      };
      const first = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        seams,
      );
      expect((first.result as { launchpad?: string }).launchpad).toBe(
        "restart-failed",
      );
      expect(await restartOwedFor(owed, folder)).toBe(true);
      // Still failing: the debt stays.
      await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        seams,
      );
      expect(await restartOwedFor(owed, folder)).toBe(true);
      lookup = "works";
      const retry = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        seams,
      );
      expect((retry.result as { launchpad?: string }).launchpad).toBe(
        "restarted",
      );
      expect(restarts).toBe(1);
      expect(await restartOwedFor(owed, folder)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "a debt that cannot be recorded stops the refresh before anything changes, and the debt is already recorded when the restart runs",
  async () => {
    const { parent, folder } = await home();
    try {
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      // The update "directory" is a file: nothing can be recorded there.
      await writeFile(join(parent, "update-file"), "x");
      const blocked = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        {
          service: async () => null,
          version: "0.0.0",
          owed: join(parent, "update-file", "launchpad-restart-owed.json"),
        },
      );
      expect(blocked.code).toBe(2);
      expect(blocked.result).toMatchObject({
        kind: "blocked",
        reason: "launchpad-restart-unrecordable",
      });
      expect(await recordedBuddy(folder)).toBeUndefined();
      // Recorded ahead: while the restart runs, the debt is already there.
      const owed = join(
        parent,
        "base",
        "update",
        "launchpad-restart-owed.json",
      );
      let seen: boolean | undefined;
      await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        {
          service: async () => {
            seen = await restartOwedFor(owed, folder);
            return null;
          },
          version: "0.0.0",
          owed,
        },
      );
      expect(seen).toBe(true);
      expect(await restartOwedFor(owed, folder)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "an overlapping refresh is refused as busy while another holds the restart lifecycle, and the debt of a failed restart is made by the next refresh",
  async () => {
    const { parent, folder } = await home();
    try {
      const owed = join(
        parent,
        "base",
        "update",
        "launchpad-restart-owed.json",
      );
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      // Refresh A's restart waits, then fails.
      let releaseA: () => void = () => {};
      const aWaits = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let aStarted: () => void = () => {};
      const aRestarting = new Promise<void>((resolve) => {
        aStarted = resolve;
      });
      const unit = (restart: () => Promise<void>) => ({
        service: async () =>
          ({
            folder,
            restartLaunchpad: restart,
            launchpadVersion: async () => "0.0.0",
          }) as never,
        version: "0.0.0",
        deadlineMs: 10,
        owed,
      });
      const a = refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        unit(async () => {
          aStarted();
          await aWaits;
          throw new Error("unit failed");
        }),
      );
      await aRestarting;
      // B overlaps A's restart: refused as busy, the debt untouched.
      const b = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        unit(async () => {}),
      ).then(
        () => null,
        (error: unknown) => machineFailureAnswer(error),
      );
      expect(b?.code).toBe(2);
      expect(b?.result).toMatchObject({
        kind: "blocked",
        reason: "folder-busy",
      });
      expect(await restartOwedFor(owed, folder)).toBe(true);
      releaseA();
      expect(((await a).result as { launchpad?: string }).launchpad).toBe(
        "restart-failed",
      );
      expect(await restartOwedFor(owed, folder)).toBe(true);
      // The next refresh makes the owed restart and clears the debt.
      const retry = await refreshMachineFolderAndLaunchpad(
        folder,
        convertedAt(parent),
        undefined,
        unit(async () => {}),
      );
      expect((retry.result as { launchpad?: string }).launchpad).toBe(
        "restarted",
      );
      expect(await restartOwedFor(owed, folder)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
