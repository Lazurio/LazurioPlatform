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
import { parseSecretItems } from "../src/vault/bw";
import type { VaultContext, VaultUnsupported } from "../src/vault/context";
import {
  type VaultHost,
  type VaultJournalEntry,
  vaultSecrets,
  vaultSecretsAdmission,
  vaultSetup,
} from "../src/vault/flow";
import { readRecord, vaultPaths } from "../src/vault/store";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownContext,
  personalHandover,
  startFakeVault,
  stateDirectory,
  workAccount,
  workHandover,
  zipOf,
} from "./fixtures/fake-vault";

// The runtime secrets of an application from the Environment's own vault
// (decision F46 as F53 amends it, root decision 0177): a sync, then the one
// item of each declared name anywhere in the vault, its login password the
// value. A work Environment serves its owning Organization's applications, a
// personal one the Personalspace's (0198 point 4). Against the fake
// Vaultwarden and the fake bw; every name, id and value is invented.

const posix = process.platform !== "win32";
const otherOrganizationId = "9c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a";
const otherCollectionId = "1f2e3d4c-5b6a-4f9e-8d7c-6b5a4f3e2d1c";
// A value that must never appear anywhere but in the result.
const value = "fake-runtime-secret-value-7f3a9c";
const changed = "fake-runtime-secret-value-changed-2b8e4d";

/** The work Environment `workspace` of the Organization `example`. */
const workContext = ownContext(workHandover(), "work");
const application = { company: "Example", personalspace: false } as const;

type Item = Readonly<{
  name: string;
  password?: string | null;
  /** Another organization's (`foreign`) or the account's own (`personal`). */
  owner?: "foreign" | "personal";
  /** Agenti by default. */
  collection?: "other";
  notes?: string;
}>;

/** A work Environment whose own vault is set up. */
async function connected() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "vault-secrets-")),
  );
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const journal: VaultJournalEntry[] = [];
  const host = fakeHost({
    home,
    vault,
    pin,
    download: fakeRelease(pin, zip).fetch,
    journal,
    context: async () => workContext,
  });
  vault.allow(workAccount);
  expect(await vaultSetup(host)).toMatchObject({ state: "connected" });
  const paths = vaultPaths(
    stateDirectory(home, "vaultwarden.example.lazurio.io", workAccount),
  );
  const record = await readRecord(paths);
  const organizationId = record.organizationId ?? "?";
  const agents = record.collectionId ?? "?";
  /** What the next sync brings: the items of the vault. */
  const items = (list: readonly Item[]) =>
    vault.items(
      list.map((item) => ({
        object: "item",
        id: crypto.randomUUID(),
        type: 1,
        name: item.name,
        organizationId:
          item.owner === "foreign"
            ? otherOrganizationId
            : item.owner === "personal"
              ? null
              : organizationId,
        collectionIds:
          item.owner === "personal"
            ? []
            : [item.collection === "other" ? otherCollectionId : agents],
        notes: item.notes ?? null,
        login:
          item.password === undefined
            ? { username: "example", password: value }
            : item.password === null
              ? null
              : { username: "example", password: item.password },
      })),
    );
  return {
    home,
    vault,
    host,
    journal,
    items,
    organizationId,
    agents,
    data: paths.data,
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
  "a declared name is the login password of the one item of that name anywhere in the Environment's vault, read after a sync and never written anywhere",
  async () => {
    const w = await connected();
    try {
      await w.items([
        { name: "EXTERNAL_API_KEY", notes: "fake-unrelated-note-5c1e" },
        // Another collection of the same vault holds one as well.
        {
          name: "SECOND_KEY",
          collection: "other",
          password: "fake-second-value-4e2a",
        },
        { name: "UNRELATED_ITEM", password: "fake-unrelated-value-0d4f" },
      ]);
      const result = await vaultSecrets(w.host, {
        ...application,
        names: ["EXTERNAL_API_KEY", "SECOND_KEY"],
      });
      expect(result).toEqual({
        kind: "vault-secrets",
        secrets: new Map([
          ["EXTERNAL_API_KEY", { kind: "value", value }],
          ["SECOND_KEY", { kind: "value", value: "fake-second-value-4e2a" }],
        ]),
      });
      // A sync came first; the items of exactly the own vault were listed;
      // no value was ever an argument.
      const calls = await w.vault.calls();
      const lines = calls.trim().split("\n");
      const sync = lastIndex(lines, "sync ");
      const list = lastIndex(lines, "list items --organizationid");
      expect(sync).toBeGreaterThan(-1);
      expect(list).toBeGreaterThan(sync);
      expect(lines[list]).toBe(
        `list items --organizationid ${w.organizationId} --nointeraction|session=yes`,
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
      expect(await everyFile(state, join(w.data, "fake"))).not.toContain(value);
      expect(await everyFile(join(w.home, ".local", "share"))).not.toContain(
        value,
      );
    } finally {
      await w.close();
    }
  },
);

test.skipIf(!posix)(
  "missing, held twice, in another organization or the account's own vault, or without a password: no value, and why",
  async () => {
    const w = await connected();
    try {
      await w.items([
        { name: "TWICE" },
        // Twice across two collections of the vault is twice too.
        { name: "TWICE", collection: "other", password: "fake-second-6a1c" },
        { name: "FOREIGN", owner: "foreign" },
        { name: "PERSONAL", owner: "personal" },
        { name: "EMPTY", password: "" },
        { name: "NO_LOGIN", password: null },
        // Another case of the name is another name.
        { name: "external_api_key" },
      ]);
      const result = await vaultSecrets(w.host, {
        ...application,
        names: [
          "MISSING",
          "TWICE",
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
  "a Secure note gives the value of its one hidden field; two hidden fields are ambiguous and none is empty",
  async () => {
    const w = await connected();
    try {
      // What an agent's secret request becomes (decision F54): text fields
      // for what is not secret, a hidden one for the secret.
      const note = (name: string, fields: readonly unknown[]) => ({
        object: "item",
        id: crypto.randomUUID(),
        type: 2,
        name,
        organizationId: w.organizationId,
        collectionIds: [w.agents],
        notes: "fake-unrelated-note-8b1d",
        secureNote: { type: 0 },
        login: null,
        fields,
      });
      await w.vault.items([
        note("NOTE_KEY", [
          { name: "Client ID", value: "fake-client-id-3c9e", type: 0 },
          { name: "Client secret", value, type: 1 },
        ]),
        note("TWO_HIDDEN", [
          { name: "Key", value: "fake-first-hidden-5a0b", type: 1 },
          { name: "Secret", value: "fake-second-hidden-7e2c", type: 1 },
        ]),
        note("NO_HIDDEN", [
          { name: "Account", value: "fake-text-value-1f4d", type: 0 },
        ]),
        note("EMPTY_HIDDEN", [{ name: "Key", value: "", type: 1 }]),
      ]);
      const result = await vaultSecrets(w.host, {
        ...application,
        names: ["NOTE_KEY", "TWO_HIDDEN", "NO_HIDDEN", "EMPTY_HIDDEN"],
      });
      expect(result).toEqual({
        kind: "vault-secrets",
        secrets: new Map([
          ["NOTE_KEY", { kind: "value", value }],
          ["TWO_HIDDEN", { kind: "absent", reason: "ambiguous" }],
          ["NO_HIDDEN", { kind: "absent", reason: "empty" }],
          ["EMPTY_HIDDEN", { kind: "absent", reason: "empty" }],
        ]),
      });
      // Nothing of a note but the one hidden value reaches the answer.
      const answer = JSON.stringify([
        ...(result.kind === "vault-secrets" ? result.secrets : []),
      ]);
      for (const kept of [
        "fake-client-id-3c9e",
        "fake-first-hidden-5a0b",
        "fake-text-value-1f4d",
        "fake-unrelated-note-8b1d",
      ])
        expect(answer).not.toContain(kept);
      expect(await w.vault.calls()).not.toContain(value);
      expect(JSON.stringify(w.journal)).not.toContain(value);
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
          ...application,
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
  "an unreachable vault and a refused grant refuse every name with a fixed reason",
  async () => {
    const w = await connected();
    try {
      await w.items([{ name: "EXTERNAL_API_KEY" }]);
      await w.vault.unreachable(true);
      expect(
        await vaultSecrets(w.host, {
          ...application,
          names: ["EXTERNAL_API_KEY"],
        }),
      ).toEqual({ kind: "vault-secrets-refused", reason: "unreachable" });
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
          ...application,
          names: ["EXTERNAL_API_KEY"],
        }),
      ).toEqual({ kind: "vault-secrets-refused", reason: "not-connected" });
    } finally {
      await w.close();
    }
  },
);

test("which applications read the own vault: the owning Organization's on a work Environment, the Personalspace's on a personal one; everything else is refused before bw runs", async () => {
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
  const personal = ownContext(personalHandover, "personal");
  const cases = [
    // A work Environment of `example`: its own apps (slugs compare as
    // GitHub's, case-insensitively), never another Organization's or a
    // Personalspace module.
    [workContext, { company: "EXAMPLE", personalspace: false }, null],
    [
      workContext,
      { company: "gamma", personalspace: false },
      "other-organization",
    ],
    [workContext, { company: "example", personalspace: true }, "personalspace"],
    // A personal Environment: the Personalspace's modules, never an
    // Organization's app.
    [personal, { company: "personalspace", personalspace: true }, null],
    [
      personal,
      { company: "example", personalspace: false },
      "personal-environment",
    ],
    // No vault here: a workstation, or no vault named or readable.
    [
      { kind: "unsupported", reason: "workstation" },
      { company: "example", personalspace: false },
      "workstation",
    ],
    [
      { kind: "unsupported", reason: "no-vault" },
      { company: "example", personalspace: false },
      "no-vault-identity",
    ],
    [
      { kind: "unsupported", reason: "handover-missing" },
      { company: "example", personalspace: true },
      "no-vault-identity",
    ],
  ] as const;
  for (const [context, app, reason] of cases) {
    expect([app, await vaultSecretsAdmission(host(context), app)]).toEqual([
      app,
      reason,
    ]);
    // Admitted, but the vault is not set up here: refused before bw reads
    // anything of the vault.
    expect([
      app,
      await vaultSecrets(host(context), { ...app, names: ["KEY"] }),
    ]).toEqual([
      app,
      {
        kind: "vault-secrets-refused",
        reason: reason ?? "not-connected",
      },
    ]);
  }
  expect(calls).toEqual([]);
});

test("the item reader keeps only the declared names and only what the selection reads", () => {
  const organizationId = "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b";
  const collectionId = "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d";
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
      hidden: null,
    },
  ]);
  expect(JSON.stringify(items)).not.toContain("fake-other-value");
  expect(JSON.stringify(items)).not.toContain("fake-field-value");
  // A Secure note (decision F54): only how many hidden fields it has and the
  // value of the only one; its text fields and notes are dropped.
  const notes = parseSecretItems(
    JSON.stringify([
      {
        name: "EXTERNAL_API_KEY",
        type: 2,
        organizationId,
        collectionIds: [collectionId],
        notes: "fake-unrelated-note",
        secureNote: { type: 0 },
        fields: [
          { name: "Client ID", value: "fake-text-value", type: 0 },
          { name: "Client secret", value: "fake-hidden-value", type: 1 },
        ],
      },
      {
        name: "EXTERNAL_API_KEY",
        type: 2,
        organizationId,
        collectionIds: [collectionId],
        fields: [
          { name: "A", value: "fake-first-hidden", type: 1 },
          { name: "B", value: "fake-second-hidden", type: 1 },
        ],
      },
    ]),
    names,
  );
  expect(notes).toEqual([
    {
      name: "EXTERNAL_API_KEY",
      organizationId,
      collectionIds: [collectionId],
      password: null,
      hidden: { count: 1, value: "fake-hidden-value" },
    },
    {
      name: "EXTERNAL_API_KEY",
      organizationId,
      collectionIds: [collectionId],
      password: null,
      hidden: { count: 2, value: null },
    },
  ]);
  for (const kept of ["fake-text-value", "fake-unrelated-note", "fake-first"])
    expect(JSON.stringify(notes)).not.toContain(kept);
  // A note whose fields are not bw's shape is unreadable, not guessed.
  expect(
    parseSecretItems(
      JSON.stringify([{ name: "EXTERNAL_API_KEY", type: 2, fields: {} }]),
      names,
    ),
  ).toBeNull();
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
