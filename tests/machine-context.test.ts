import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { MachineUsageError, runMachineCommand } from "../src/machine/cli";
import {
  bindMachineOperator,
  parseMachineContext,
} from "../src/machine/context";
import provenance from "../src/machine/schema-provenance.json";
import { readCustodiedDeclarationBytes } from "../src/providers/owned-json";
import fixture from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
test("vendored schema digest matches the exact upstream pin", async () => {
  expect(
    createHash("sha256")
      .update(
        await readFile(
          new URL(
            "../src/machine/lazurio-machine.v1.schema.json",
            import.meta.url,
          ),
        ),
      )
      .digest("hex"),
  ).toBe(provenance.sha256);
});
for (const [branch, input] of [
  ["organization workspace VM", fixture],
  ["personal VM", personal],
] as const)
  test(`synthetic ${branch} conformance fixture is immutable descriptive context`, () => {
    const context = parseMachineContext(bytes(input));
    expect(JSON.stringify(context)).toBe(JSON.stringify(input));
    expect(context.account).toBeNull();
    expect(Object.isFrozen(context.operator)).toBe(true);
    expect(Object.isFrozen(context.installed.machines_release)).toBe(true);
    expect(
      bindMachineOperator(context, {
        platform: "linux",
        uid: 1000,
        username: "operator",
        homedir: "/home/operator",
      }),
    ).toBe("/home/operator/Lazurio");
  });
test("organization branch permits no network and SHA-256 Git object ids", () => {
  const { network: _, ...input } = structuredClone(fixture);
  input.installed.deployment_head = "c".repeat(64);
  input.installed.machines_release.commit = "d".repeat(64);
  expect(parseMachineContext(bytes(input)).network).toBeUndefined();
});
test("personal branch requires the tailnet identity", () => {
  const { network: _, ...input } = structuredClone(personal);
  expect(() => parseMachineContext(bytes(input))).toThrow(
    "machine-context-invalid",
  );
});
for (const [name, change] of Object.entries({
  "unknown top-level field": (input: Record<string, unknown>) => {
    input.permissions = ["admin"];
  },
  "missing required account": (input: Record<string, unknown>) => {
    delete input.account;
  },
  "Dashboard identity invented": (input: Record<string, unknown>) => {
    input.account = "admin";
  },
  "unknown schema version": (input: Record<string, unknown>) => {
    input.schema_version = "lazurio.machine.v2";
  },
  "wrong nested type": (input: Record<string, unknown>) => {
    input.operator = { ...fixture.operator, os_user: 42 };
  },
  "path traversal": (input: Record<string, unknown>) => {
    input.operator = {
      ...fixture.operator,
      lazurio_root: "/home/operator/../Lazurio",
    };
  },
  "invalid Git id": (input: Record<string, unknown>) => {
    input.installed = { ...fixture.installed, deployment_head: "c".repeat(41) };
  },
}))
  for (const [branch, base] of [
    ["organization", fixture],
    ["personal", personal],
  ] as const)
    test(`schema refuses ${name} on the ${branch} branch`, () => {
      const input: Record<string, unknown> = structuredClone(base);
      change(input);
      expect(() => parseMachineContext(bytes(input))).toThrow(
        "machine-context-invalid",
      );
    });
for (const [name, change] of Object.entries({
  "a personal-vm kind with an Organization owner": (
    input: Record<string, unknown>,
  ) => {
    input.machine = { ...personal.machine };
  },
  "a workspace-vm kind with a Principal owner": (
    input: Record<string, unknown>,
  ) => {
    input.owner = { ...personal.owner };
  },
  "a workspace-vm on a provider estate": (input: Record<string, unknown>) => {
    input.host = { ...personal.host };
  },
  "a personal VM on a virtualization host": (
    input: Record<string, unknown>,
  ) => {
    Object.assign(input, structuredClone(personal), { host: fixture.host });
  },
  "a personal owner with a team": (input: Record<string, unknown>) => {
    Object.assign(input, structuredClone(personal), {
      owner: { ...personal.owner, team: "sample-team" },
    });
  },
  "a personal owner without the immutable GitHub id": (
    input: Record<string, unknown>,
  ) => {
    Object.assign(input, structuredClone(personal), {
      owner: { kind: "principal", github_login: "example" },
    });
  },
  "a personal Machine name that is not a DNS slug": (
    input: Record<string, unknown>,
  ) => {
    Object.assign(input, structuredClone(personal), {
      machine: { ...personal.machine, name: "Example" },
    });
  },
}))
  test(`the two branches never mix: ${name}`, () => {
    const input: Record<string, unknown> = structuredClone(fixture);
    change(input);
    expect(() => parseMachineContext(bytes(input))).toThrow(
      "machine-context-invalid",
    );
  });
test("ambiguous JSON, invalid UTF-8 and oversized input are refused", () => {
  for (const input of [
    Buffer.from('{"account":null,"account":null}'),
    Buffer.from([0xff]),
    Buffer.alloc(1024 * 1024 + 1, 32),
  ])
    expect(() => parseMachineContext(input)).toThrow("machine-context-invalid");
});
test("runtime operator binding is independent of schema validity", () => {
  const runtime = {
    platform: "linux",
    uid: 1000,
    username: "operator",
    homedir: "/home/operator",
  };
  const context = parseMachineContext(bytes(fixture));
  for (const patch of [
    { uid: 0 },
    { username: "other" },
    { homedir: "/home/other" },
    { platform: "darwin" },
  ])
    expect(() =>
      bindMachineOperator(context, { ...runtime, ...patch }),
    ).toThrow();
  const inconsistent = parseMachineContext(
    bytes({
      ...fixture,
      operator: { ...fixture.operator, lazurio_root: "/home/other/Lazurio" },
    }),
  );
  expect(() => bindMachineOperator(inconsistent, runtime)).toThrow(
    "machine-operator-mismatch",
  );
});
test("machine CLI refuses overrides, unknown presets and duplicate or invalid choices as usage errors before filesystem access", async () => {
  for (const args of [
    ["inspect", "--file", "/tmp/identity"],
    ["inspect", "--locale", "cs"],
    ["folder-init", "--locale", "cs", "--locale", "en"],
    ["folder-init", "--locale", "de"],
    ["folder-init", "--preset", "hosted-private"],
    ["folder-init", "--preset", "hosted-team"],
    ["folder-init", "--folder", "/tmp/target"],
    ["folder-init", "--json"],
    ["folder-init", "extra"],
    ["reset"],
  ])
    await expect(runMachineCommand(args)).rejects.toBeInstanceOf(
      MachineUsageError,
    );
});
test("a wrong machine invocation prints the help on stderr with exit 2, not a failed Folder operation", async () => {
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "machine", "folder-init", "--json"],
    { env: {}, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("machine folder-init [--preset <name>]");
  expect(stderr).not.toContain("Folder operation failed");
  // The in-process entry agrees and stays typed.
  const original = console.error;
  const lines: string[] = [];
  console.error = (line: string) => void lines.push(line);
  try {
    expect(await runCli(["machine", "inspect", "--json"])).toBe(2);
  } finally {
    console.error = original;
  }
  expect(lines[0]).toContain("machine inspect");
});
test.skipIf(process.platform === "linux")(
  "production consumer does not invent a context on another OS",
  async () => {
    expect(await runMachineCommand(["inspect"])).toMatchObject({
      code: 2,
      result: { reason: "machine-platform-unsupported" },
    });
  },
);
test.skipIf(process.platform === "win32")(
  "custody reader rejects wrong UID, writable files, symlinks and hardlinks without mutation",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "machine-custody-")),
    );
    const path = join(parent, "identity.json");
    const content = bytes(fixture);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("POSIX test requires UID");
    try {
      await writeFile(path, content, { mode: 0o644 });
      expect(await readCustodiedDeclarationBytes(path, uid)).toEqual(content);
      await expect(
        readCustodiedDeclarationBytes(path, uid + 1),
      ).rejects.toThrow();
      await chmod(path, 0o664);
      await expect(readCustodiedDeclarationBytes(path, uid)).rejects.toThrow();
      await chmod(path, 0o644);
      await symlink(path, join(parent, "link"));
      await expect(
        readCustodiedDeclarationBytes(join(parent, "link"), uid),
      ).rejects.toThrow();
      await link(path, join(parent, "hardlink"));
      await expect(readCustodiedDeclarationBytes(path, uid)).rejects.toThrow();
      expect(await readFile(path)).toEqual(content);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
