import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { inspectProfileChange } from "../src/folder/inspect-profile-change";
import { inspectToolsChange } from "../src/folder/inspect-tools-change";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { refreshFolder } from "../src/folder/update-profile";
import { startLaunchpad } from "../src/launchpad/server";
import { toolSelection } from "../src/tools/catalog";
import { bindings } from "./fixtures/machine-bindings";

// A hosted Folder as folder-init adopts it, plus a Launchpad session on it.
async function hostedSession(
  preset: PresetName,
  machine: (typeof bindings)[keyof typeof bindings],
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-hosted-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const profile = presetProfile(preset, executionOs(process.platform));
  await initializeHandoverFolder(folder, { preset, machine, profile });
  const app = await startLaunchpad(folder);
  const url = new URL(app.url);
  const call = (path: string, body: unknown) =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
      },
      body: JSON.stringify(body),
    });
  return {
    folder,
    profile,
    call,
    async close() {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")(
  "Launchpad tools API previews and records the enabled tools over the same core",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-tools-")),
    );
    const folder = join(parent, "Lazurio");
    const profile = {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    };
    await initializeFolder(folder, profile);
    const app = await startLaunchpad(folder);
    const url = new URL(app.url);
    const call = (path: string, body: unknown, override = {}) =>
      fetch(new URL(path, url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: url.origin,
          Authorization: `Bearer ${url.hash.slice(1)}`,
          ...override,
        },
        body: JSON.stringify(body),
      });
    const enabled = async () =>
      (
        (await (await call("/api/profile", {})).json()) as {
          revision: number;
          tools: { name: string; enabled: boolean }[];
        }
      ).tools
        .filter((tool) => tool.enabled)
        .map((tool) => tool.name);
    try {
      const before = await readFile(join(folder, "AGENTS.md"), "utf8");
      const preferences = await readFile(
        join(folder, ".lazurio", "preferences.json"),
        "utf8",
      );
      for (const path of ["/api/tools/preview", "/api/tools/update"]) {
        expect(
          (
            await call(
              path,
              { expectedRevision: 1, tools: ["composio"] },
              { Authorization: "" },
            )
          ).status,
        ).toBe(403);
        // Exact keys, a positive revision and a valid selection.
        expect(
          (await call(path, { expectedRevision: 0, tools: [] })).status,
        ).toBe(400);
        for (const body of [
          { tools: ["composio"] },
          { expectedRevision: 1 },
          { expectedRevision: 1, tools: ["composio"], folder: parent },
          { expectedRevision: 1, tools: ["gh"] },
          { expectedRevision: 1, tools: ["t3"] },
          { expectedRevision: 1, tools: ["wacli", "composio"] },
          { expectedRevision: 1, tools: "composio" },
        ]) {
          const refused = await call(path, body);
          expect(refused.status).toBe(400);
          expect(await refused.json()).toEqual({
            error: "operation-failed",
            recoveryMayBeRequired: true,
          });
        }
        const stale = await call(path, {
          expectedRevision: 2,
          tools: ["composio"],
        });
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({
          kind: "blocked",
          reason: "stale-revision",
        });
        const same = await call(path, { expectedRevision: 1, tools: [] });
        expect(same.status).toBe(200);
        expect(await same.json()).toEqual({ kind: "unchanged" });
      }
      const preview = await call("/api/tools/preview", {
        expectedRevision: 1,
        tools: ["composio"],
      });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toEqual(
        JSON.parse(
          JSON.stringify(await inspectToolsChange(folder, 1, ["composio"])),
        ),
      );
      // Nothing above wrote anything.
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(before);
      expect(
        await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
      ).toBe(preferences);
      expect(await enabled()).toEqual(["gh"]);

      const updated = await call("/api/tools/update", {
        expectedRevision: 1,
        tools: ["composio"],
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toEqual({ kind: "updated", revision: 2 });
      expect(await enabled()).toEqual(["gh", "composio"]);
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        "- `composio` (enabled): ",
      );
      // A profile change through the panel keeps the tools.
      expect(
        await (
          await call("/api/update", {
            expectedRevision: 2,
            profile: { ...profile, detail: "technical" },
          })
        ).json(),
      ).toEqual({ kind: "updated", revision: 3 });
      expect(await enabled()).toEqual(["gh", "composio"]);
      await writeFile(join(folder, "AGENTS.md"), "manual work");
      const drift = await call("/api/tools/update", {
        expectedRevision: 3,
        tools: [],
      });
      expect(drift.status).toBe(409);
      expect(await drift.json()).toEqual({
        kind: "blocked",
        reason: "drift",
        path: "AGENTS.md",
      });
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
        "manual work",
      );
    } finally {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Launchpad profile API shares core and denies cross-origin or uncredentialed changes",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-api-")),
    );
    const folder = join(parent, "Lazurio");
    const profile = {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    };
    await initializeFolder(folder, profile);
    const app = await startLaunchpad(folder);
    const url = new URL(app.url);
    const headers = {
      "Content-Type": "application/json",
      Origin: url.origin,
      Authorization: `Bearer ${url.hash.slice(1)}`,
    };
    const call = (path: string, body: unknown, override = {}) =>
      fetch(new URL(path, url), {
        method: "POST",
        headers: { ...headers, ...override },
        body: JSON.stringify(body),
      });
    try {
      const before = await readFile(join(folder, "AGENTS.md"));
      expect(
        (await call("/api/profile", {}, { Authorization: "" })).status,
      ).toBe(403);
      expect(
        (await call("/api/update", {}, { Origin: "https://untrusted.example" }))
          .status,
      ).toBe(403);
      expect(
        (await call("/api/update", {}, { Host: "untrusted.example" })).status,
      ).toBe(403);
      expect(await readFile(join(folder, "AGENTS.md"))).toEqual(before);
      expect(await (await call("/api/profile", {})).json()).toEqual({
        revision: 1,
        preset: { name: "local", version: 1, selection: "derived" },
        allowedPresets: ["local"],
        machine: null,
        profile,
        tools: [
          { name: "gh", tier: "required", setup: "launchpad", enabled: true },
          {
            name: "composio",
            tier: "recommended",
            setup: "launchpad",
            enabled: false,
          },
          {
            name: "bitwarden",
            tier: "recommended",
            setup: "launchpad",
            enabled: false,
          },
          {
            name: "wacli",
            tier: "optional",
            setup: "launchpad",
            enabled: false,
          },
          { name: "gogcli", tier: "optional", setup: "agent", enabled: false },
          { name: "neon", tier: "optional", setup: "agent", enabled: false },
        ],
      });
      const candidate = {
        expectedRevision: 1,
        profile: { ...profile, locale: "cs" },
      };
      expect(await (await call("/api/preview", candidate)).json()).toEqual(
        await inspectProfileChange(folder, 1, { profile: candidate.profile }),
      );
      expect(await readFile(join(folder, "AGENTS.md"))).toEqual(before);
      expect(
        (await call("/api/update", { ...candidate, folder: parent })).status,
      ).toBe(400);
      expect(await (await call("/api/update", candidate)).json()).toEqual({
        kind: "updated",
        revision: 2,
      });
      expect((await call("/api/update", candidate)).status).toBe(409);
      await writeFile(join(folder, "AGENTS.md"), "manual work");
      expect(
        (await call("/api/update", { expectedRevision: 2, profile })).status,
      ).toBe(409);
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
        "manual work",
      );
      const html = await (await fetch(url.origin)).text();
      expect(html).toContain("Lazurio Launchpad");
      expect(html).toContain("This Environment");
      expect(html).not.toContain('name="access"');
      expect(html).not.toContain(url.hash.slice(1));
      // The catalog home is the page; the developer form is gone from it.
      expect(html).toContain('id="catalog-body"');
      expect(html).not.toContain('id="application"');
      expect(html).not.toContain("Development fixture only");
      // Every settings and catalog route serves the same page and nothing
      // else does: a path outside them needs the credential like any other
      // request.
      for (const route of [
        "/settings",
        "/settings/general",
        "/settings/tools",
        "/o/alpha",
        "/o/alpha/web",
        "/o/Alpha%20Co/web",
      ])
        expect(await (await fetch(new URL(route, url.origin))).text()).toBe(
          html,
        );
      for (const route of ["/settings/unknown", "/o", "/o/alpha/web/extra"])
        expect((await fetch(new URL(route, url.origin))).status).toBe(403);
    } finally {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Launchpad shows the immutable handover, changes preset and axes through the same flow, and refuses a disallowed preset",
  async () => {
    const session = await hostedSession(
      "hosted-organization-personal",
      bindings.organization,
    );
    try {
      const shown = await (await session.call("/api/profile", {})).json();
      expect(shown).toEqual({
        revision: 1,
        preset: {
          name: "hosted-organization-personal",
          version: 1,
          selection: "derived",
        },
        allowedPresets: [
          "hosted-organization-personal",
          "hosted-organization-team",
          "hosted-organization-steward",
        ],
        machine: bindings.organization,
        profile: session.profile,
        tools: toolSelection([]),
      });
      const change = {
        expectedRevision: 1,
        preset: "hosted-organization-team",
        profile: { ...session.profile, locale: "cs", detail: "technical" },
      };
      expect(await (await session.call("/api/preview", change)).json()).toEqual(
        await inspectProfileChange(session.folder, 1, {
          preset: change.preset,
          profile: change.profile,
        }),
      );
      const refused = await session.call("/api/update", {
        ...change,
        preset: "hosted-personal",
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        kind: "blocked",
        reason: "preset-not-allowed",
      });
      expect(
        (
          await session.call("/api/update", {
            ...change,
            machine: null,
          })
        ).status,
      ).toBe(400);
      expect(await (await session.call("/api/update", change)).json()).toEqual({
        kind: "updated",
        revision: 2,
      });
      const after = await (await session.call("/api/profile", {})).json();
      expect(after.preset).toEqual({
        name: "hosted-organization-team",
        version: 1,
        selection: "explicit",
      });
      expect(after.machine).toEqual(bindings.organization);
      expect(after.profile.locale).toBe("cs");
      expect(
        await readFile(join(session.folder, "AGENTS.md"), "utf8"),
      ).toContain("hosted-organization-team");
      // On the shared Team Environment a change that adds a tool carries the
      // warning that sign-ins are shared, in the preview and in the update; a
      // change that adds nothing does not.
      const adding = { expectedRevision: 2, tools: ["composio"] };
      expect(
        (await (await session.call("/api/tools/preview", adding)).json())
          .warning,
      ).toBe("shared-environment-sign-ins");
      expect(
        await (await session.call("/api/tools/update", adding)).json(),
      ).toEqual({
        kind: "updated",
        revision: 3,
        warning: "shared-environment-sign-ins",
      });
      expect(
        await (
          await session.call("/api/tools/update", {
            expectedRevision: 3,
            tools: [],
          })
        ).json(),
      ).toEqual({ kind: "updated", revision: 4 });
    } finally {
      await session.close();
    }
  },
);

// Issue #107: on a work VM whose handover states `owner.assignment`, the
// Launchpad offers only the derived preset, plus the recorded one, which
// stays valid; any other is refused by the same change use case.
test.skipIf(process.platform === "win32")(
  "the Launchpad offers the preset the stated assignment derives and keeps the recorded one",
  async () => {
    for (const [machine, derived] of [
      [bindings.assignedOperator, "hosted-organization-personal"],
      [bindings.assignedTeam, "hosted-organization-team"],
      [bindings.automated, "hosted-organization-steward"],
    ] as const) {
      const session = await hostedSession(derived, machine);
      try {
        const shown = await (await session.call("/api/profile", {})).json();
        expect(shown.allowedPresets).toEqual([derived]);
      } finally {
        await session.close();
      }
    }
    // A Folder that recorded the Steward preset on a work VM without
    // assignment, whose handover now states one operator.
    const session = await hostedSession(
      "hosted-organization-steward",
      bindings.team,
    );
    try {
      expect(
        await refreshFolder(session.folder, bindings.assignedOperator),
      ).toEqual({ kind: "refreshed", revision: 2 });
      const shown = await (await session.call("/api/profile", {})).json();
      expect(shown.preset).toEqual({
        name: "hosted-organization-steward",
        version: 1,
        selection: "explicit",
      });
      expect(shown.allowedPresets).toEqual([
        "hosted-organization-personal",
        "hosted-organization-steward",
      ]);
      const refused = await session.call("/api/update", {
        expectedRevision: 2,
        preset: "hosted-organization-team",
        profile: session.profile,
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        kind: "blocked",
        reason: "preset-not-allowed",
      });
      expect(
        await (
          await session.call("/api/update", {
            expectedRevision: 2,
            preset: "hosted-organization-personal",
            profile: session.profile,
          })
        ).json(),
      ).toEqual({ kind: "updated", revision: 3 });
      const after = await (await session.call("/api/profile", {})).json();
      expect(after.preset).toEqual({
        name: "hosted-organization-personal",
        version: 1,
        selection: "derived",
      });
      expect(after.allowedPresets).toEqual(["hosted-organization-personal"]);
    } finally {
      await session.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the profile API shows assignment and relationships exactly as recorded",
  async () => {
    const session = await hostedSession(
      "hosted-organization-personal",
      bindings.related,
    );
    try {
      const shown = await (await session.call("/api/profile", {})).json();
      expect(shown.machine).toEqual(
        JSON.parse(JSON.stringify(bindings.related)),
      );
      expect(shown.machine.relationships.peers).toHaveLength(3);
    } finally {
      await session.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "an Organization preset is refused on a personal VM handover",
  async () => {
    const session = await hostedSession("hosted-personal", bindings.personal);
    try {
      const shown = await (await session.call("/api/profile", {})).json();
      expect(shown.allowedPresets).toEqual(["hosted-personal"]);
      expect(shown.machine.owner).toEqual(bindings.personal.owner);
      for (const preset of [
        "hosted-organization-personal",
        "hosted-organization-team",
        "local",
      ]) {
        const refused = await session.call("/api/update", {
          expectedRevision: 1,
          preset,
          profile: session.profile,
        });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({
          kind: "blocked",
          reason: "preset-not-allowed",
        });
      }
      expect(
        (
          await session.call("/api/update", {
            expectedRevision: 1,
            preset: "hosted-team",
            profile: session.profile,
          })
        ).status,
      ).toBe(400);
      expect(
        await (
          await session.call("/api/update", {
            expectedRevision: 1,
            profile: { ...session.profile, coordination: "coordinator" },
          })
        ).json(),
      ).toEqual({ kind: "updated", revision: 2 });
    } finally {
      await session.close();
    }
  },
);
