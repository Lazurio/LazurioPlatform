import { expect, test } from "bun:test";
import {
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
import { buddyLayerPaths } from "../src/folder/outputs";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import {
  initializeMachineFolder,
  refreshMachineFolder,
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

posix(
  "a handover naming another home than the Folder's is refused: nothing is written in ~/Buddy and Buddy GEN3's layer stays",
  async () => {
    const { parent, folder } = await home();
    try {
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      const layer = await Promise.all(
        buddyLayerPaths.map((path) => readFile(join(folder, path), "utf8")),
      );
      // The fixture's operator home is /home/operator, not this Folder's.
      await expect(
        refreshMachineFolder(folder, converted("employee")),
      ).rejects.toThrow("Buddy folder mismatch");
      expect(await exists(join(parent, "Buddy"))).toBe(false);
      expect(
        await Promise.all(
          buddyLayerPaths.map((path) => readFile(join(folder, path), "utf8")),
        ),
      ).toEqual(layer);
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
