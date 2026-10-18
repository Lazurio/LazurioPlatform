import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { bootElementId, parseBoot } from "../src/launchpad/boot";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import { startLaunchpad } from "../src/launchpad/server";
import { themeAnswer } from "../src/launchpad/theme-routes";
import {
  appsTheme,
  parseThemeAnswer,
  previewColours,
  themeOfChoice,
  withAppsTheme,
} from "../src/launchpad/theme-view";
import { parseShell } from "../src/shell/contract";
import { environmentThemeCss } from "../src/shell/theme";
import {
  type EnvironmentThemeId,
  environmentThemeChoice,
  environmentThemeChoices,
  shellThemeOf,
} from "../src/theme/palettes";
import { defaultThemeRecord, fileThemeStore } from "../src/theme/record";
import type { ToolRunner } from "../src/tools/status";
import { writeOrganization } from "./fixtures/catalog-folder";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// Root decision 0208 in the Launchpad (F36's addendum of 2026-10-18): the
// Environment's theme record behind `GET /api/theme` and `POST
// /api/theme/set` (compare and set), in `/.lazurio/shell.json` with its dark
// values for Chat and Automate, and in the page a hosted Launchpad serves as
// Apps shows it, light only, so its first paint already wears it. On a
// public Environment the theme reads and is fixed: the change is refused.

const posixTest = test.skipIf(process.platform === "win32");

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
};

// A hosted work Environment, public with `audience`, behind a stand-in
// gateway admission. Without `kept` there is no install base, so its theme
// is kept in memory; with it, an install base whose record already holds
// that theme when the Launchpad starts (chosen before the Environment
// became public, root decision 0208 point 6).
async function hosted(audience = false, kept?: EnvironmentThemeId) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-theme-")),
  );
  const home = join(parent, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await Bun.write(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  await Bun.$`chmod 755 ${join(bin, "gh")}`;
  await mkdir(join(home, "Documents"), { mode: 0o700 });
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await writeOrganization(folder, "example_GEN3", {
    slug: "example",
    state: "current",
    modules: [{ id: "deals" }],
  });
  const preset = "hosted-organization-personal";
  const machine = organizationWithEntry(
    freePort(),
    "workspace.example.lazurio.io",
    false,
    false,
    audience,
  );
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  // Short, as the installed Launchpad's health socket lives in it.
  const installBase =
    kept === undefined ? undefined : await mkdtemp("/tmp/lt-");
  if (installBase !== undefined && kept !== undefined) {
    await mkdir(join(installBase, "update"), { mode: 0o700 });
    await fileThemeStore(installBase, folder).change(kept, null);
  }
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const run: ToolRunner = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "You are not logged into any GitHub hosts.",
  });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    installBase === undefined
      ? undefined
      : { base: installBase, version: "0.1.9-test" },
    { fetcher },
    { path: bin, home, platform: process.platform, run },
    {},
    undefined,
    undefined,
    { home, platform: process.platform, folder },
  );
  const host = new URL(entry.externalOrigin).host;
  const origin = new URL(entry.externalOrigin).origin;
  const headers = { host, cookie: "__Secure-lazurio-workspace=valid" };
  const base = `http://127.0.0.1:${entry.listenPort}`;
  return {
    base,
    get: (path: string) => fetch(`${base}${path}`, { headers }),
    post: (path: string, body: unknown, type = "application/json") =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          ...headers,
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": type,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
      if (installBase !== undefined)
        await rm(installBase, { recursive: true, force: true });
    },
  };
}

const themeStyleOf = (html: string) =>
  /<style data-lazurio-environment-theme>\n([\s\S]*?)<\/style>/.exec(html)?.[1];

posixTest(
  "the theme record through the API: read, changed at its revision, refused when stale, and carried to every app",
  async () => {
    const app = await hosted();
    try {
      // The default: Lazurio at revision 0, and every theme with its values.
      const read = await app.get("/api/theme");
      expect(read.status).toBe(200);
      const first = await read.json();
      expect(first).toEqual(
        JSON.parse(JSON.stringify(themeAnswer(defaultThemeRecord))),
      );
      expect(parseThemeAnswer(first)?.choices).toEqual(
        JSON.parse(JSON.stringify(environmentThemeChoices)),
      );
      // A change at the revision shown.
      const set = await app.post("/api/theme/set", {
        theme: "ocean",
        revision: 0,
      });
      expect(set.status).toBe(200);
      const changed = await set.json();
      expect(changed).toMatchObject({
        kind: "theme",
        outcome: "set",
        theme: "ocean",
        label: "Ocean",
        revision: 1,
      });
      expect(typeof changed.setAt).toBe("string");
      // Chat and Automate get it whole, its dark values with it.
      const shell = parseShell(
        await (await app.get("/.lazurio/shell.json")).json(),
      );
      expect(shell?.theme).toEqual(
        shellThemeOf({ theme: "ocean", revision: 1 }),
      );
      expect(shell?.theme?.dark).toBeDefined();
      // The page wears it from its first paint, as Apps shows it: light only.
      const html = await (await app.get("/settings/general")).text();
      expect(html).toContain('data-lazurio-environment-theme="ocean"');
      expect(html).not.toContain("data-lazurio-theme-dark");
      const style = themeStyleOf(html);
      expect(style).toBe(
        environmentThemeCss(
          appsTheme(shellThemeOf({ theme: "ocean", revision: 1 })),
        ),
      );
      expect(style).not.toContain("dark");
      // Its boot document says the same as the shell document.
      const boot = parseBoot(
        new RegExp(
          `<script type="application/json" id="${bootElementId}">([\\s\\S]*?)</script>`,
        ).exec(html)?.[1],
      );
      expect(boot?.shell?.theme).toEqual(shell?.theme);
      // A change asked at the revision before: refused with the current one.
      const stale = await app.post("/api/theme/set", {
        theme: "iris",
        revision: 0,
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        kind: "blocked",
        reason: "theme-changed",
        current: { kind: "theme", theme: "ocean", revision: 1 },
      });
      // The theme it has: unchanged, at any revision.
      const same = await app.post("/api/theme/set", {
        theme: "ocean",
        revision: 0,
      });
      expect(await same.json()).toMatchObject({
        outcome: "unchanged",
        revision: 1,
      });
      // Back to the design system's own look.
      const back = await app.post("/api/theme/set", {
        theme: "lazurio",
        revision: 1,
      });
      expect(await back.json()).toMatchObject({
        outcome: "set",
        theme: "lazurio",
        revision: 2,
      });
      expect(
        parseShell(await (await app.get("/.lazurio/shell.json")).json())?.theme,
      ).toEqual(shellThemeOf({ theme: "lazurio", revision: 2 }));
    } finally {
      await app.close();
    }
  },
  30_000,
);

posixTest(
  "the change takes exactly a theme and a revision",
  async () => {
    const app = await hosted();
    try {
      for (const [body, status, error] of [
        [{ theme: "t3-chat", revision: 0 }, 400, "invalid-theme"],
        [{ theme: "Ocean", revision: 0 }, 400, "invalid-theme"],
        [{ theme: "ocean" }, 400, "invalid-request"],
        [{ theme: "ocean", revision: 0, more: 1 }, 400, "invalid-request"],
        [{ theme: "ocean", revision: -1 }, 400, "invalid-revision"],
        [{ theme: "ocean", revision: "0" }, 400, "invalid-revision"],
        ["{", 400, "invalid-request"],
      ] as const) {
        const answer = await app.post("/api/theme/set", body);
        expect([
          JSON.stringify(body),
          answer.status,
          (await answer.json()).error,
        ]).toEqual([JSON.stringify(body), status, error]);
      }
      const typed = await app.post(
        "/api/theme/set",
        { theme: "ocean", revision: 0 },
        "text/plain",
      );
      expect(typed.status).toBe(415);
      expect((await app.get("/api/theme/set")).status).toBe(405);
      expect((await app.get("/api/theme?fresh=1")).status).toBe(400);
      // Nothing of it changed the record.
      expect((await (await app.get("/api/theme")).json()).revision).toBe(0);
    } finally {
      await app.close();
    }
  },
  30_000,
);

posixTest(
  "a public Environment's theme reads everywhere and is fixed: its change is refused",
  async () => {
    const app = await hosted(true);
    try {
      const read = await app.get("/api/theme");
      expect(read.status).toBe(200);
      expect((await read.json()).theme).toBe("lazurio");
      for (const body of [
        { theme: "ocean", revision: 0 },
        { theme: "nothing" },
      ]) {
        const refused = await app.post("/api/theme/set", body);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({
          kind: "blocked",
          reason: "public-environment",
        });
      }
      // The apps still get its theme.
      const shell = parseShell(
        await (await app.get("/.lazurio/shell.json")).json(),
      );
      expect(shell?.audience).toBe("public");
      expect(shell?.theme).toEqual(
        shellThemeOf({ theme: "lazurio", revision: 0 }),
      );
    } finally {
      await app.close();
    }
  },
  30_000,
);

posixTest(
  "a theme chosen before an Environment became public never reaches its visitors: they get Lazurio",
  async () => {
    // The control: the same kept record on an Environment that is not public.
    const work = await hosted(false, "ocean");
    try {
      expect((await (await work.get("/api/theme")).json()).theme).toBe("ocean");
    } finally {
      await work.close();
    }
    const app = await hosted(true, "ocean");
    try {
      const read = await app.get("/api/theme");
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(
        JSON.parse(JSON.stringify(themeAnswer(defaultThemeRecord))),
      );
      const shell = parseShell(
        await (await app.get("/.lazurio/shell.json")).json(),
      );
      expect(shell?.theme).toEqual(shellThemeOf(defaultThemeRecord));
      const html = await (await app.get("/settings/general")).text();
      expect(html).not.toContain('data-lazurio-environment-theme="ocean"');
      expect(themeStyleOf(html) ?? "").not.toContain("#e4ecf2");
      const refused = await app.post("/api/theme/set", {
        theme: "lazurio",
        revision: 0,
      });
      expect(refused.status).toBe(403);
    } finally {
      await app.close();
    }
  },
  30_000,
);

// The theme's note names the place it is about the way #497's words do: the
// kind of Environment with its own preposition, and your computer, which has
// no kind, as a computer (F28's addendum of 2026-10-18).
test("the theme's note names the kind of Environment it is in, and a computer as a computer", () => {
  expect(messages("cs", "workstation").themeNote).toBe(
    "Barvy Chatu, Apps a Automate na tomto počítači.",
  );
  expect(messages("en", "workstation").themeNote).toBe(
    "The colours of Chat, Apps and Automate on this computer.",
  );
  expect(messages("cs", "work").themeNote).toBe(
    "Barvy Chatu, Apps a Automate v tomto Pracovním Prostředí.",
  );
  expect(messages("en", "team").themeNote).toBe(
    "The colours of Chat, Apps and Automate in this Team Environment.",
  );
  expect(messages("cs", null).themeNote).toBe(
    "Barvy Chatu, Apps a Automate v tomto Prostředí.",
  );
});

test("the page's view of the answer: every choice a theme, the record's among them", () => {
  const answer = JSON.parse(
    JSON.stringify(themeAnswer({ theme: "ember", revision: 3, setAt: null })),
  );
  const view = parseThemeAnswer(answer);
  expect(view?.theme).toBe("ember");
  expect(view?.revision).toBe(3);
  expect(view?.choices.map((choice) => choice.id)).toEqual([
    "lazurio",
    "grove",
    "ocean",
    "ember",
    "iris",
  ]);
  for (const refused of [
    null,
    { ...answer, kind: "blocked" },
    { ...answer, theme: "aurora" },
    { ...answer, revision: -1 },
    { ...answer, choices: [] },
    { ...answer, choices: [...answer.choices, answer.choices[0]] },
    {
      ...answer,
      choices: [
        { ...answer.choices[0], light: {} },
        ...answer.choices.slice(1),
      ],
    },
  ])
    expect(parseThemeAnswer(refused)).toBeNull();
  // What the page declares at once after a change is what the shell
  // document names next.
  const ember = view?.choices.find((choice) => choice.id === "ember");
  if (ember === undefined) throw new Error("ember is a choice");
  expect(themeOfChoice(ember, 4)).toEqual(
    shellThemeOf({ theme: "ember", revision: 4 }),
  );
});

test("Apps shows a theme light only; Chat and Automate get it whole", () => {
  const ocean = shellThemeOf({ theme: "ocean", revision: 2 });
  expect(appsTheme(ocean)).toEqual({
    id: "ocean",
    label: "Ocean",
    revision: 2,
    light: ocean.light,
  });
  const shell = parseShell({
    schema: "lazurio.shell.v1",
    locale: "cs",
    current: "local",
    operator: { initials: null, login: null, avatar: null },
    environments: [
      {
        id: "local",
        label: null,
        kind: "workstation",
        organizations: [],
        assignee: null,
        apps: { apps: "/", chat: null, automate: null },
      },
    ],
    organizations: [],
    dashboard: "https://dashboard.lazurio.ai/home",
    account: "https://dashboard.lazurio.ai/settings/account",
    addOrganization: null,
    theme: ocean,
  });
  if (shell === null) throw new Error("A valid document");
  expect(withAppsTheme(shell).theme).toEqual(appsTheme(ocean));
  expect(shell.theme).toEqual(ocean);
  const { theme: _, ...without } = shell;
  expect(withAppsTheme(without)).toBe(without);
  // A card's miniature draws the theme's own surfaces, ink and buttons.
  expect(previewColours(environmentThemeChoice("iris").light)).toMatchObject({
    "--preview-surface": environmentThemeChoice("iris").light["--lz-surface"],
    "--preview-button":
      environmentThemeChoice("iris").light["--lz-accent-button"],
  });
});
