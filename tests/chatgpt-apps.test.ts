import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatgptAppsCheck } from "../src/doctor/doctor";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import type { MachineBinding } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { readFolderState } from "../src/folder/read-state";
import { parseFolderPreferences } from "../src/folder/state";
import {
  recordOrganizationSettings,
  updateChatgptApps,
  updateTools,
} from "../src/folder/update-profile";
import {
  chatgptAppsStatus,
  setChatgptApps,
} from "../src/integrations/chatgpt-apps";
import { applyOrganizationSettings } from "../src/organization-settings/apply";
import {
  isSettingKey,
  parseSettingsAnswer,
  reportBody,
  type SettingsReport,
} from "../src/organization-settings/contract";
import { chatgptAppsPolicyOf } from "../src/organization-settings/governance";
import { createSettingsPoller } from "../src/organization-settings/poller";
import { memoryStateStore } from "../src/organization-settings/state";
import { bindings } from "./fixtures/machine-bindings";

// "Aplikace z ChatGPT" (decision F42's addendum of 2026-10-27): the
// Organization's setting `integrations.chatgpt_apps.allowed`, whose absence is
// off; the person's own choice where no Organization governs; the Folder's
// text in both languages; and the doctor finding over Codex's facts. The
// Codex configuration itself is `codex-apps.test.ts`.

const os = executionOs(process.platform);

test("an Organization that says nothing does not allow ChatGPT's apps; the person decides elsewhere", () => {
  for (const preset of [
    "hosted-organization-personal",
    "hosted-organization-team",
    "hosted-organization-steward",
  ] as const) {
    expect(chatgptAppsPolicyOf(preset, {}, false)).toEqual({
      allowed: false,
      source: "organization",
      set: false,
    });
    // The person's own choice does not count on an Organization's
    // Environment.
    expect(chatgptAppsPolicyOf(preset, {}, true).allowed).toBe(false);
    for (const allowed of [false, true])
      expect(
        chatgptAppsPolicyOf(
          preset,
          { integrations: { chatgpt_apps: { allowed } } },
          false,
        ),
      ).toEqual({ allowed, source: "organization", set: true });
  }
  for (const preset of ["hosted-personal", "local"] as const) {
    expect(chatgptAppsPolicyOf(preset, {}, false)).toEqual({
      allowed: false,
      source: "person",
      set: false,
    });
    expect(chatgptAppsPolicyOf(preset, {}, true)).toEqual({
      allowed: true,
      source: "person",
      set: true,
    });
  }
});

test("the Dashboard's answer and the report carry the snake_case key", () => {
  const answer = parseSettingsAnswer({
    schema_version: "lazurio.environment-settings.v1",
    organization: { github_org_id: 7, login: "Example" },
    version: "a".repeat(40),
    settings: { integrations: { chatgpt_apps: { allowed: true } } },
  });
  expect(answer?.values).toEqual({
    integrations: { chatgpt_apps: { allowed: true } },
  });
  expect(answer?.unsupported).toEqual([]);
  expect(isSettingKey("integrations.chatgpt_apps.allowed")).toBe(true);
  // Lowercase segments only, as every other key.
  for (const key of ["integrations.chatgptApps.allowed", "a.b-c", "a."])
    expect(isSettingKey(key)).toBe(false);
  expect(
    JSON.parse(
      reportBody({
        version: "a".repeat(40),
        appliedAt: "2026-10-27T12:00:00Z",
        lastError: null,
        items: [
          {
            key: "integrations.chatgpt_apps.allowed",
            outcome: "failed",
            detail: "codex-config-shape",
          },
        ],
        platformVersion: "0.1.15",
      }),
    ).items,
  ).toEqual([
    {
      key: "integrations.chatgpt_apps.allowed",
      outcome: "failed",
      detail: "codex-config-shape",
    },
  ]);
  // A known key that breaks the contract makes the whole answer unusable.
  expect(
    parseSettingsAnswer({
      schema_version: "lazurio.environment-settings.v1",
      organization: { github_org_id: 7, login: "Example" },
      version: "a".repeat(40),
      settings: { integrations: { chatgpt_apps: { allowed: "yes" } } },
    }),
  ).toBeNull();
});

/** AGENTS.md and the manual's working-here.md. */
function lines(composition: Record<string, unknown>) {
  const outputs = renderOutputs(composition);
  return {
    agents: outputs["AGENTS.md"],
    manual: outputs["manual/working-here.md"],
  };
}

test("the Folder says whether ChatGPT's apps are a way to an app, and who decides, in both languages", () => {
  const organization = (locale: "cs" | "en", settings: unknown) =>
    lines({
      preset: "hosted-organization-personal",
      machine: bindings.organizationEntry,
      profile: presetProfile("hosted-organization-personal", "linux", {
        locale,
      }),
      ...(settings === undefined ? {} : { organizationSettings: settings }),
    });
  const personal = (locale: "cs" | "en", allowed: boolean) =>
    lines({
      preset: "hosted-personal",
      machine: bindings.personalEntry,
      profile: presetProfile("hosted-personal", "linux", { locale }),
      ...(allowed ? { chatgptAppsAllowed: true } : {}),
    });
  const off = {
    cs: "Aplikace z ChatGPT tu Organizace nepovoluje: aplikace, pluginy a konektory účtu ChatGPT (v Codexu `codex_apps`, správa a návrhy pluginů) nejsou cestou k Integraci. Nepoužívej je, pluginy nehledej, nenavrhuj ani nepřipojuj",
    en: "The Organization does not allow ChatGPT apps here: the ChatGPT account's apps, plugins and connectors (Codex's `codex_apps`, plugin management and suggestions) are no way to an Integration. Do not use them, and never search, suggest or connect a plugin",
  };
  for (const locale of ["cs", "en"] as const) {
    // Unset and `false` say the same: not allowed.
    for (const settings of [
      undefined,
      { integrations: { chatgpt_apps: { allowed: false } } },
    ]) {
      const { agents, manual } = organization(locale, settings);
      expect(agents).toContain(off[locale]);
      expect(manual).toContain(off[locale]);
    }
    const allowed = organization(locale, {
      integrations: { chatgpt_apps: { allowed: true } },
    });
    expect(allowed.agents).toContain(
      locale === "cs"
        ? "Aplikace z ChatGPT tu Organizace povoluje: aplikaci, kterou katalog Integrací nemá"
        : "The Organization allows ChatGPT apps here: an app the catalog of Integrations does not have",
    );
    expect(allowed.agents).not.toContain(off[locale]);
    expect(personal(locale, false).agents).toContain(
      locale === "cs"
        ? "Aplikace z ChatGPT jsou tu vypnuté: aplikace, pluginy a konektory účtu ChatGPT"
        : "ChatGPT apps are off here: the ChatGPT account's apps, plugins and connectors",
    );
    expect(personal(locale, true).agents).toContain(
      locale === "cs"
        ? "Aplikace z ChatGPT tu uživatel zapnul"
        : "The user turned ChatGPT apps on here",
    );
    // The exact order, and the two working rules, everywhere.
    const { agents } = personal(locale, false);
    expect(agents).toContain(
      locale === "cs"
        ? "v tomhle pořadí: nástroj z Nastavení → Nástroje (`gh`, `wacli`, …), potom Executor"
        : "in this order: the tool from Settings → Tools (`gh`, `wacli`, …), then Executor",
    );
    expect(agents).not.toContain(
      locale === "cs" ? "nástroj aplikace" : "the app's tool",
    );
    expect(agents).toContain(
      locale === "cs"
        ? "Výsledky technických kontrol (`lazurio doctor`, `doctor:task`, nesoulad URL repozitáře"
        : "Do not show the user the results of technical checks (`lazurio doctor`, `doctor:task`, a repository URL mismatch",
    );
    expect(agents).toContain(
      locale === "cs"
        ? "„Zapamatuj si“ nikdy nezapisuj do vygenerovaných souborů Folderu (`AGENTS.md`, `manual/`, skilly)"
        : "Never write a “remember this” into the Folder's generated files (`AGENTS.md`, `manual/`, the skills)",
    );
    expect(agents).toContain(
      "(Codex `$CODEX_HOME/AGENTS.md`, Claude Code `~/.claude/CLAUDE.md`)",
    );
  }
  // An Organization decides on its Environments: the person's choice never
  // renders there, and it has one representation.
  expect(() =>
    renderOutputs({
      preset: "hosted-organization-personal",
      machine: bindings.organizationEntry,
      profile: presetProfile("hosted-organization-personal", "linux"),
      chatgptAppsAllowed: true,
    }),
  ).toThrow();
  expect(() =>
    renderOutputs({
      preset: "hosted-personal",
      machine: bindings.personalEntry,
      profile: presetProfile("hosted-personal", "linux"),
      chatgptAppsAllowed: false,
    }),
  ).toThrow();
});

async function withFolder(
  preset: PresetName,
  machine: MachineBinding,
  run: (folder: string) => Promise<void>,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "folder-chatgpt-apps-")),
  );
  const folder = join(parent, "Lazurio");
  try {
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o700 });
    if (preset === "hosted-personal")
      await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    await initializeHandoverFolder(folder, {
      preset,
      machine,
      profile: presetProfile(preset, os),
    });
    await run(folder);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const preferencesOf = async (folder: string) =>
  JSON.parse(await readFile(join(folder, ".lazurio/preferences.json"), "utf8"));
const agentsOf = (folder: string) =>
  readFile(join(folder, "AGENTS.md"), "utf8");

test.skipIf(process.platform === "win32")(
  "the person's choice is recorded in the Folder, carried by other changes and refused where an Organization governs",
  async () => {
    await withFolder("hosted-personal", bindings.personal, async (folder) => {
      expect((await preferencesOf(folder)).chatgptAppsAllowed).toBeUndefined();
      expect(await agentsOf(folder)).toContain("ChatGPT apps are off here");
      expect(await updateChatgptApps(folder, 1, true)).toEqual({
        kind: "updated",
        revision: 2,
      });
      expect((await preferencesOf(folder)).chatgptAppsAllowed).toBe(true);
      expect(await agentsOf(folder)).toContain(
        "The user turned ChatGPT apps on here",
      );
      // The same choice changes nothing; a tools change carries it.
      expect(await updateChatgptApps(folder, 2, true)).toEqual({
        kind: "unchanged",
      });
      expect(await updateTools(folder, 2, ["wacli"])).toEqual({
        kind: "updated",
        revision: 3,
      });
      expect((await preferencesOf(folder)).chatgptAppsAllowed).toBe(true);
      // Off again: the key goes.
      expect(await updateChatgptApps(folder, 3, false)).toEqual({
        kind: "updated",
        revision: 4,
      });
      const recorded = await preferencesOf(folder);
      expect(Object.hasOwn(recorded, "chatgptAppsAllowed")).toBe(false);
      expect(await agentsOf(folder)).toContain("ChatGPT apps are off here");
      // Without Codex kept here, the status reads only the Folder.
      expect(await chatgptAppsStatus(folder, null)).toEqual({
        kind: "chatgpt-apps",
        policy: { allowed: false, source: "person", set: false },
        codex: null,
      });
      const set = await setChatgptApps(folder, true, null);
      expect(set.kind).toBe("updated");
    });
    await withFolder(
      "hosted-organization-personal",
      bindings.organization,
      async (folder) => {
        expect(await updateChatgptApps(folder, 1, true)).toEqual({
          kind: "blocked",
          reason: "organization-governed",
          setting: "integrations.chatgpt_apps.allowed",
        });
        expect(await setChatgptApps(folder, true, null)).toEqual({
          kind: "blocked",
          reason: "organization-governed",
        });
        // The Organization allows them: recorded and rendered.
        await recordOrganizationSettings(folder, {
          integrations: { chatgpt_apps: { allowed: true } },
        });
        expect(await agentsOf(folder)).toContain(
          "The Organization allows ChatGPT apps here",
        );
        const state = await readFolderState(join(folder, ".lazurio"));
        expect(state.preferences.organizationSettings).toEqual({
          integrations: { chatgpt_apps: { allowed: true } },
        });
      },
    );
  },
);

test.skipIf(process.platform === "win32")(
  "applying the Organization's settings converges Codex and reports how it went",
  async () => {
    await withFolder(
      "hosted-organization-personal",
      bindings.organization,
      async (folder) => {
        const calls: string[] = [];
        const applied = await applyOrganizationSettings(
          folder,
          {
            values: { integrations: { chatgpt_apps: { allowed: false } } },
            unsupported: [],
          },
          {
            chatgptApps: async () => {
              calls.push("converge");
              return { outcome: "failed", detail: "codex-config-shape" };
            },
          },
        );
        expect(calls).toEqual(["converge"]);
        expect(applied.items).toEqual([
          {
            key: "integrations.chatgpt_apps.allowed",
            outcome: "failed",
            detail: "codex-config-shape",
          },
        ]);
        // Not governed any more (absent is off): Codex follows all the same,
        // and the key governed before is said once more.
        const lifted = await applyOrganizationSettings(
          folder,
          { values: {}, unsupported: [] },
          {
            chatgptApps: async () => {
              calls.push("converge");
              return { outcome: "applied", detail: null };
            },
          },
        );
        expect(calls).toEqual(["converge", "converge"]);
        expect(lifted.items).toEqual([
          {
            key: "integrations.chatgpt_apps.allowed",
            outcome: "applied",
            detail: null,
          },
        ]);
      },
    );
  },
);

test("doctor says where ChatGPT's apps are not allowed and Codex still has them", () => {
  const work = parseFolderPreferences({
    schemaVersion: 2,
    revision: 1,
    preset: {
      name: "hosted-organization-personal",
      version: 1,
      selection: "derived",
    },
    machine: bindings.organization,
    profile: presetProfile("hosted-organization-personal", "linux"),
    customInstructions: "",
  });
  const allowed = parseFolderPreferences({
    ...work,
    organizationSettings: { integrations: { chatgpt_apps: { allowed: true } } },
  });
  const outcome = (
    preferences: typeof work | null,
    facts: Parameters<typeof chatgptAppsCheck>[1],
  ) => {
    const check = chatgptAppsCheck(preferences, facts);
    return [check.outcome, check.reason ?? null];
  };
  expect(outcome(work, { state: "on", suggestions: "off" })).toEqual([
    "warn",
    "chatgpt-apps-on",
  ]);
  expect(
    outcome(work, {
      state: "off",
      by: "lazurio",
      exceptions: [],
      suggestions: "off",
    }),
  ).toEqual(["ok", null]);
  // Apps off, but Codex still suggests plugins to install.
  expect(
    outcome(work, {
      state: "off",
      by: "person",
      exceptions: [],
      suggestions: "on",
    }),
  ).toEqual(["warn", "chatgpt-suggestions-on"]);
  expect(
    outcome(work, {
      state: "off",
      by: "person",
      exceptions: ["app_a"],
      suggestions: "off",
    }),
  ).toEqual(["warn", "chatgpt-apps-exception"]);
  expect(outcome(work, { state: "unreadable" })).toEqual([
    "warn",
    "codex-config-unreadable",
  ]);
  expect(outcome(work, { state: "absent" })).toEqual([
    "skipped",
    "codex-absent",
  ]);
  expect(outcome(allowed, { state: "on", suggestions: "on" })).toEqual([
    "ok",
    null,
  ]);
  expect(outcome(null, null)).toEqual(["skipped", "not-hosted"]);
  expect(
    chatgptAppsCheck(work, { state: "on", suggestions: "on" }).context,
  ).toEqual({
    chatgptApps: "not-allowed",
    decidedBy: "organization",
    codexApps: "on",
    codexSuggestions: "on",
  });
});

const chatgptKey = "integrations.chatgpt_apps.allowed";

test.skipIf(process.platform === "win32")(
  "a Dashboard that never delivered the key never gets it in a report, though Codex still follows",
  async () => {
    await withFolder(
      "hosted-organization-personal",
      bindings.organization,
      async (folder) => {
        let converged = 0;
        const chatgptApps = async () => {
          converged += 1;
          return { outcome: "applied" as const, detail: null };
        };
        // An older Dashboard: only Composio, or nothing at all.
        for (const values of [
          { integrations: { composio: { allowed: false } } },
          {},
        ]) {
          const applied = await applyOrganizationSettings(
            folder,
            { values, unsupported: [] },
            { chatgptApps },
          );
          expect(applied.items.map((item) => item.key)).not.toContain(
            chatgptKey,
          );
        }
        expect(converged).toBe(2);
      },
    );
  },
);

test.skipIf(process.platform === "win32")(
  "after a newer Dashboard delivered the key, an older one that refuses it gets the report without it",
  async () => {
    await withFolder(
      "hosted-organization-personal",
      bindings.organization,
      async (folder) => {
        const v1 = "1".repeat(40);
        const v2 = "2".repeat(40);
        const answers = [
          { integrations: { chatgpt_apps: { allowed: true } } },
          { integrations: { composio: { allowed: true } } },
        ];
        const sent: SettingsReport[] = [];
        let asked = 0;
        const settingsPoller = createSettingsPoller({
          folder,
          store: memoryStateStore(),
          platformVersion: "0.1.15",
          startupDelayMs: 0,
          nudgeGapMs: 0,
          journal: () => {},
          apply: (target, delivered) =>
            applyOrganizationSettings(target, delivered, {
              chatgptApps: async () => ({ outcome: "applied", detail: null }),
            }),
          source: {
            kind: "dashboard",
            async read() {
              const index = Math.min(asked, answers.length - 1);
              asked += 1;
              return {
                kind: "settings",
                settings: {
                  organization: { githubOrgId: 7, login: "Example" },
                  version: index === 0 ? v1 : v2,
                  values: answers[index] ?? {},
                  unsupported: [],
                },
              };
            },
            // The second Dashboard does not know the key: a report naming
            // it is refused whole.
            async report(report) {
              sent.push(report);
              return asked > 1 &&
                report.items.some((item) => item.key === chatgptKey)
                ? { kind: "refused", status: 400, detail: "invalid_report" }
                : { kind: "accepted" };
            },
          },
        });
        await settingsPoller.nudge(5_000);
        await settingsPoller.idle();
        expect(sent.at(-1)?.items).toEqual([
          { key: chatgptKey, outcome: "applied", detail: null },
        ]);
        await settingsPoller.nudge(5_000);
        await settingsPoller.idle();
        // The lifted key is named once, refused, and sent again without it.
        expect(sent.slice(1).map((report) => report.items)).toEqual([
          [
            {
              key: "integrations.composio.allowed",
              outcome: "applied",
              detail: null,
            },
            { key: chatgptKey, outcome: "applied", detail: null },
          ],
          [
            {
              key: "integrations.composio.allowed",
              outcome: "applied",
              detail: null,
            },
          ],
        ]);
        await settingsPoller.stop();
      },
    );
  },
);
