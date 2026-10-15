import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  parseVaultSettingUp,
  parseVaultStatus,
  vaultAction,
  vaultOpenLink,
  vaultRowLine,
} from "../src/launchpad/vault-view";
import type { VaultStatus } from "../src/vault/flow";

// The Environment's own vault on the tools screen (decision F53, the
// wireframe of prototypes-lazurio#33): the row's states, "Otevřít trezor",
// the one action where a setup moves the vault on, and the server's answers
// taken only in their exact form.

const cs = messages("cs");
const en = messages("en");
const organizationId = "0b9e2f3a-5c1d-4e8f-9a7b-1c2d3e4f5a6b";
const collectionId = "6a5f4e3d-2c1b-4a9f-8e7d-6c5b4a3f2e1d";
const facts = {
  vault: "https://vaultwarden.example.lazurio.io",
  account: "vaultwarden-ndbrmzvjpwxtt3q7m2e4fihgsa@example.lazurio.io",
  name: "Example Osobní example",
  team: false,
  origin: "own",
};
const status = (value: Record<string, unknown>): VaultStatus => {
  const parsed = parseVaultStatus({ kind: "vault-status", ...facts, ...value });
  if (parsed === null) throw new Error("Unexpected refusal");
  return parsed;
};
const connected = {
  state: "connected",
  organizationId,
  collectionId,
  organization: "Example Osobní example",
  items: 14,
};

test("every state the server answers is read back exactly; anything else is refused", () => {
  for (const value of [
    { state: "not-set-up", next: "install" },
    { state: "not-set-up", next: "vault" },
    { state: "creating" },
    { state: "not-allowed" },
    connected,
    { ...connected, organization: null, items: null, locked: true },
    { state: "revoked" },
    { state: "unreachable", reason: "unreachable" },
    {
      state: "failed",
      stage: "vault",
      reason: "organization-refused",
      fallback: "agent",
    },
  ])
    expect(status(value)).toEqual({
      kind: "vault-status",
      ...facts,
      ...value,
    } as VaultStatus);
  // A 0197 pilot's status carries no vault name.
  expect(
    parseVaultStatus({
      kind: "vault-status",
      ...facts,
      name: null,
      origin: "pilot-0197",
      ...connected,
    }),
  ).toMatchObject({ origin: "pilot-0197", name: null });
  for (const reason of [
    "workstation",
    "folder-unreadable",
    "handover-missing",
    "handover-unreadable",
    "not-operator",
    "no-vault",
  ] as const)
    expect(
      parseVaultStatus({ kind: "vault-status", state: "unsupported", reason }),
    ).toEqual({ kind: "vault-status", state: "unsupported", reason });
  for (const refused of [
    null,
    [],
    { kind: "vault-status", state: "unsupported", reason: "vault-unknown" },
    { kind: "vault-status", ...facts, state: "confirming" },
    { kind: "vault-status", ...facts, state: "awaiting-invite" },
    { kind: "vault-status", ...facts, state: "not-set-up", next: "connect" },
    { kind: "vault-status", ...facts, origin: "theirs", ...connected },
    {
      kind: "vault-status",
      ...facts,
      vault: "http://vaultwarden.example.lazurio.io",
      ...connected,
    },
    {
      kind: "vault-status",
      ...facts,
      vault: "https://vaultwarden.example.lazurio.io/path",
      ...connected,
    },
    { kind: "vault-status", ...facts, ...connected, organizationId: "x" },
    { kind: "vault-status", ...facts, ...connected, items: -1 },
    { kind: "vault-status", ...facts, ...connected, locked: false },
    { kind: "vault-status", ...facts, account: "a\u202eb", ...connected },
    {
      kind: "vault-status",
      ...facts,
      state: "failed",
      stage: "confirm",
      reason: "x",
      fallback: "agent",
    },
  ])
    expect([refused, parseVaultStatus(refused)]).toEqual([refused, null]);
});

test("a running setup is read with its job and phase only", () => {
  const job = "0123456789abcdef0123456789abcdef";
  for (const phase of ["install", "account", "vault", "sign-in"] as const)
    expect(
      parseVaultSettingUp({ kind: "vault-setting-up", job, phase }),
    ).toEqual({ job, phase });
  for (const refused of [
    { kind: "vault-connecting", job, phase: "install" },
    { kind: "vault-setting-up", job: "x", phase: "install" },
    { kind: "vault-setting-up", job, phase: "confirm" },
    null,
  ])
    expect(parseVaultSettingUp(refused)).toBeNull();
});

test("the row says the state in few words, formally in Czech, and the step of a setup that runs", () => {
  const lines = (copy: typeof cs) =>
    [
      vaultRowLine(null, null, copy),
      vaultRowLine(status(connected), null, copy),
      vaultRowLine(
        status({ state: "not-set-up", next: "install" }),
        null,
        copy,
      ),
      vaultRowLine(status({ state: "creating" }), null, copy),
      vaultRowLine(status({ state: "not-allowed" }), null, copy),
      vaultRowLine(status({ state: "revoked" }), null, copy),
      vaultRowLine(
        status({ state: "revoked", origin: "pilot-0197", name: null }),
        null,
        copy,
      ),
      vaultRowLine(
        status({ state: "unreachable", reason: "unreachable" }),
        null,
        copy,
      ),
      vaultRowLine(
        status({
          state: "failed",
          stage: "vault",
          reason: "x",
          fallback: "agent",
        }),
        null,
        copy,
      ),
      vaultRowLine(
        { kind: "vault-status", state: "unsupported", reason: "no-vault" },
        null,
        copy,
      ),
      vaultRowLine(
        { kind: "vault-status", state: "unsupported", reason: "workstation" },
        null,
        copy,
      ),
      vaultRowLine(null, "vault", copy),
    ].map((line) => `${line.state}: ${line.text}`);
  expect(lines(cs)).toEqual([
    "unknown: Zjišťuji stav…",
    "signed-in: Připojeno",
    "unknown: Zatím nenastaveno",
    "unknown: Trezor se zakládá",
    "signed-out: Síť zatím účet trezoru nepovolila",
    "signed-out: Trezor byl odebrán",
    "signed-out: Přístup odebrán v trezoru",
    "signed-out: Trezor neodpovídá",
    "signed-out: Nastavení se nedokončilo",
    "unknown: Toto Prostředí zatím trezor nemá",
    "unknown: Brzy · druhá vlna",
    "unknown: Připravuje se trezor…",
  ]);
  expect(lines(en)).toEqual([
    "unknown: Checking…",
    "signed-in: Connected",
    "unknown: Not set up yet",
    "unknown: The vault is being created",
    "signed-out: The network has not allowed its account yet",
    "signed-out: The vault was removed",
    "signed-out: Access removed in the vault",
    "signed-out: The vault does not answer",
    "signed-out: The setup did not finish",
    "unknown: This Environment has no vault yet",
    "unknown: Soon · second wave",
    "unknown: Preparing the vault…",
  ]);
});

test("the row opens the connected vault and offers one action only where a setup moves it on", () => {
  expect(vaultOpenLink(status(connected))).toBe(
    `https://vaultwarden.example.lazurio.io/#/vault?organizationId=${organizationId}`,
  );
  expect(cs.vaultOpen).toBe("Otevřít trezor");
  for (const value of [
    { state: "not-set-up", next: "vault" },
    { state: "not-allowed" },
    { state: "revoked" },
  ])
    expect(vaultOpenLink(status(value))).toBeNull();
  expect(vaultOpenLink(null)).toBeNull();
  // Set up when nothing did, try again after a setup that stopped; never a
  // disconnect, never for a vault the network has to act on, a pilot or a
  // setup that runs.
  expect(
    vaultAction(status({ state: "not-set-up", next: "install" }), null, cs),
  ).toBe("Nastavit");
  expect(
    vaultAction(status({ state: "unreachable", reason: "x" }), null, cs),
  ).toBe("Zkusit znovu");
  // A creation not confirmed yet: looked for again, never made twice.
  expect(vaultAction(status({ state: "creating" }), null, cs)).toBe(
    "Zkusit znovu",
  );
  expect(vaultOpenLink(status({ state: "creating" }))).toBeNull();
  expect(
    vaultAction(
      status({
        state: "failed",
        stage: "install",
        reason: "x",
        fallback: "agent",
      }),
      null,
      cs,
    ),
  ).toBe("Zkusit znovu");
  for (const value of [
    connected,
    { state: "not-allowed" },
    { state: "revoked" },
    {
      state: "unreachable",
      reason: "x",
      origin: "pilot-0197",
      name: null,
    },
  ])
    expect([value, vaultAction(status(value), null, cs)]).toEqual([
      value,
      null,
    ]);
  expect(
    vaultAction(
      status({ state: "not-set-up", next: "install" }),
      "install",
      cs,
    ),
  ).toBeNull();
  expect(
    vaultAction(
      { kind: "vault-status", state: "unsupported", reason: "no-vault" },
      null,
      cs,
    ),
  ).toBeNull();
});
