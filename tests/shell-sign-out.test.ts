import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import {
  machineIdentity,
  parseMachineBinding,
} from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { refreshFolder } from "../src/folder/update-profile";
import { publicEntry } from "../src/launchpad/chat";
import { shellDocument } from "../src/launchpad/shell-document";
import { parseMachineContext } from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import {
  parseShell,
  parseShellAccount,
  type Shell,
  type ShellAccount,
} from "../src/shell/contract";
import { mergeAccount } from "../src/shell/merge";
import { shellMessages } from "../src/shell/messages";
import { railAccount } from "../src/shell/view";
import { accountDocument } from "./fixtures/account-document";
import {
  binding,
  bindings,
  entries,
  signOutPath,
  withSignOut,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";

// Machines#358, F36's addendum of 2026-10-16: "Odhlásit" ends the
// Environment's gateway session and the person's Lazurio account session in
// this browser. Machines serves the sign-out on the shell's origins (the
// Launchpad, T3 Code, MausBot) behind the Platform Launchpad and writes its
// path as `entry.sign_out`; the Launchpad puts it into the shell document,
// and the account at the foot of the rail opens a menu with it. Example
// names only.

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const { team: _, ...withoutTeam } = organization.owner;
const workVm = { ...organization, owner: withoutTeam };
const cs = shellMessages("cs");
const en = shellMessages("en");

test("the vendored schema carries Machines#358's entry.sign_out exactly: closed, one path", () => {
  const signOut = (
    schema as unknown as {
      $defs: { entry: { properties: Record<string, unknown> } };
    }
  ).$defs.entry.properties.sign_out;
  expect(signOut).toEqual({
    description: expect.any(String),
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        description: expect.any(String),
        const: signOutPath,
      },
    },
  });
});

test("a handover's sign-out is read exactly as written and projected into the binding; without it nothing changes", () => {
  const input = { ...workVm, entry: withSignOut(entries.organization) };
  const context = parseMachineContext(bytes(input));
  expect(JSON.stringify(context)).toBe(JSON.stringify(input));
  expect(context.entry?.sign_out).toEqual({ path: signOutPath });
  expect(bindings.organizationSignOut.entry?.signOutPath).toBe(signOutPath);
  // Everything else of the entry is what it was without the sign-out.
  const { signOutPath: __, ...rest } = bindings.organizationSignOut
    .entry as NonNullable<typeof bindings.organizationSignOut.entry>;
  expect(rest).toEqual(bindings.organizationEntry.entry as typeof rest);
  // A declaration, outside the Machine's identity.
  expect(machineIdentity(bindings.organizationSignOut)).toEqual(
    machineIdentity(bindings.organizationEntry),
  );
  // The recorded binding reads back as itself.
  expect(
    parseMachineBinding(
      JSON.parse(JSON.stringify(bindings.organizationSignOut)),
    ),
  ).toEqual(bindings.organizationSignOut);
  // A personal VM's entry carries it the same way.
  expect(bindings.personalSignOut.entry?.signOutPath).toBe(signOutPath);
  // Without it, the binding is byte for byte what it was.
  expect(JSON.stringify(bindings.organizationEntry)).not.toContain("signOut");
  // It is the shell's, never part of the Launchpad's public entry.
  expect(
    JSON.stringify(publicEntry(bindings.organizationSignOut.entry ?? null)),
  ).not.toContain("sign");
});

for (const [name, signOut] of Object.entries({
  "another path": { path: "/oauth2/sign_out" },
  "an absolute address": {
    path: `https://launchpad.workspace.example.lazurio.io${signOutPath}`,
  },
  "a path with a query": { path: `${signOutPath}?rd=/` },
  "a sign-out with another member": { path: signOutPath, method: "GET" },
  "a sign-out without its path": {},
  "a null sign-out": null,
  "the path alone": signOutPath,
}))
  test(`the schema refuses ${name}, and no binding records it`, () => {
    expect(() =>
      parseMachineContext(
        bytes({
          ...workVm,
          entry: { ...entries.organization, sign_out: signOut },
        }),
      ),
    ).toThrow("machine-context-invalid");
    // The binding records the path alone: a sign-out of any other shape can
    // only arrive there as something that is not the path (the bare path is
    // the schema's to refuse, above).
    const path =
      signOut !== null &&
      typeof signOut === "object" &&
      Object.keys(signOut).length === 1 &&
      "path" in signOut
        ? signOut.path
        : signOut;
    if (path !== signOutPath)
      expect(() =>
        parseMachineBinding({
          ...bindings.organizationEntry,
          entry: { ...bindings.organizationEntry.entry, signOutPath: path },
        }),
      ).toThrow();
  });

test.skipIf(process.platform === "win32")(
  "a refresh records the sign-out the handover gained, though no generated text changes",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "sign-out-handover-")),
    );
    const folder = join(parent, "Lazurio");
    try {
      await mkdir(folder, { mode: 0o700 });
      await mkdir(join(folder, "organizations"), { mode: 0o700 });
      await initializeHandoverFolder(folder, {
        preset: "hosted-organization-personal",
        machine: bindings.organizationEntry,
        profile: presetProfile(
          "hosted-organization-personal",
          executionOs(process.platform),
        ),
      });
      const before = await readFile(join(folder, "AGENTS.md"), "utf8");
      const gained = binding({
        ...workVm,
        entry: withSignOut(entries.organization),
      });
      expect(await refreshFolder(folder, gained)).toEqual({
        kind: "refreshed",
        revision: 2,
      });
      const preferences = JSON.parse(
        await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
      );
      expect(preferences.machine.entry.signOutPath).toBe(signOutPath);
      // Agents are not told about it; the Folder renders the same text.
      const after = await readFile(join(folder, "AGENTS.md"), "utf8");
      expect(createHash("sha256").update(after).digest("hex")).toBe(
        createHash("sha256").update(before).digest("hex"),
      );
      expect(await refreshFolder(folder, gained)).toEqual({
        kind: "unchanged",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

const catalog = { kind: "catalog", organizations: [] } as const;

test("the Launchpad's shell document names the sign-out exactly where the handover does, as a path on the page's own origin", () => {
  const work = shellDocument({
    preset: "hosted-organization-personal",
    machine: bindings.organizationSignOut,
    locale: "cs",
    catalog,
  });
  expect(work.signOut).toBe(signOutPath);
  const own = shellDocument({
    preset: "hosted-personal",
    machine: bindings.personalSignOut,
    locale: "en",
    catalog,
  });
  expect(own.signOut).toBe(signOutPath);
  // Without the member the document is what it was: no sign-out at all.
  for (const machine of [bindings.organizationEntry, null])
    expect(
      Object.hasOwn(
        shellDocument({
          preset: machine === null ? "local" : "hosted-organization-personal",
          machine,
          locale: "cs",
          catalog,
        }),
        "signOut",
      ),
    ).toBe(false);
  // The person's account merged in keeps it (the account knows no sign-out).
  const merged = mergeAccount(
    work,
    parseShellAccount(accountDocument()) as ShellAccount,
  );
  expect(merged.signOut).toBe(signOutPath);
});

const shellWith = (signOut: unknown): Shell | null =>
  parseShell({
    schema: "lazurio.shell.v1",
    locale: "cs",
    current: "local",
    operator: { initials: "AB", login: "example", avatar: null },
    environments: [
      {
        id: "local",
        label: null,
        kind: "workstation",
        organizations: [],
        assignee: null,
        apps: { apps: "/", chat: null, automate: null },
      },
    ],
    organizations: [],
    dashboard: "https://dashboard.example.invalid/home",
    account: "https://dashboard.example.invalid/settings/account",
    addOrganization: null,
    ...(signOut === undefined ? {} : { signOut }),
  });

test("the shell document takes a sign-out as the Dashboard's addresses: a path on its own origin or https; absent or null is none", () => {
  expect(shellWith(signOutPath)?.signOut).toBe(signOutPath);
  expect(
    shellWith("https://dashboard.example.invalid/auth/sign-out")?.signOut,
  ).toBe("https://dashboard.example.invalid/auth/sign-out");
  for (const none of [undefined, null]) {
    const shell = shellWith(none);
    expect(shell).not.toBeNull();
    expect(Object.hasOwn(shell as Shell, "signOut")).toBe(false);
  }
  for (const refused of [
    "//evil.example.invalid/.lazurio/sign-out",
    "javascript:alert(1)",
    "http://launchpad.example.invalid/.lazurio/sign-out",
    "https://user:secret@launchpad.example.invalid/.lazurio/sign-out",
    ".lazurio/sign-out",
    `${signOutPath}#now`,
    "",
    42,
    { path: signOutPath },
  ])
    expect(shellWith(refused)).toBeNull();
});

test("the account at the foot of the rail: the link to its settings without a sign-out, a menu of the settings and the sign-out with one", () => {
  const plain = shellWith(undefined) as Shell;
  // The label is the account's name alone (F36's addendum of 2026-10-16).
  expect(railAccount(plain, cs)).toEqual({
    kind: "link",
    href: plain.account,
    label: "Lazurio účet",
  });
  const signed = shellWith(signOutPath) as Shell;
  expect(railAccount(signed, cs)).toEqual({
    kind: "menu",
    label: "Lazurio účet",
    entries: [
      {
        kind: "settings",
        href: signed.account,
        label: "Nastavení účtu",
        announce: true,
      },
      // A plain navigation: the gateway serves it, no host's router.
      {
        kind: "sign-out",
        href: signOutPath,
        label: "Odhlásit",
        announce: false,
      },
    ],
  });
  const english = railAccount(signed, en);
  expect(english.label).toBe("Lazurio account");
  expect(
    english.kind === "menu" && english.entries.map((entry) => entry.label),
  ).toEqual(["Account settings", "Sign out"]);
});
