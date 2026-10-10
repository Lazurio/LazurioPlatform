import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  parseVaultConnecting,
  parseVaultStatus,
  vaultActions,
  vaultAfterConnect,
  vaultLink,
  vaultPhaseMarks,
  vaultRowLine,
  vaultSeen,
  vaultStartStep,
} from "../src/launchpad/vault-view";
import type { VaultStatus } from "../src/vault/flow";

// The Environment vault on the tools screen (decision F43, the wireframe of
// prototypes-lazurio#24): the row's states, its one next step, the dialog's
// steps and the server's answers taken only in their exact form.

const cs = messages("cs");
const en = messages("en");
const facts = {
  vault: "https://vaultwarden.example.lazurio.io",
  account: "vaultwarden@example.lazurio.io",
  collection: "Environmenty/Osobní · example",
  name: "Osobní",
  team: false,
};
const fingerprint = "steep-flavor-uncut-scouring-unnoticed";
const status = (value: Record<string, unknown>): VaultStatus => {
  const parsed = parseVaultStatus({ kind: "vault-status", ...facts, ...value });
  if (parsed === null) throw new Error("Unexpected refusal");
  return parsed;
};

test("every state the server answers is read back exactly; anything else is refused", () => {
  for (const value of [
    { state: "none", registered: false },
    { state: "not-installed", registered: true },
    { state: "awaiting-invite" },
    { state: "confirming", fingerprint, organization: null },
    { state: "confirming", fingerprint, organization: "Example", locked: true },
    {
      state: "connected",
      fingerprint,
      organization: "Example",
      collections: 2,
      items: 14,
    },
    {
      state: "connected",
      fingerprint,
      organization: null,
      collections: null,
      items: null,
      locked: true,
    },
    { state: "revoked", fingerprint: null },
    { state: "unreachable", fingerprint, reason: "unreachable" },
    {
      state: "failed",
      stage: "install",
      reason: "checksum-mismatch",
      fallback: "agent",
    },
  ])
    expect(status(value) as unknown).toEqual({
      kind: "vault-status",
      ...facts,
      ...value,
    });
  expect(
    parseVaultStatus({
      kind: "vault-status",
      state: "unsupported",
      reason: "workstation",
    }),
  ).toEqual({
    kind: "vault-status",
    state: "unsupported",
    reason: "workstation",
  });
  for (const refused of [
    { ...facts, kind: "vault-status", state: "connected", fingerprint },
    { ...facts, kind: "vault-status", state: "none" },
    { ...facts, kind: "vault-status", state: "elsewhere" },
    {
      ...facts,
      kind: "vault-status",
      state: "awaiting-invite",
      vault: "https://evil.example.invalid",
    },
    {
      ...facts,
      kind: "vault-status",
      state: "awaiting-invite",
      account: "a\u202eb",
    },
    {
      ...facts,
      kind: "vault-status",
      state: "confirming",
      fingerprint: "two words",
      organization: null,
    },
    { kind: "vault-status", state: "unsupported", reason: "maybe" },
    null,
    [],
    "connected",
  ])
    expect(parseVaultStatus(refused)).toBeNull();
  const job = "0123456789abcdef0123456789abcdef";
  expect(
    parseVaultConnecting({ kind: "vault-connecting", job, phase: "account" }),
  ).toEqual({ job, phase: "account" });
  expect(
    parseVaultConnecting({ kind: "vault-connecting", job, phase: "x" }),
  ).toBeNull();
  expect(
    parseVaultConnecting({
      kind: "vault-connecting",
      job: "1",
      phase: "install",
    }),
  ).toBeNull();
});

test("the row says the wireframe's states, with Czech plurals", () => {
  const line = (value: Record<string, unknown>, copy = cs) =>
    vaultRowLine(status(value), copy).text;
  expect(line({ state: "none", registered: false })).toBe("Nepřipojeno");
  expect(line({ state: "confirming", fingerprint, organization: null })).toBe(
    "Čeká na potvrzení v trezoru",
  );
  // Confirmed in an organization, without the Environment's collection.
  expect(
    line({ state: "confirming", fingerprint, organization: "Example" }),
  ).toBe("Potvrzeno, čeká na kolekci");
  expect(
    line({ state: "confirming", fingerprint, organization: "Example" }, en),
  ).toBe("Confirmed, waiting for the collection");
  const connected = (collections: number, items: number) =>
    line({
      state: "connected",
      fingerprint,
      organization: "Example",
      collections,
      items,
    });
  expect(connected(2, 14)).toBe("Připojeno · 2 kolekce · 14 položek");
  expect(connected(1, 1)).toBe("Připojeno · 1 kolekce · 1 položka");
  expect(connected(5, 3)).toBe("Připojeno · 5 kolekcí · 3 položky");
  expect(connected(0, 0)).toBe("Připojeno · 0 kolekcí · 0 položek");
  expect(
    line(
      {
        state: "connected",
        fingerprint,
        organization: "Example",
        collections: 1,
        items: 2,
      },
      en,
    ),
  ).toBe("Connected · 1 collection · 2 items");
  expect(line({ state: "revoked", fingerprint })).toBe(
    "Přístup odebrán v trezoru",
  );
  expect(line({ state: "unreachable", fingerprint, reason: "timeout" })).toBe(
    "Trezor neodpovídá",
  );
  expect(
    vaultRowLine(
      { kind: "vault-status", state: "unsupported", reason: "workstation" },
      cs,
    ).text,
  ).toBe("Brzy · druhá vlna");
  expect(vaultRowLine(null, cs).text).toBe("Zjišťuji stav…");
  expect(vaultSeen(3, 21, cs)).toBe("3 kolekce · 21 položek");
});

test("each state offers one next step, and Odpojit once an account is signed in", () => {
  const actions = (value: Record<string, unknown>) => {
    const { primary, disconnect } = vaultActions(status(value), cs);
    return [primary?.action ?? null, primary?.label ?? null, disconnect];
  };
  expect(actions({ state: "none", registered: false })).toEqual([
    "connect",
    "Připojit",
    false,
  ]);
  expect(
    actions({ state: "confirming", fingerprint, organization: null }),
  ).toEqual(["continue", "Pokračovat", true]);
  expect(
    actions({
      state: "connected",
      fingerprint,
      organization: null,
      collections: 1,
      items: 1,
    }),
  ).toEqual([null, null, true]);
  expect(actions({ state: "revoked", fingerprint })).toEqual([
    "reconnect",
    "Připojit znovu",
    true,
  ]);
  expect(
    actions({ state: "unreachable", fingerprint, reason: "timeout" }),
  ).toEqual(["retry", "Zkusit znovu", true]);
  expect(
    vaultActions(
      { kind: "vault-status", state: "unsupported", reason: "workstation" },
      cs,
    ),
  ).toEqual({ primary: null, disconnect: false });
});

test("the dialog starts where the state is and goes where a connect ends", () => {
  expect(
    vaultStartStep(status({ state: "none", registered: false }), "connect"),
  ).toBe("invite");
  // An account that exists only signs in again.
  expect(
    vaultStartStep(status({ state: "none", registered: true }), "connect"),
  ).toBe("connect");
  expect(
    vaultStartStep(
      status({ state: "confirming", fingerprint, organization: null }),
      "continue",
    ),
  ).toBe("confirm");
  expect(
    vaultStartStep(status({ state: "revoked", fingerprint }), "reconnect"),
  ).toBe("invite");
  expect(vaultAfterConnect(status({ state: "awaiting-invite" }), cs)).toEqual({
    step: "invite",
    failure: "Adresa ještě není v trezoru pozvaná.",
    agent: false,
  });
  expect(
    vaultAfterConnect(
      status({ state: "confirming", fingerprint, organization: null }),
      cs,
    ),
  ).toEqual({ step: "confirm", failure: null, agent: false });
  expect(
    vaultAfterConnect(
      status({
        state: "connected",
        fingerprint,
        organization: null,
        collections: 1,
        items: 0,
      }),
      cs,
    ),
  ).toEqual({ step: "done", failure: null, agent: false });
  expect(
    vaultAfterConnect(
      status({
        state: "unreachable",
        fingerprint: null,
        reason: "unreachable",
      }),
      cs,
    ),
  ).toEqual({ step: "connect", failure: "Trezor neodpovídá.", agent: false });
  expect(
    vaultAfterConnect(
      status({
        state: "failed",
        stage: "account",
        reason: "rate-limited",
        fallback: "agent",
      }),
      cs,
    ),
  ).toEqual({
    step: "connect",
    failure: "Připojení se nedokončilo (account: rate-limited).",
    agent: true,
  });
  expect(vaultPhaseMarks("account", cs)).toEqual([
    { label: "Instaluji Bitwarden", mark: "done" },
    { label: "Zakládám účet", mark: "running" },
    { label: "Přihlašuji", mark: "next" },
  ]);
  expect(vaultPhaseMarks("done", cs).map((entry) => entry.mark)).toEqual([
    "done",
    "done",
    "done",
  ]);
});

test("only the Environment's own vault becomes a link", () => {
  expect(vaultLink("https://vaultwarden.example.lazurio.io")).toBe(
    "https://vaultwarden.example.lazurio.io/",
  );
  for (const refused of [
    "http://vaultwarden.example.lazurio.io",
    "https://vault.example.lazurio.io",
    "https://vaultwarden.example.lazurio.io:8443",
    "https://vaultwarden.example.lazurio.io/admin",
    "javascript:alert(1)",
  ])
    expect(vaultLink(refused)).toBeNull();
});
