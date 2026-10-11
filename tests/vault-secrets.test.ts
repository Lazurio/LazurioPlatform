import { expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMachineContext } from "../src/machine/context";
import { parseSecretItems } from "../src/vault/bw";
import {
  type VaultContext,
  type VaultUnsupported,
  vaultContextOf,
} from "../src/vault/context";
import {
  type VaultHost,
  type VaultJournalEntry,
  vaultConnect,
  vaultRefresh,
  vaultSecrets,
  vaultSecretsAdmission,
} from "../src/vault/flow";
import {
  collectionId,
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  organizationId,
  otherCollectionId,
  personalHandover,
  startFakeVault,
  zipOf,
  zone,
} from "./fixtures/fake-vault";
import { handoverEntry } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";

// The runtime secrets of an application from the Environment vault
// (decision F46, root decision 0177): a sync, then the one item of each
// declared name in the Environment's collection, its login password the
// value. Against the fake Vaultwarden and the fake bw of the vault's own
// tests; every name, id and value is invented.

const posix = process.platform !== "win32";
const otherOrganizationId = "9c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a";
// A value that must never appear anywhere but in the result.
const value = "fake-runtime-secret-value-7f3a9c";
const changed = "fake-runtime-secret-value-changed-2b8e4d";

/** The work Environment `workspace` of the Organization `example`. */
const workHandover = parseMachineContext(
  Buffer.from(
    JSON.stringify({
      ...organization,
      owner: { kind: "organization", organization: "example" },
      network: {
        headscale_server_url: `https://headscale.${zone}`,
        headscale_hostname: "example-workspace",
      },
      entry: handoverEntry("workspace.example.lazurio.io"),
    }),
  ),
);
const workContext = vaultContextOf({
  handover: workHandover,
  kind: "work",
  label: null,
});

type Item = Readonly<{
  name: string;
  password?: string | null;
  organization?: string | null;
  collections?: readonly string[];
  notes?: string;
}>;

/** A connected work Environment: invited, connected, confirmed, refreshed. */
async function connected() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "vault-secrets-")),
  );
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const release = fakeRelease(pin, zip);
  const journal: VaultJournalEntry[] = [];
  const host = fakeHost({
    home,
    vault,
    pin,
    download: release.fetch,
    journal,
    context: async () => workContext,
  });
  if (workContext.kind === "unsupported") throw new Error("unsupported");
  vault.invite(workContext.account);
  await vaultConnect(host);
  await vault.confirm(workContext.collection, 0);
  expect(await vaultRefresh(host)).toMatchObject({ state: "connected" });
  /** What the next sync brings: the items of the vault. */
  const items = (list: readonly Item[]) =>
    writeFile(
      join(vault.world, "items.json"),
      JSON.stringify(
        list.map((item) => ({
          object: "item",
          id: crypto.randomUUID(),
          type: 1,
          name: item.name,
          organizationId:
            item.organization === undefined
              ? organizationId
              : item.organization,
          collectionIds: item.collections ?? [collectionId],
          notes: item.notes ?? null,
          login:
            item.password === undefined
              ? { username: "example", password: value }
              : item.password === null
                ? null
                : { username: "example", password: item.password },
        })),
      ),
    );
  return {
    parent,
    home,
    vault,
    host,
    journal,
    items,
    async close() {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const lastIndex = (lines: readonly string[], prefix: string) =>
  lines.map((line) => line.startsWith(prefix)).lastIndexOf(true);

// Every file under a directory, read as text, but those under `skip`:
// nothing written may hold a value.
async function everyFile(directory: string, skip?: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && (skip === undefined || !path.startsWith(`${skip}/`)))
      text += await readFile(path, "utf8").catch(() => "");
  }
  return text;
}

test.skipIf(!posix)(
  "a declared name is the login password of the one item of that name in the Environment's collection, read after a sync and never written anywhere",
  async () => {
    const w = await connected();
    try {
      await w.items([
        { name: "EXTERNAL_API_KEY", notes: "fake-unrelated-note-5c1e" },
        { name: "UNRELATED_ITEM", password: "fake-unrelated-value-0d4f" },
      ]);
      const result = await vaultSecrets(w.host, {
        company: "Example",
        names: ["EXTERNAL_API_KEY"],
      });
      expect(result).toEqual({
        kind: "vault-secrets",
        secrets: new Map([["EXTERNAL_API_KEY", { kind: "value", value }]]),
      });
      // A sync came first; the items of exactly the connected collection
      // were listed; no value was ever an argument.
      const calls = await w.vault.calls();
      const lines = calls.trim().split("\n");
      const sync = lastIndex(lines, "sync ");
      const list = lastIndex(lines, "list items");
      expect(sync).toBeGreaterThan(-1);
      expect(list).toBeGreaterThan(sync);
      expect(lines[list]).toBe(
        `list items --organizationid ${organizationId} --collectionid ${collectionId} --nointeraction|session=yes`,
      );
      expect(calls).not.toContain(value);
      // The journal says what happened, never a value or a name.
      expect(w.journal.at(-1)).toEqual({
        operation: "secrets",
        outcome: "read",
      });
      expect(JSON.stringify(w.journal)).not.toContain(value);
      // No file of this Platform under XDG_STATE_HOME or the install base
      // holds it. The fake CLI keeps its synced copy in plain text under
      // `fake/` of its data directory, where the real bw keeps its
      // encrypted store; that copy is bw's, not this Platform's.
      const state = join(w.home, ".local", "state");
      const data = join(
        state,
        "lazurio",
        "vault",
        "vaultwarden.example.lazurio.io",
        "workspace.example.lazurio.io",
        "bw",
      );
      expect(await everyFile(state, join(data, "fake"))).not.toContain(value);
      expect(await everyFile(join(w.home, ".local", "share"))).not.toContain(
        value,
      );
    } finally {
      await w.close();
    }
  },
);

test.skipIf(!posix)(
  "missing, held twice, in another collection or organization, or without a password: no value, and why",
  async () => {
    const w = await connected();
    try {
      await w.items([
        { name: "TWICE" },
        { name: "TWICE", password: "fake-second-value-6a1c" },
        { name: "ELSEWHERE", collections: [otherCollectionId] },
        { name: "FOREIGN", organization: otherOrganizationId },
        { name: "PERSONAL", organization: null, collections: [] },
        { name: "EMPTY", password: "" },
        { name: "NO_LOGIN", password: null },
        // Another case of the name is another name.
        { name: "external_api_key" },
      ]);
      const result = await vaultSecrets(w.host, {
        company: "example",
        names: [
          "MISSING",
          "TWICE",
          "ELSEWHERE",
          "FOREIGN",
          "PERSONAL",
          "EMPTY",
          "NO_LOGIN",
          "EXTERNAL_API_KEY",
        ],
      });
      expect(result).toEqual({
        kind: "vault-secrets",
        secrets: new Map([
          ["MISSING", { kind: "absent", reason: "missing" }],
          ["TWICE", { kind: "absent", reason: "ambiguous" }],
          ["ELSEWHERE", { kind: "absent", reason: "missing" }],
          ["FOREIGN", { kind: "absent", reason: "missing" }],
          ["PERSONAL", { kind: "absent", reason: "missing" }],
          ["EMPTY", { kind: "absent", reason: "empty" }],
          ["NO_LOGIN", { kind: "absent", reason: "empty" }],
          ["EXTERNAL_API_KEY", { kind: "absent", reason: "missing" }],
        ]),
      });
      expect(
        JSON.stringify([
          ...(result.kind === "vault-secrets" ? result.secrets : []),
        ]),
      ).not.toContain(value);
    } finally {
      await w.close();
    }
  },
);

test.skipIf(!posix)(
  "a value changed in the vault is read at the next start",
  async () => {
    const w = await connected();
    try {
      await w.items([{ name: "EXTERNAL_API_KEY" }]);
      const read = async () => {
        const result = await vaultSecrets(w.host, {
          company: "example",
          names: ["EXTERNAL_API_KEY"],
        });
        return result.kind === "vault-secrets"
          ? result.secrets.get("EXTERNAL_API_KEY")
          : result;
      };
      expect(await read()).toEqual({ kind: "value", value });
      await w.items([{ name: "EXTERNAL_API_KEY", password: changed }]);
      expect(await read()).toEqual({ kind: "value", value: changed });
    } finally {
      await w.close();
    }
  },
);

test.skipIf(!posix)(
  "an unreachable vault and a revoked access refuse every name with a fixed reason",
  async () => {
    const w = await connected();
    try {
      await w.items([{ name: "EXTERNAL_API_KEY" }]);
      await w.vault.unreachable(true);
      const unreachable = await vaultSecrets(w.host, {
        company: "example",
        names: ["EXTERNAL_API_KEY"],
      });
      expect(unreachable).toEqual({
        kind: "vault-secrets-refused",
        reason: "unreachable",
      });
      expect(w.journal.at(-1)).toEqual({
        operation: "secrets",
        outcome: "refused",
        reason: "unreachable",
      });
      await w.vault.unreachable(false);
      // The vault refuses the account's grant: no longer connected.
      await writeFile(join(w.vault.world, "invalid-grant"), "");
      expect(
        await vaultSecrets(w.host, {
          company: "example",
          names: ["EXTERNAL_API_KEY"],
        }),
      ).toEqual({ kind: "vault-secrets-refused", reason: "not-connected" });
    } finally {
      await w.close();
    }
  },
);

test("a workstation, an Environment without a vault account and an application of another Organization never run bw", async () => {
  const calls: string[][] = [];
  const host = (context: VaultContext | VaultUnsupported): VaultHost => ({
    ...fakeHost({
      home: "/nonexistent",
      vault: {} as never,
      pin: fakePin(new Uint8Array()),
      download: async () => new Response(null, { status: 404 }),
      context: async () => context,
    }),
    run: async (command: readonly string[]) => {
      calls.push([...command]);
      return { exitCode: 1, stdout: "", stderr: "" };
    },
  });
  const read = (
    context: VaultContext | VaultUnsupported,
    company = "example",
  ) => vaultSecrets(host(context), { company, names: ["EXTERNAL_API_KEY"] });
  expect(await read({ kind: "unsupported", reason: "workstation" })).toEqual({
    kind: "vault-secrets-refused",
    reason: "workstation",
  });
  expect(
    await read({ kind: "unsupported", reason: "handover-missing" }),
  ).toEqual({ kind: "vault-secrets-refused", reason: "no-vault-identity" });
  // The work Environment of `example`: an app of `gamma` reads nothing from
  // its collection; the slug compares as GitHub's, case-insensitively.
  expect(await read(workContext, "gamma")).toEqual({
    kind: "vault-secrets-refused",
    reason: "other-organization",
  });
  // A person's Environment: no Organization's app reads its secrets.
  const personal = vaultContextOf({
    handover: personalHandover,
    kind: "personal",
    label: null,
  });
  expect(await read(personal)).toEqual({
    kind: "vault-secrets-refused",
    reason: "other-organization",
  });
  expect(calls).toEqual([]);
  expect(await vaultSecretsAdmission(host(workContext), "EXAMPLE")).toBeNull();
  expect(await vaultSecretsAdmission(host(workContext), "gamma")).toBe(
    "other-organization",
  );
  // Not connected: refused before bw reads anything of the vault.
  expect(await read(workContext)).toEqual({
    kind: "vault-secrets-refused",
    reason: "not-connected",
  });
});

test("the item reader keeps only the declared names and only what the selection reads", () => {
  const names = new Set(["EXTERNAL_API_KEY"]);
  const stdout = JSON.stringify([
    {
      name: "EXTERNAL_API_KEY",
      organizationId,
      collectionIds: [collectionId],
      notes: "fake-unrelated-note",
      fields: [{ name: "x", value: "fake-field-value" }],
      login: { username: "u", password: value, totp: "fake-totp" },
    },
    { name: "OTHER", login: { password: "fake-other-value" } },
    { name: "NOTE", type: 2, login: null },
  ]);
  const items = parseSecretItems(stdout, names);
  expect(items).toEqual([
    {
      name: "EXTERNAL_API_KEY",
      organizationId,
      collectionIds: [collectionId],
      password: value,
    },
  ]);
  expect(JSON.stringify(items)).not.toContain("fake-other-value");
  expect(JSON.stringify(items)).not.toContain("fake-field-value");
  // A candidate whose ids are not the vault's shape is unreadable, not
  // guessed; so is an answer that is not a list of items.
  expect(
    parseSecretItems(
      JSON.stringify([{ name: "EXTERNAL_API_KEY", collectionIds: ["x"] }]),
      names,
    ),
  ).toBeNull();
  expect(parseSecretItems("not json", names)).toBeNull();
  expect(parseSecretItems(JSON.stringify([1]), names)).toBeNull();
});
