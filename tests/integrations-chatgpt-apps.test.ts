import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegrationsCommand } from "../src/integrations/cli";
import type { IntegrationsOverview } from "../src/integrations/model";
import {
  chatgptAppsFoot,
  chatgptAppsLines,
  parseIntegrations,
} from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";
import { codexAppsMarker } from "../src/tools/codex-apps";
import { embeddedIdentity } from "../src/update/identity";
import {
  integrationsWorld,
  worldLaunchpad,
} from "./fixtures/integrations-world";
import { bindings } from "./fixtures/machine-bindings";

// Apps → Integrace and `lazurio integrations chatgpt-apps` (decision F42's
// addendum of 2026-10-27): the reading says whether ChatGPT's apps are
// allowed here, who decides and how the operator's Codex has them; the
// person's own Environment has its switch, which records the choice and
// brings Codex to it; an Organization's Environment refuses it. The Codex
// home is a temporary one with a stand-in `codex` on PATH.

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  handover: NonNullable<
    NonNullable<Parameters<typeof worldLaunchpad>[2]>["handover"]
  >,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-chatgpt-apps-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const world = await integrationsWorld(parent, { composio: false });
  cleanups.push(() => world.executor.stop());
  // Codex is on the world's PATH; its home is the test's own.
  const bin = join(world.home, ".local", "bin");
  await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "codex"), 0o755);
  const codexHome = join(parent, "codex-home");
  await mkdir(codexHome, { mode: 0o700 });
  await writeFile(join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\n');
  const codexApps = {
    home: world.home,
    path: world.path,
    platform: process.platform,
    env: { CODEX_HOME: codexHome },
  };
  const app = await worldLaunchpad(parent, world, {
    handover,
    seams: { codexApps },
  });
  cleanups.push(() => app.close());
  return { app, codexHome, world, codexApps };
}

async function reading(app: Awaited<ReturnType<typeof setup>>["app"]) {
  const answer = await app.get("/api/integrations?refresh=1");
  expect(answer.status).toBe(200);
  const value = (await answer.json()) as IntegrationsOverview;
  // The page takes it.
  expect(parseIntegrations(value)).not.toBeNull();
  return value.chatgptApps;
}

test.skipIf(process.platform === "win32")(
  "the person's own Environment: off by default, its switch records the choice and Codex follows",
  async () => {
    const { app, codexHome } = await setup({
      preset: "hosted-personal",
      machine: bindings.personal,
    });
    expect(await reading(app)).toEqual({
      allowed: false,
      source: "person",
      set: false,
      codex: "on",
      exceptions: 0,
    });
    // Off: the switch converges Codex to off.
    const off = await app.post("/api/integrations/chatgpt-apps", {
      allowed: false,
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
      kind: "chatgpt-apps",
      change: "unchanged",
      codex: { state: "off", by: "lazurio" },
    });
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
      `model = "gpt-6.1-sol"\n\n[apps._default] ${codexAppsMarker}\nenabled = false ${codexAppsMarker}\n\n[features] ${codexAppsMarker}\ntool_suggest = false ${codexAppsMarker}\n`,
    );
    // On: recorded in the Folder, Lazurio's line goes.
    const on = await app.post("/api/integrations/chatgpt-apps", {
      allowed: true,
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      change: "updated",
      policy: { allowed: true, source: "person", set: true },
      codex: { state: "on" },
    });
    expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
      'model = "gpt-6.1-sol"\n',
    );
    expect(await reading(app)).toMatchObject({ allowed: true, codex: "on" });
    // Only a boolean.
    expect(
      (await app.post("/api/integrations/chatgpt-apps", { allowed: "yes" }))
        .status,
    ).toBe(400);
  },
);

test.skipIf(process.platform === "win32")(
  "an Organization's Environment: off unless the Organization allows them, never the person's switch",
  async () => {
    const { app, codexHome, codexApps, world } = await setup({
      preset: "hosted-organization-personal",
      machine: bindings.organization,
    });
    expect(await reading(app)).toEqual({
      allowed: false,
      source: "organization",
      set: false,
      codex: "on",
      exceptions: 0,
    });
    const refused = await app.post("/api/integrations/chatgpt-apps", {
      allowed: true,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      kind: "blocked",
      reason: "organization-governed",
    });
    // The repair: the operator's CLI converges Codex to off.
    const env = {
      HOME: world.home,
      PATH: world.path,
      CODEX_HOME: codexApps.env.CODEX_HOME,
    };
    const context = {
      env,
      platform: process.platform,
      identity: embeddedIdentity(),
    } as unknown as Parameters<typeof runIntegrationsCommand>[1];
    const folder = join(codexHome, "..", "Lazurio");
    const applied = await runIntegrationsCommand(
      ["chatgpt-apps", "apply", "--folder", folder, "--json"],
      context,
    );
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout ?? "")).toMatchObject({
      converged: "changed",
      policy: { allowed: false, source: "organization" },
      codex: { state: "off", by: "lazurio" },
    });
    expect(
      (
        await runIntegrationsCommand(
          ["chatgpt-apps", "allow", "--folder", folder, "--json"],
          context,
        )
      ).code,
    ).toBe(2);
    const status = await runIntegrationsCommand(
      ["chatgpt-apps", "--folder", folder],
      context,
    );
    expect(status.stdout).toContain(
      "ChatGPT apps: not allowed here, by the Organization's settings (not set: off).",
    );
    expect(await reading(app)).toMatchObject({ allowed: false, codex: "off" });
  },
);

test("the page names who decides, offers the switch only on the person's own Environment and warns where Codex still has them", () => {
  const base = {
    kind: "integrations",
    locale: "cs",
    scope: "personal",
    page: null,
    composio: {
      allowed: true,
      source: "environment",
      ready: false,
      disconnect: false,
      update: false,
      apps: null,
      organization: null,
    },
    sources: { tools: "ok", executor: "absent", composio: "signed-out" },
    tools: [],
    apps: [],
    custom: [],
    readAt: "2026-10-27T12:00:00.000Z",
  } as const;
  const copy = messages("cs", "personal");
  const with_ = (chatgptApps: IntegrationsOverview["chatgptApps"]) =>
    ({ ...base, chatgptApps }) as IntegrationsOverview;
  // An overview of an earlier shape has no line.
  expect(parseIntegrations(base)).not.toBeNull();
  expect(chatgptAppsFoot(base as IntegrationsOverview, copy)).toBeNull();
  const personalOff = with_({
    allowed: false,
    source: "person",
    set: false,
    codex: "on",
    exceptions: 0,
  });
  expect(chatgptAppsFoot(personalOff, copy)).toEqual({
    text: copy.integrationsChatgptAppsOffPerson,
    action: { label: "Zapnout", allowed: true },
  });
  expect(chatgptAppsLines(personalOff, copy)).toEqual([
    copy.integrationsChatgptAppsStillOn,
  ]);
  const organizationOff = with_({
    allowed: false,
    source: "organization",
    set: true,
    codex: "off",
    exceptions: 2,
  });
  expect(chatgptAppsFoot(organizationOff, copy)).toEqual({
    text: copy.integrationsChatgptAppsOffOrganization,
    action: null,
  });
  expect(chatgptAppsLines(organizationOff, copy)).toEqual([
    copy.integrationsChatgptAppsExceptions,
  ]);
  const organizationOn = with_({
    allowed: true,
    source: "organization",
    set: true,
    codex: "on",
    exceptions: 0,
  });
  expect(chatgptAppsFoot(organizationOn, copy)?.action).toBeNull();
  expect(chatgptAppsLines(organizationOn, copy)).toEqual([]);
  expect(
    parseIntegrations({
      ...base,
      chatgptApps: { allowed: "no", source: "person", set: false },
    }),
  ).toBeNull();
  expect(copy.integrationsChatgptAppsOffOrganization).toBe(
    "Aplikace z ChatGPT jsou v tomto Osobním Prostředí vypnuté, Organizace je nepovoluje. Agenti používají jen aplikace připojené tady v Integracích.",
  );
});
