import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePersona } from "../src/buddy/persona";
import { buddyFolderPaths } from "../src/folder/buddy-gen4";
import { parseMachineEntry } from "../src/folder/machine-binding";
import { buddyLayerPaths } from "../src/folder/outputs";
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

const posix = test.skipIf(process.platform === "win32");

posix(
  "a converted person's Folder writes ~/Buddy beside it, with the persona once it is set, and no Buddy GEN3 layer",
  async () => {
    const { parent, folder } = await home();
    try {
      const machine = converted();
      expect(
        (await initializeMachineFolder(folder, machine, noChoices)).code,
      ).toBe(0);
      const buddy = join(parent, "Buddy");
      expect((await lstat(buddy)).mode & 0o777).toBe(0o700);
      for (const path of buddyLayerPaths)
        expect(await exists(join(folder, path))).toBe(false);
      const agents = await readFile(join(buddy, "AGENTS.md"), "utf8");
      expect(agents).toContain("Jsi Buddy, Buddy");
      // The Folder's own AGENTS.md says where Buddy lives.
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        "V tomto Prostředí je Buddy vlákno projektu Buddy ve společném T3 Code se složkou `~/Buddy`.",
      );
      for (const path of buddyFolderPaths)
        expect(await exists(join(buddy, path))).toBe(true);
      // Nastavení → Buddy sets the persona; the next refresh names it.
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
      expect((await refreshMachineFolder(folder, machine)).code).toBe(0);
      const named = await readFile(join(buddy, "AGENTS.md"), "utf8");
      expect(named).toContain("Jsi Bertík, Buddy");
      expect(named).toContain("Aleně tykáš");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

posix(
  "without the conversion the Folder keeps Buddy GEN3's layer and writes no ~/Buddy; on conversion that layer is kept, not removed",
  async () => {
    const { parent, folder } = await home();
    try {
      const plain = binding({ ...personal, entry: entries.personal });
      expect(
        (await initializeMachineFolder(folder, plain, noChoices)).code,
      ).toBe(0);
      for (const path of buddyLayerPaths)
        expect(await exists(join(folder, path))).toBe(true);
      expect(await exists(join(parent, "Buddy"))).toBe(false);
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).not.toContain(
        "`~/Buddy`",
      );
      const layer = await Promise.all(
        buddyLayerPaths.map((path) => readFile(join(folder, path), "utf8")),
      );
      // The handover converts the person: the refresh writes ~/Buddy for
      // the employee's profile and leaves `.agents/buddy/` byte for byte.
      const machine = converted("employee");
      expect((await refreshMachineFolder(folder, machine)).code).toBe(0);
      expect(
        await Promise.all(
          buddyLayerPaths.map((path) => readFile(join(folder, path), "utf8")),
        ),
      ).toEqual(layer);
      const agents = await readFile(join(parent, "Buddy", "AGENTS.md"), "utf8");
      expect(agents).toContain("0220");
      expect(agents).not.toMatch(/## (Převzetí|Taking over)/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
