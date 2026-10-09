import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import type { MachineBinding } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import {
  recordOrganizationSettings,
  updateTools,
} from "../src/folder/update-profile";
import { integrationsCatalog } from "../src/integrations/catalog";
import { readIntegrations } from "../src/integrations/read";
import { runToolsCommand } from "../src/tools/cli";
import { toolsEnvironmentOf, toolsOverview } from "../src/tools/overview";
import {
  composioCalls,
  integrationsWorld,
} from "./fixtures/integrations-world";
import { bindings } from "./fixtures/machine-bindings";

// Decision F45 on the surfaces: what the Organization's recorded settings
// say about Composio is what the Integrace page, Settings → Tools and
// `lazurio tools` act on. Not allowed: no Composio path, agents do not use
// it and its switch does not change. Allowed or not governed: today's
// behaviour. A personal Environment decides alone.

const os = executionOs(process.platform);
const forbidden = { integrations: { composio: { allowed: false } } } as const;
const allowed = { integrations: { composio: { allowed: true } } } as const;
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0))
    await rm(parent, { recursive: true, force: true });
});

async function environment(
  preset: PresetName,
  machine: MachineBinding,
  settings: unknown,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "organization-settings-surfaces-")),
  );
  parents.push(parent);
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  if (preset === "hosted-personal")
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, os),
  });
  await updateTools(folder, 1, ["composio"]);
  if (settings !== null) await recordOrganizationSettings(folder, settings);
  const world = await integrationsWorld(parent);
  const tools = toolsEnvironmentOf(
    { PATH: world.path, HOME: world.home },
    process.platform,
  );
  return { folder, world, tools };
}

// An app only Composio connects: neither direct nor by a tool.
const composioOnly = integrationsCatalog.apps.find(
  (app) =>
    app.composio !== undefined &&
    app.direct === undefined &&
    app.tool === undefined,
);

test.skipIf(process.platform === "win32")(
  "Integrace: where the Organization does not allow Composio, no app goes through it",
  async () => {
    const { folder, world, tools } = await environment(
      "hosted-organization-personal",
      bindings.organization,
      forbidden,
    );
    try {
      const overview = await readIntegrations({
        folder,
        tools,
        executor: world.executorHost(),
      });
      expect(overview.composio).toEqual({
        allowed: false,
        source: "organization",
        ready: false,
      });
      expect(overview.sources.composio).toBe("not-allowed");
      expect(
        overview.apps.filter((app) => app.path.path === "composio"),
      ).toEqual([]);
      if (composioOnly === undefined)
        throw new Error("The catalog has an app only Composio connects");
      expect(
        overview.apps.find((app) => app.id === composioOnly.id)?.path,
      ).toEqual({ path: null, missing: "composio", action: "ask-admin" });
      // Composio's accounts are not even asked for.
      expect(
        (await composioCalls(world.home)).filter(
          (call) => call[0] === "connections",
        ),
      ).toEqual([]);
    } finally {
      await world.executor.stop();
    }
  },
);

for (const [name, settings, source] of [
  ["allowed by the Organization", allowed, "organization"],
  ["not governed", null, "environment"],
] as const)
  test.skipIf(process.platform === "win32")(
    `Integrace: Composio ${name} works as it does today`,
    async () => {
      const { folder, world, tools } = await environment(
        "hosted-organization-personal",
        bindings.organization,
        settings,
      );
      try {
        const overview = await readIntegrations({
          folder,
          tools,
          executor: world.executorHost(),
        });
        expect(overview.composio).toEqual({
          allowed: true,
          source,
          ready: true,
        });
        if (composioOnly === undefined)
          throw new Error("The catalog has an app only Composio connects");
        expect(
          overview.apps.find((app) => app.id === composioOnly.id)?.path,
        ).toEqual({ path: "composio", signIn: false });
      } finally {
        await world.executor.stop();
      }
    },
  );

test.skipIf(process.platform === "win32")(
  "Settings → Tools: the tool agents do not use, what the Organization says and the person's kept choice",
  async () => {
    const { folder, world, tools } = await environment(
      "hosted-organization-personal",
      bindings.organization,
      forbidden,
    );
    try {
      const overview = await toolsOverview(folder, tools);
      const composio = overview.tools.find((tool) => tool.name === "composio");
      expect(composio?.enabled).toBe(false);
      expect(composio?.organization).toEqual({ allowed: false, chosen: true });
      // Nothing else is governed.
      expect(
        overview.tools
          .filter((tool) => tool.organization !== undefined)
          .map((tool) => tool.name),
      ).toEqual(["composio"]);
      await recordOrganizationSettings(folder, allowed);
      const back = (await toolsOverview(folder, tools)).tools.find(
        (tool) => tool.name === "composio",
      );
      expect(back?.enabled).toBe(true);
      expect(back?.organization).toEqual({ allowed: true, chosen: true });
    } finally {
      await world.executor.stop();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "lazurio tools: enable and disable of a tool the Organization does not allow are refused with the reason",
  async () => {
    const { folder, world } = await environment(
      "hosted-organization-personal",
      bindings.organization,
      forbidden,
    );
    try {
      const context = {
        env: { PATH: world.path, HOME: world.home },
        platform: process.platform,
      };
      for (const verb of ["enable", "disable"]) {
        const json = await runToolsCommand(
          [
            verb,
            "composio",
            "--folder",
            folder,
            "--expected-revision",
            "3",
            "--json",
          ],
          context,
        );
        expect(json.code).toBe(2);
        expect(json.result).toEqual({
          kind: "blocked",
          reason: "organization-governed",
          tool: "composio",
        });
        const text = await runToolsCommand(
          [verb, "composio", "--folder", folder, "--expected-revision", "3"],
          context,
        );
        expect(text.text).toContain("organization-governed");
        expect(text.text).toContain(
          "the Organization does not allow composio on this Environment",
        );
      }
      // Another tool still changes.
      const wacli = await runToolsCommand(
        [
          "enable",
          "wacli",
          "--folder",
          folder,
          "--expected-revision",
          "3",
          "--json",
        ],
        context,
      );
      expect(wacli.result).toEqual({
        kind: "updated",
        revision: 4,
        tool: "wacli",
      });
      const list = await runToolsCommand(
        ["list", "--folder", folder, "--json"],
        context,
      );
      const composio = (
        list.result.tools as { name: string; enabled: boolean }[]
      ).find((tool) => tool.name === "composio");
      expect(composio).toMatchObject({
        enabled: false,
        organization: { allowed: false },
      });
      const text = await runToolsCommand(["list", "--folder", folder], context);
      expect(
        text.text.split("\n").find((line) => line.startsWith("composio")),
      ).toContain("not allowed by the Organization");
    } finally {
      await world.executor.stop();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a personal Environment decides alone: no Organization setting reaches its tools or Integrace",
  async () => {
    const { folder, world, tools } = await environment(
      "hosted-personal",
      bindings.personal,
      null,
    );
    try {
      // The Folder refuses to record one.
      expect(await recordOrganizationSettings(folder, forbidden)).toEqual({
        kind: "blocked",
        reason: "organization-settings-not-governed",
      });
      const overview = await readIntegrations({
        folder,
        tools,
        executor: world.executorHost(),
      });
      expect(overview.composio.source).toBe("environment");
      expect(overview.composio.allowed).toBe(true);
      const composio = (await toolsOverview(folder, tools)).tools.find(
        (tool) => tool.name === "composio",
      );
      expect(composio?.enabled).toBe(true);
      expect(composio?.organization).toBeUndefined();
    } finally {
      await world.executor.stop();
    }
  },
);
