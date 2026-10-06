import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { machineContextPath } from "../src/machine/context";
import {
  discoverHostedOperator,
  type HostedOperatorSources,
  hostedOperatorFolder,
} from "../src/machine/operator";
import { runCatalogCommand } from "../src/organizations/cli";
import { runToolsCommand } from "../src/tools/cli";
import {
  HostedEnvironmentUnreadable,
  hostedEnvironmentPreset,
} from "../src/tools/github-gate";
import { fakeLoginTools } from "./fixtures/fake-login-tools";
import { binding } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";

// #83, the consumer proof on real files: a real handover `lazurio.machine.json`
// and a real Folder in a private temporary root, read by the production
// discovery (`discoverHostedOperator` → `hostedOperatorFolder` →
// `hostedEnvironmentPreset`) and the real `lazurio tools` gate with fake gh.
// The one substitution is where the handover lives: the discovery's source
// names this test's root and account (the same custody checks, parser and
// schema), and the operator's system record (getent) is the fixture's
// `operator`. HOME is a temporary home; nothing reaches a real account.

const posix = process.platform !== "win32";
const uid = process.getuid?.() ?? -1;
const root = posix && uid === 0;
const os = executionOs(process.platform);

const { team: _, ...singleOperator } = organization.owner;
// A single-operator Organization work VM and a Team one (the v0.12.59 shape).
const documents = {
  operator: { ...organization, owner: singleOperator },
  team: organization,
} as const;
const presets: Record<keyof typeof documents, PresetName> = {
  operator: "hosted-organization-personal",
  team: "hosted-organization-team",
};

type Handover =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "document"; of: keyof typeof documents; mode?: number }>
  | Readonly<{ kind: "bytes"; bytes: string }>;
type Folder =
  | "initialized"
  | "missing"
  | "no-state"
  | "missing-preferences"
  | "malformed-preferences";

async function world(handover: Handover, folderState: Folder = "missing") {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-hosted-discovery-")),
  );
  // The Machine's filesystem as the discovery reads it: /etc/lazurio and
  // /home/operator/Lazurio under a private root this account owns.
  const machine = join(parent, "machine");
  await mkdir(machine, { mode: 0o755 });
  const file = join(machine, machineContextPath);
  if (handover.kind !== "none") {
    await mkdir(dirname(file), { recursive: true, mode: 0o755 });
    await writeFile(
      file,
      handover.kind === "bytes"
        ? handover.bytes
        : JSON.stringify(documents[handover.of]),
      { mode: 0o644 },
    );
    if (handover.kind === "document" && handover.mode !== undefined)
      await chmod(file, handover.mode);
  }
  const folder = join(machine, organization.operator.lazurio_root);
  const of = handover.kind === "document" ? handover.of : "operator";
  if (folderState !== "missing") {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (folderState !== "no-state") {
      await mkdir(join(folder, "organizations"), { mode: 0o755 });
      await initializeHandoverFolder(folder, {
        preset: presets[of],
        machine: binding(documents[of]),
        profile: presetProfile(presets[of], os),
      });
      const preferences = join(folder, ".lazurio", "preferences.json");
      if (folderState === "missing-preferences") await rm(preferences);
      if (folderState === "malformed-preferences")
        await writeFile(preferences, "{unfinished");
    }
  }
  const home = join(parent, "home");
  const path = await fakeLoginTools(home, ["gh"]);
  const sources: HostedOperatorSources = {
    handover: { platform: "linux", root: machine, custodian: uid },
    operator: async () =>
      Object.freeze({
        platform: "linux",
        uid: 1000,
        username: organization.operator.os_user,
        homedir: organization.operator.home,
      }),
  };
  return {
    parent,
    home,
    file,
    folder,
    sources,
    login: (args: readonly string[], sourcesNow = sources) => {
      const stop = new AbortController();
      return runToolsCommand([...args, "--json"], {
        env: { HOME: home, PATH: path },
        platform: process.platform,
        signal: stop.signal,
        // An allowed sign-in reaches gh's device flow: cancel it at its
        // first pending state; never wait for a person.
        write: (line: string) => {
          if (JSON.parse(line).kind === "pending") stop.abort();
        },
        login: { firstChallengeMs: 5_000, probeIntervalMs: 50 },
        hostedFolder: () => hostedOperatorFolder(sourcesNow),
      });
    },
    ghCalls: () => readFile(join(home, "gh.calls"), "utf8").catch(() => ""),
    close: () => rm(parent, { recursive: true, force: true }),
  };
}

const present = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test.skipIf(!posix)(
  "no handover at all is a workstation: gh sign-in is allowed",
  async () => {
    const machine = await world({ kind: "none" });
    try {
      expect(await discoverHostedOperator(machine.sources)).toEqual({
        kind: "absent",
        reason: "machine-context-missing",
      });
      expect(
        await hostedEnvironmentPreset(() =>
          hostedOperatorFolder(machine.sources),
        ),
      ).toBeUndefined();
      const output = await machine.login(["login", "gh"]);
      expect(output.result).toMatchObject({ kind: "cancelled", tool: "gh" });
      expect(await machine.ghCalls()).toContain("auth login");
    } finally {
      await machine.close();
    }
  },
  10_000,
);

test.skipIf(!posix)(
  "a platform without the handover and another account are no hosted Folder of this process",
  async () => {
    const machine = await world(
      { kind: "document", of: "operator" },
      "initialized",
    );
    try {
      expect(
        await discoverHostedOperator({
          ...machine.sources,
          handover: { ...machine.sources.handover, platform: "darwin" },
        }),
      ).toEqual({ kind: "absent", reason: "machine-platform-unsupported" });
      expect(
        await discoverHostedOperator({
          ...machine.sources,
          operator: async () =>
            Object.freeze({
              platform: "linux",
              uid: 1001,
              username: "another",
              homedir: "/home/another",
            }),
        }),
      ).toEqual({ kind: "absent", reason: "machine-operator-mismatch" });
    } finally {
      await machine.close();
    }
  },
);

test.skipIf(!posix)(
  "a valid single-operator handover and Folder: hosted, gh sign-in allowed as today",
  async () => {
    const machine = await world(
      { kind: "document", of: "operator" },
      "initialized",
    );
    try {
      expect(await discoverHostedOperator(machine.sources)).toEqual({
        kind: "hosted",
        folder: machine.folder,
      });
      expect(
        await hostedEnvironmentPreset(() =>
          hostedOperatorFolder(machine.sources),
        ),
      ).toBe("hosted-organization-personal");
      const output = await machine.login(["login", "gh"]);
      expect(output.result).toMatchObject({ kind: "cancelled", tool: "gh" });
      expect(await machine.ghCalls()).toContain("auth login");
    } finally {
      await machine.close();
    }
  },
  10_000,
);

test.skipIf(!posix)(
  "a valid Team handover and Folder: gh sign-in and key linking refused as today",
  async () => {
    const machine = await world(
      { kind: "document", of: "team" },
      "initialized",
    );
    try {
      expect(
        await hostedEnvironmentPreset(() =>
          hostedOperatorFolder(machine.sources),
        ),
      ).toBe("hosted-organization-team");
      for (const args of [
        ["login", "gh"],
        ["login", "gh", "--ssh-key"],
      ]) {
        const output = await machine.login(args);
        expect(output.code).toBe(2);
        expect(output.result).toEqual({
          kind: "blocked",
          reason: "team-environment",
          tool: "gh",
          action: args.includes("--ssh-key") ? "ssh-key" : "login",
        });
      }
      expect(await machine.ghCalls()).toBe("");
    } finally {
      await machine.close();
    }
  },
);

// Each is a hosted context that is there but cannot be read: never a
// workstation, refused before gh runs.
const unreadable: readonly Readonly<{
  name: string;
  handover: Handover;
  folder?: Folder;
  discovery: Awaited<ReturnType<typeof discoverHostedOperator>>["kind"];
  skip?: boolean;
}>[] = [
  {
    name: "a handover this account cannot read (mode 000)",
    handover: { kind: "document", of: "team", mode: 0o000 },
    folder: "initialized",
    discovery: "unreadable",
    // root reads a mode-000 file; the case cannot be expressed there.
    skip: root,
  },
  {
    name: "a handover others may write (unsafe custody)",
    handover: { kind: "document", of: "team", mode: 0o666 },
    folder: "initialized",
    discovery: "unreadable",
  },
  {
    name: "a malformed JSON handover",
    handover: {
      kind: "bytes",
      bytes: '{"schema_version": "lazurio.machine.v1"',
    },
    folder: "initialized",
    discovery: "unreadable",
  },
  {
    name: "a handover that does not match the schema",
    handover: {
      kind: "bytes",
      bytes: JSON.stringify({ ...organization, account: "admin" }),
    },
    folder: "initialized",
    discovery: "unreadable",
  },
  {
    name: "a valid handover whose declared Folder is missing",
    handover: { kind: "document", of: "team" },
    folder: "missing",
    discovery: "hosted",
  },
  {
    name: "a declared Folder without its state",
    handover: { kind: "document", of: "team" },
    folder: "no-state",
    discovery: "hosted",
  },
  {
    name: "a declared Folder without its preferences",
    handover: { kind: "document", of: "team" },
    folder: "missing-preferences",
    discovery: "hosted",
  },
  {
    name: "a declared Folder with malformed preferences",
    handover: { kind: "document", of: "team" },
    folder: "malformed-preferences",
    discovery: "hosted",
  },
];

for (const fault of unreadable)
  test.skipIf(!posix || fault.skip === true)(
    `${fault.name} refuses gh sign-in, key linking and sign-out as environment-unreadable`,
    async () => {
      const machine = await world(fault.handover, fault.folder);
      try {
        expect((await discoverHostedOperator(machine.sources)).kind).toBe(
          fault.discovery,
        );
        await expect(
          hostedEnvironmentPreset(() => hostedOperatorFolder(machine.sources)),
        ).rejects.toBeInstanceOf(HostedEnvironmentUnreadable);
        for (const args of [
          ["login", "gh"],
          ["login", "gh", "--ssh-key"],
        ]) {
          const output = await machine.login(args);
          expect(output).toMatchObject({
            code: 1,
            result: {
              kind: "failed",
              tool: "gh",
              reason: "environment-unreadable",
            },
          });
          expect(JSON.parse(output.text)).toEqual(output.result);
        }
        // A person signed in earlier stays signed in: the refusal is not a
        // sign-out, and nothing is erased.
        await writeFile(join(machine.home, "gh.state"), "octocat\n");
        const logout = await machine.login(["logout", "gh"]);
        expect(logout).toMatchObject({
          code: 1,
          result: { reason: "environment-unreadable" },
        });
        expect(await readFile(join(machine.home, "gh.state"), "utf8")).toBe(
          "octocat\n",
        );
        expect(await machine.ghCalls()).toBe("");
        expect(await present(join(machine.home, ".ssh"))).toBe(false);
      } finally {
        await chmod(machine.file, 0o644).catch(() => {});
        await machine.close();
      }
    },
    10_000,
  );

test.skipIf(!posix)(
  "an operator record that cannot be resolved leaves the context unreadable, not absent",
  async () => {
    const machine = await world(
      { kind: "document", of: "team" },
      "initialized",
    );
    try {
      const sources: HostedOperatorSources = {
        ...machine.sources,
        operator: async () => {
          throw new Error("getent unavailable");
        },
      };
      expect(await discoverHostedOperator(sources)).toEqual({
        kind: "unreadable",
        reason: "machine-operator-unavailable",
      });
      const output = await machine.login(["login", "gh"], sources);
      expect(output.result).toMatchObject({
        kind: "failed",
        reason: "environment-unreadable",
      });
      expect(await machine.ghCalls()).toBe("");
    } finally {
      await machine.close();
    }
  },
);

test.skipIf(!posix)(
  "a handover with inconsistent operator fields is invalid, not another account",
  async () => {
    const machine = await world({
      kind: "bytes",
      bytes: JSON.stringify({
        ...documents.operator,
        operator: {
          ...organization.operator,
          lazurio_root: "/home/other/Lazurio",
        },
      }),
    });
    try {
      expect(await discoverHostedOperator(machine.sources)).toEqual({
        kind: "unreadable",
        reason: "machine-context-invalid",
      });
    } finally {
      await machine.close();
    }
  },
);

test.skipIf(!posix)(
  "commands that only look up the Folder guess none from an unreadable handover",
  async () => {
    const machine = await world({ kind: "bytes", bytes: "{unfinished" });
    try {
      const output = await runCatalogCommand(
        ["organization", "list", "--json"],
        {
          identity: {
            version: "1.0.0",
            commit: "0".repeat(40),
            target: "fixture",
          },
          platform: process.platform,
          env: { HOME: machine.home },
          executable: join(machine.home, "lazurio"),
          hostedFolder: () => hostedOperatorFolder(machine.sources),
        },
      );
      expect(output).toMatchObject({
        code: 2,
        result: { kind: "blocked", reason: "folder-unknown" },
      });
    } finally {
      await machine.close();
    }
  },
);
