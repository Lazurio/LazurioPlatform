import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import {
  derivePreset,
  type PresetName,
  presetProfile,
} from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import {
  machineContextPath,
  parseMachineContext,
} from "../src/machine/context";
import { runTool } from "../src/tools/status";
import { embeddedIdentity } from "../src/update/identity";
import { runVaultCommand, type VaultCliContext } from "../src/vault/cli";
import type { VaultHost } from "../src/vault/flow";
import { processVaultHost } from "../src/vault/host";
import { vaultPaths } from "../src/vault/store";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownContext,
  startFakeVault,
  stateDirectory,
  vaultMember,
  workAccount,
  zipOf,
} from "./fixtures/fake-vault";
import {
  assignments,
  binding,
  bindings,
  handoverEntry,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// Issue #470: what the generated Folder says about the Environment's vault
// follows what `lazurio vault status` reports. The Folder changes only by an
// explicit change (decision F14), so its `bitwarden` line claims no state of
// the vault: it tells an agent what each answer of the one source of truth
// means. These tests pair the line of the generated AGENTS.md and
// manual/this-machine.md with the answer of the real `lazurio vault status`
// for the same handover: no vault (`no-vault`, and `no-tailnet` of a public
// Organization's Environment), waiting for a person, connected and locked.
// Only those two reasons say there is no vault: `unsupported` for another
// one (an unreadable handover or connection record, review of #492) proves
// no absence, and the line sends the agent to the status's reason. Invented
// hosts and names only.

const posix = process.platform !== "win32";
const uid = process.getuid?.() ?? -1;
type Locale = "cs" | "en";

// The line's words for each answer, as an agent reads them.
const words = {
  cs: {
    source:
      "Jestli tu trezor je a v jakém je stavu, řekne jen `lazurio vault status`.",
    connected:
      "Hlásí-li `connected`, trezor patří Prostředí a jeho agenti ho používají sami: co v něm je, smějí použít bez ptaní.",
    // The only absence: `unsupported` with exactly these reasons.
    absent: {
      "no-vault":
        "Hlásí-li `unsupported` s důvodem `no-vault`, trezor tu zatím není, protože ho handover tohoto Prostředí nejmenuje;",
      "no-tailnet":
        "s důvodem `no-tailnet` tu záměrně není, protože jde o Prostředí veřejné Organizace.",
    },
    other:
      "Z jiné odpovědi, ani z `unsupported` s jiným důvodem, neusuzuj, že tu trezor není: může čekat na uživatele nebo teď nefungovat; řiď se tím, co `lazurio vault status` hlásí, včetně důvodu.",
    operator:
      "Dokud trezor připojený není, patří tajemství tam, kam řekne uživatel.",
    withoutVault:
      "Hlásí-li cokoli jiného než `connected`, `bw` ani `lazurio vault env` nepoužívej; potřebuješ-li tajemství, řekni uživateli, co hlásí, a zeptej se ho, kam tajemství patří.",
    env: 'S připojeným trezorem spusť na začátku práce `eval "$(lazurio vault env)"`',
    locked:
      "když `bw` hlásí zamčený trezor (`lazurio vault status` pak u `connected` uvádí `locked`), spusť ho znovu.",
    // What the line said before, on every Environment.
    claimed: "přihlášené k vlastnímu trezoru",
  },
  en: {
    source:
      "Only `lazurio vault status` says whether there is a vault here and in which state.",
    connected:
      "When it reports `connected`, the vault belongs to the Environment and its agents use it on their own: what you find in it you may use without asking.",
    absent: {
      "no-vault":
        "When it reports `unsupported` with the reason `no-vault`, there is no vault here yet, because this Environment's handover names none;",
      "no-tailnet":
        "with `no-tailnet` there is none on purpose, because this is a public Organization's Environment.",
    },
    other:
      "From any other answer, `unsupported` with another reason too, do not conclude that there is no vault: it may wait for a user or not work now; follow what `lazurio vault status` says, its reason included.",
    operator: "Until the vault is connected, secrets go where the user says.",
    withoutVault:
      "When it reports anything but `connected`, use neither `bw` nor `lazurio vault env`; when you need a secret, tell the user what it reports and ask them where the secret belongs.",
    env: 'With a connected vault, run `eval "$(lazurio vault env)"` at the start of work',
    locked:
      "when `bw` reports a locked vault (`lazurio vault status` then says `locked` with `connected`), run it again.",
    claimed: "signed in to this Environment's own vault",
  },
} as const;

/** What `lazurio vault status --json` answered, as far as the line reads
 * it. */
type Answer = Readonly<{ state: string; reason?: string; locked?: boolean }>;

/** The clauses that answer `answer`: in AGENTS.md the tool's purpose, in
 * the manual its purpose and its usage. Each names the CLI's own code. */
function clausesFor(answer: Answer, locale: Locale) {
  const w = words[locale];
  if (answer.state === "connected") {
    expect(w.connected).toContain("`connected`");
    if (answer.locked === true) expect(w.locked).toContain("`locked`");
    return {
      agents: [w.source, w.connected],
      manual: [
        w.source,
        w.connected,
        w.env,
        ...(answer.locked === true ? [w.locked] : []),
      ],
    };
  }
  // No vault only where `unsupported` names `no-vault` or `no-tailnet`.
  if (
    answer.state === "unsupported" &&
    (answer.reason === "no-vault" || answer.reason === "no-tailnet")
  ) {
    const absent = w.absent[answer.reason];
    expect(absent).toContain(`\`${answer.reason}\``);
    const said = [w.source, absent, w.operator];
    return { agents: said, manual: [...said, w.withoutVault] };
  }
  // Any other answer, `unsupported` for another reason too: no absence,
  // the status's reason is what the agent follows.
  if (answer.state === "unsupported")
    expect(w.other).toContain("`unsupported`");
  const said = [w.source, w.other, w.operator];
  return { agents: said, manual: [...said, w.withoutVault] };
}

/** How often a line names `unsupported`. */
const mentions = (line: string) => line.split("`unsupported`").length - 1;

/** The `bitwarden` line of a generated file. */
const toolLines = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("- `bitwarden` ("));

/** The generated Folder's line follows the answer: once in each file, no
 * claimed state, every clause that answers it, and `unsupported` named only
 * in the absence tied to `no-vault` and in the rule for any other reason, so
 * no reason but those two reads as "no vault". */
function expectLineFollows(
  label: string,
  outputs: ReturnType<typeof renderOutputs>,
  answer: Answer,
  locale: Locale,
) {
  const agents = toolLines(outputs["AGENTS.md"]);
  const manual = toolLines(outputs["manual/this-machine.md"]);
  expect([label, locale, agents.length, manual.length]).toEqual([
    label,
    locale,
    1,
    1,
  ]);
  const files = { agents: agents[0] ?? "", manual: manual[0] ?? "" };
  const expected = clausesFor(answer, locale);
  for (const file of ["agents", "manual"] as const) {
    expect([
      label,
      locale,
      file,
      files[file].includes(words[locale].claimed),
    ]).toEqual([label, locale, file, false]);
    expect([
      label,
      locale,
      file,
      mentions(files[file]),
      files[file].includes(words[locale].absent["no-vault"]),
      files[file].includes(words[locale].other),
    ]).toEqual([label, locale, file, 2, true, true]);
    for (const clause of expected[file])
      expect([
        label,
        locale,
        file,
        clause,
        files[file].includes(clause),
      ]).toEqual([label, locale, file, clause, true]);
  }
}

const folderOf = (preset: PresetName, document: unknown, locale: Locale) =>
  renderOutputs({
    preset,
    machine: binding(document),
    profile: presetProfile(preset, "linux", { locale }),
    tools: ["bitwarden"],
  });

const cli = (host: VaultHost): VaultCliContext => ({
  identity: embeddedIdentity(),
  platform: "linux",
  env: {},
  executable: process.execPath,
  host,
});

/** `lazurio vault status --json`, its words and whether `lazurio vault env`
 * hands out a session. */
async function vaultAnswer(context: VaultCliContext) {
  const json = await runVaultCommand(["status", "--json"], context);
  const text = await runVaultCommand(["status"], context);
  const env = await runVaultCommand(["env"], context);
  return {
    answer: JSON.parse(json.stdout ?? "") as Answer,
    text: text.stdout ?? "",
    env: env.code,
  };
}

// Handovers that name no vault: a work Environment on a tailnet whose
// network has no Lazurio Vaultwarden yet (issue #470's Environment), a public
// Organization's Environment reached without one (root decision 0204, F53's
// addendum of 2026-10-17) and a personal Environment whose person has not
// connected their own Bitwarden (root decision 0203 point 7).
const network = {
  headscale_server_url: "https://headscale.example.lazurio.io",
  headscale_hostname: "example",
};
const { team: _team, ...withoutTeam } = organization.owner;
const { network: _network, ...withoutNetwork } = organization;
const withoutVault = {
  work: {
    preset: "hosted-organization-personal",
    document: {
      ...organization,
      owner: { ...withoutTeam, assignment: assignments.operator },
      network: { ...network, headscale_hostname: "example-workspace" },
      entry: handoverEntry("workspace.example.lazurio.io"),
    },
  },
  public: {
    preset: "hosted-organization-personal",
    document: {
      ...withoutNetwork,
      owner: { ...withoutTeam, assignment: assignments.operator },
      entry: handoverEntry("workspace.example.lazurio.io"),
    },
  },
  personal: {
    preset: "hosted-personal",
    document: {
      ...personal,
      network,
      entry: handoverEntry("example.lazurio.io"),
    },
  },
} as const satisfies Record<
  string,
  Readonly<{ preset: PresetName; document: unknown }>
>;

/** The production composition of `lazurio vault` on real files, as
 * tests/vault-host.test.ts builds it: the root-issued handover under a
 * private root, the hosted Folder it adopted, the declared operator and the
 * custody under XDG_STATE_HOME. */
async function remoteEnvironment(of: keyof typeof withoutVault) {
  const { preset, document } = withoutVault[of];
  const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-line-")));
  const root = join(parent, "machine");
  await mkdir(root, { mode: 0o755 });
  const file = join(root, machineContextPath);
  await mkdir(dirname(file), { recursive: true, mode: 0o755 });
  await writeFile(file, JSON.stringify(document), { mode: 0o644 });
  const folder = join(root, "home", "operator", "Lazurio");
  await mkdir(join(folder, "organizations"), { recursive: true, mode: 0o700 });
  if (preset === "hosted-personal")
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset,
    machine: binding(document),
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  const state = join(parent, "state");
  const host = processVaultHost({
    folder: async () => folder,
    env: {
      HOME: "/home/operator",
      XDG_STATE_HOME: state,
      PATH: "/usr/bin:/bin",
    },
    platform: "linux",
    run: runTool,
    sources: {
      handover: { platform: "linux", root, custodian: uid },
      operator: async () =>
        Object.freeze({
          platform: "linux",
          uid: 1000,
          username: "operator",
          homedir: "/home/operator",
        }),
    },
  });
  return {
    preset,
    document,
    context: cli(host),
    /** The root-issued handover file. */
    handover: file,
    /** Where a personal Environment records the Bitwarden its person
     * connected (`connectionDirectory`). */
    connection: join(state, "lazurio", "vault", "personal"),
    close: () => rm(parent, { recursive: true, force: true }),
  };
}

test.skipIf(!posix || uid === 0)(
  "without a vault in the handover the line says there is none, as lazurio vault status does, and that secrets go where the Operator says",
  async () => {
    const environments = {
      work: await remoteEnvironment("work"),
      public: await remoteEnvironment("public"),
      personal: await remoteEnvironment("personal"),
    };
    try {
      // Issue #470's Environment: a work Environment on a tailnet whose
      // handover names no vault (and that has no 0197 pilot account).
      const work = await vaultAnswer(environments.work.context);
      expect(work.answer).toEqual({
        kind: "vault-status",
        state: "unsupported",
        reason: "no-vault",
      } as Answer);
      expect(work.text).toBe(
        "Not available: this Environment has no vault yet: its Machine handover names none.",
      );
      // A public Organization's Environment: none, on purpose.
      const open = await vaultAnswer(environments.public.context);
      expect(open.answer).toEqual({
        kind: "vault-status",
        state: "unsupported",
        reason: "no-tailnet",
      } as Answer);
      expect(open.text).toStartWith(
        "Not available: this Environment has no vault and gets none:",
      );
      // A personal Environment waiting for its person.
      const waiting = await vaultAnswer(environments.personal.context);
      expect(waiting.answer).toEqual({
        kind: "vault-status",
        state: "needs-connection",
      } as Answer);
      expect(waiting.text).toStartWith("Not connected yet:");
      // None of them hands out a session: the line's "use neither bw nor
      // lazurio vault env".
      for (const answered of [work, open, waiting])
        expect(answered.env).toBe(2);
      for (const [label, environment, answered] of [
        ["work", environments.work, work],
        ["public", environments.public, open],
        ["personal", environments.personal, waiting],
      ] as const)
        for (const locale of ["cs", "en"] as const)
          expectLineFollows(
            label,
            folderOf(environment.preset, environment.document, locale),
            answered.answer,
            locale,
          );
    } finally {
      for (const environment of Object.values(environments))
        await environment.close();
    }
  },
  30_000,
);

test.skipIf(!posix || uid === 0)(
  "unsupported for another reason, an unreadable handover or connection record, proves no absence: the line sends the agent to the status's reason",
  async () => {
    const environments = {
      work: await remoteEnvironment("work"),
      personal: await remoteEnvironment("personal"),
    };
    try {
      // The handover the Folder was adopted from no longer reads: it says
      // nothing about a vault either way.
      await writeFile(environments.work.handover, "{}", { mode: 0o644 });
      const unreadable = await vaultAnswer(environments.work.context);
      expect(unreadable.answer).toEqual({
        kind: "vault-status",
        state: "unsupported",
        reason: "handover-unreadable",
      } as Answer);
      expect(unreadable.text).toBe(
        "Not available: the Machine handover cannot be read.",
      );
      // A personal Environment whose person connected their own Bitwarden,
      // and whose record of it no longer reads: the vault is there.
      await mkdir(environments.personal.connection, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(environments.personal.connection, "connection.json"),
        '{"region":"eu"}',
        { mode: 0o600 },
      );
      const record = await vaultAnswer(environments.personal.context);
      expect(record.answer).toEqual({
        kind: "vault-status",
        state: "unsupported",
        reason: "connection-unreadable",
      } as Answer);
      expect(record.text).toStartWith(
        "Not available: the record of the Bitwarden this personal Environment's user connected cannot be read;",
      );
      for (const answered of [unreadable, record]) {
        // Neither answer says there is no vault, and neither hands out a
        // session.
        expect(answered.text).not.toContain("no vault");
        expect(answered.env).toBe(2);
      }
      for (const [label, environment, answered] of [
        ["handover-unreadable", environments.work, unreadable],
        ["connection-unreadable", environments.personal, record],
      ] as const)
        for (const locale of ["cs", "en"] as const) {
          expectLineFollows(
            label,
            folderOf(environment.preset, environment.document, locale),
            answered.answer,
            locale,
          );
          // The absence names its own two reasons, never this one, and the
          // rule for it is the status's reason.
          const w = words[locale];
          for (const absent of Object.values(w.absent))
            expect(absent).not.toContain(`\`${answered.answer.reason}\``);
          expect(w.other).toContain(
            locale === "cs" ? "včetně důvodu" : "its reason included",
          );
        }
    } finally {
      for (const environment of Object.values(environments))
        await environment.close();
    }
  },
  30_000,
);

test.skipIf(!posix)(
  "with a vault in the handover the line follows lazurio vault status while the vault waits for a person, connects and locks",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "vault-line-")));
    const home = join(parent, "home");
    const vault = await startFakeVault(home);
    try {
      // A work Environment whose handover names its own vault.
      const document = {
        ...organization,
        owner: withoutTeam,
        network: {
          ...organization.network,
          headscale_server_url: "https://headscale.example.lazurio.io",
        },
        entry: handoverEntry("workspace.example.lazurio.io"),
        vault: vaultMember(workAccount, "Example Pracovní workspace"),
      };
      const handover = parseMachineContext(
        Buffer.from(JSON.stringify(document)),
      );
      const zip = zipOf("bw", fakeBw);
      const pin = fakePin(zip);
      const context = cli(
        fakeHost({
          home,
          vault,
          pin,
          download: fakeRelease(pin, zip).fetch,
          context: async () => ownContext(handover, "work"),
        }),
      );
      const follows = (label: string, answer: Answer) => {
        for (const locale of ["cs", "en"] as const)
          expectLineFollows(
            label,
            folderOf("hosted-organization-personal", document, locale),
            answer,
            locale,
          );
      };

      // Not set up yet, then not allowed by the network yet: the vault
      // waits for a person, and no session is handed out.
      const fresh = await vaultAnswer(context);
      expect(fresh.answer).toMatchObject({ state: "not-set-up" });
      expect(fresh.env).toBe(2);
      follows("not set up", fresh.answer);
      const refused = await runVaultCommand(["setup", "--json"], context);
      expect(refused.code).toBe(2);
      const notAllowed = JSON.parse(refused.stdout ?? "") as Answer;
      expect(notAllowed).toMatchObject({ state: "not-allowed" });
      follows("not allowed", notAllowed);

      // The network allows the account: connected, and lazurio vault env
      // hands out the session the line tells agents to start with.
      vault.allow(workAccount);
      expect((await runVaultCommand(["setup"], context)).code).toBe(0);
      const connected = await vaultAnswer(context);
      expect(connected.answer).toMatchObject({ state: "connected" });
      expect(connected.answer.locked).toBeUndefined();
      expect(connected.text).toStartWith("Connected:");
      expect(connected.env).toBe(0);
      follows("connected", connected.answer);

      // The session is no longer the unlocked one (a `bw lock` agents never
      // run): connected and locked, and the line's step, lazurio vault env
      // run again, unlocks it.
      const paths = vaultPaths(
        stateDirectory(home, "vaultwarden.example.lazurio.io", workAccount),
      );
      await rm(join(paths.data, "fake", "session"));
      const locked = JSON.parse(
        (await runVaultCommand(["status", "--json"], context)).stdout ?? "",
      ) as Answer;
      expect(locked).toMatchObject({ state: "connected", locked: true });
      expect((await runVaultCommand(["status"], context)).stdout).toContain(
        "(locked: lazurio vault refresh unlocks it)",
      );
      follows("locked", locked);
      expect((await runVaultCommand(["env"], context)).code).toBe(0);
      const unlocked = JSON.parse(
        (await runVaultCommand(["status", "--json"], context)).stdout ?? "",
      ) as Answer;
      expect(unlocked).toMatchObject({ state: "connected" });
      expect(unlocked.locked).toBeUndefined();
    } finally {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

test("no generated Folder of a Remote Environment claims the vault is signed in or absent but for no-vault and no-tailnet, in either language", () => {
  for (const [name, machine] of Object.entries(bindings)) {
    // A Team named without an assignment derives none; it is a Team's here.
    const preset = derivePreset(machine) ?? "hosted-organization-team";
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset,
        machine,
        profile: presetProfile(preset, "linux", { locale }),
        tools: ["bitwarden"],
      });
      for (const path of ["AGENTS.md", "manual/this-machine.md"] as const) {
        const lines = toolLines(outputs[path]);
        expect([name, locale, path, lines.length]).toEqual([
          name,
          locale,
          path,
          1,
        ]);
        const line = lines[0] ?? "";
        expect([
          name,
          locale,
          path,
          line.includes(words[locale].source),
        ]).toEqual([name, locale, path, true]);
        expect([
          name,
          locale,
          path,
          line.includes(words[locale].claimed),
        ]).toEqual([name, locale, path, false]);
        // No vault only for `no-vault` and `no-tailnet`, nowhere else.
        expect([
          name,
          locale,
          path,
          mentions(line),
          line.includes(words[locale].absent["no-vault"]),
          line.includes(words[locale].absent["no-tailnet"]),
          line.includes(words[locale].other),
        ]).toEqual([name, locale, path, 2, true, true, true]);
      }
    }
  }
});
