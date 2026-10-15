import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  parseContentJob,
  parseContentList,
} from "../src/launchpad/content-client";
import { shellSetup } from "../src/launchpad/first-run";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import {
  isOrganizationPrompt,
  isPromptId,
  prepareContentDocument,
  promptAudience,
  promptScope,
} from "../src/launchpad/prompts";
import { startLaunchpad } from "../src/launchpad/server";
import {
  type ContentReader,
  createGithubProbe,
} from "../src/launchpad/setup-state";
import { shellDocument } from "../src/launchpad/shell-document";
import {
  autoEnable,
  connectionLine,
  loginTitle,
  toolDescription,
} from "../src/launchpad/tools-view";
import { parseShell, parseShellSetup, type Shell } from "../src/shell/contract";
import { shellMessages } from "../src/shell/messages";
import { columnSetupPrompt } from "../src/shell/view";
import type { ToolOverview } from "../src/tools/overview";
import type { ToolRunner } from "../src/tools/status";
import { writeOrganization } from "./fixtures/catalog-folder";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// The first run (root decisions 0188 and 0201) beyond the page: the shell
// document's optional `setup` with the Environment's AI, the column head's
// quiet prompt in Apps, Chat and Automate, the prepared prompt
// `prepare-content` for "Vyřešit v Chatu", `GET /api/ai`, and in Settings →
// Nástroje the plain sentences and the switch turned on after a sign-in.

const posixTest = test.skipIf(process.platform === "win32");
const cs = messages("cs");
const shellCs = shellMessages("cs");

const workList = parseContentList({
  allowed: true,
  items: [
    {
      kind: "organization",
      login: "example-org",
      name: "Example",
      state: "absent",
    },
  ],
});
const failedJob = parseContentJob({
  id: "job-7",
  state: "failed",
  steps: [
    {
      item: { kind: "organization", login: "example-org" },
      key: "access",
      state: "done",
    },
    {
      item: { kind: "organization", login: "example-org" },
      key: "root",
      state: "failed",
    },
  ],
  failure: {
    item: { kind: "organization", login: "example-org" },
    key: "root",
    code: "clone-failed",
    detail: "git clone failed: Permission denied (publickey)",
  },
});

test("the shell's setup: only for a person's Environment, only what is known", () => {
  expect(
    shellSetup({
      preset: "hosted-organization-team",
      ai: "organization",
      github: "missing",
      list: workList,
      job: null,
    }),
  ).toBeUndefined();
  expect(
    shellSetup({
      preset: "local",
      ai: "missing",
      github: "unknown",
      list: workList,
      job: null,
    }),
  ).toBeUndefined();
  // No content routes: the AI and GitHub alone; an AI not known says
  // nothing of it.
  expect(
    shellSetup({
      preset: "local",
      ai: "missing",
      github: "missing",
      list: null,
      job: null,
    }),
  ).toEqual({ ai: "missing", github: "missing" });
  for (const ai of ["unknown", "loading"] as const)
    expect(
      shellSetup({
        preset: "local",
        ai,
        github: "missing",
        list: null,
        job: null,
      }),
    ).toEqual({ github: "missing" });
  expect(
    shellSetup({
      preset: "hosted-organization-personal",
      ai: "organization",
      github: "connected",
      list: workList,
      job: null,
    }),
  ).toEqual({
    ai: "ready",
    github: "connected",
    content: "missing",
    item: { kind: "organization", name: "Example", login: "example-org" },
  });
  expect(
    shellSetup({
      preset: "hosted-organization-personal",
      ai: "connected",
      github: "connected",
      list: workList,
      job: failedJob,
    }),
  ).toEqual({
    ai: "ready",
    github: "connected",
    content: "failed",
    item: { kind: "organization", name: "Example", login: "example-org" },
  });
  expect(
    shellSetup({
      preset: "hosted-personal",
      ai: "connected",
      github: "connected",
      list: parseContentList({
        allowed: true,
        items: [{ kind: "personalspace", login: "octocat", state: "present" }],
      }),
      job: null,
    }),
  ).toEqual({ ai: "ready", github: "connected", content: "ready" });
});

test("`setup` in lazurio.shell.v1: optional and additive, its exact shape or no document", () => {
  const base = shellDocument({
    preset: "hosted-organization-personal",
    machine: organizationWithEntry(),
    locale: "cs",
    catalog: { kind: "catalog", organizations: [] },
  });
  expect(base.setup).toBeUndefined();
  const document = JSON.parse(JSON.stringify(base));
  expect(parseShell({ ...document, setup: null })?.setup).toBeUndefined();
  const setup = {
    github: "connected",
    content: "failed",
    item: { kind: "organization", name: "Example", login: "example-org" },
  } as const;
  expect(parseShell({ ...document, setup })?.setup).toEqual(setup);
  expect(
    parseShell({
      ...document,
      setup: { github: "missing", unknownMember: true },
    })?.setup,
  ).toEqual({ github: "missing" });
  // The AI (root decision 0201): optional and additive, ready or missing.
  for (const ai of ["ready", "missing"] as const)
    expect(
      parseShell({ ...document, setup: { ai, github: "connected" } })?.setup,
    ).toEqual({ ai, github: "connected" });
  expect(
    parseShellSetup({
      github: "connected",
      content: "missing",
      item: { kind: "personalspace", login: null },
    }),
  ).toEqual({
    github: "connected",
    content: "missing",
    item: { kind: "personalspace", login: null },
  });
  for (const wrong of [
    "missing",
    { github: "maybe" },
    { content: "ready" },
    { github: "connected", content: "half" },
    { github: "connected", item: { kind: "organization", name: "x" } },
    {
      github: "connected",
      item: { kind: "organization", name: "x", login: "-x" },
    },
    { github: "connected", item: { kind: "personalspace", login: 7 } },
    { github: "connected", item: { kind: "team" } },
    { ai: "maybe", github: "connected" },
    { ai: null, github: "connected" },
  ])
    expect([wrong, parseShell({ ...document, setup: wrong })]).toEqual([
      wrong,
      null,
    ]);
  // The producer carries it and its own output passes the parser.
  expect(
    shellDocument({
      preset: "hosted-organization-personal",
      machine: organizationWithEntry(),
      locale: "cs",
      catalog: { kind: "catalog", organizations: [] },
      setup: { github: "missing" },
    }).setup,
  ).toEqual({ github: "missing" });
});

const hostedShell = (setup: unknown, chat = true): Shell => {
  const document = JSON.parse(
    JSON.stringify(
      shellDocument({
        preset: "hosted-organization-personal",
        machine: organizationWithEntry(),
        locale: "cs",
        catalog: { kind: "catalog", organizations: [] },
      }),
    ),
  );
  if (!chat) document.environments[0].apps.chat = null;
  const shell = parseShell({ ...document, setup });
  if (shell === null) throw new Error("fixture");
  return shell;
};

test("the column head's prompt: in Apps, Chat and Automate while a basic is missing, counting the done ones, leading to Začínáme", () => {
  const start = "https://launchpad.workspace.example.lazurio.io/settings/start";
  const prompt = (setup: unknown, app: "chat" | "apps" | "automate" | null) =>
    columnSetupPrompt(hostedShell(setup), shellCs, app);
  expect(prompt({ ai: "missing", github: "missing" }, "chat")).toEqual({
    text: "Dokončit nastavení (0 ze 3)",
    href: start,
    done: 0,
    total: 3,
  });
  for (const app of ["apps", "chat", "automate"] as const)
    expect(prompt({ ai: "ready", github: "missing" }, app)?.text).toBe(
      "Dokončit nastavení (1 ze 3)",
    );
  expect(
    prompt(
      {
        ai: "ready",
        github: "connected",
        content: "failed",
        item: { kind: "organization", name: "Example", login: "example-org" },
      },
      "automate",
    )?.text,
  ).toBe("Dokončit nastavení (2 ze 3)");
  expect(
    columnSetupPrompt(
      hostedShell({ ai: "ready", github: "connected", content: "missing" }),
      shellMessages("en"),
      "apps",
    )?.text,
  ).toBe("Finish setting up (2 of 3)");
  // Settings have Začínáme in their own navigation.
  expect(prompt({ ai: "missing", github: "missing" }, null)).toBeNull();
  // Nothing missing, or nothing known: no prompt. An AI not known is not
  // claimed missing.
  for (const setup of [
    { ai: "ready", github: "connected", content: "ready" },
    { ai: "ready", github: "connected" },
    { github: "connected", content: "ready" },
    undefined,
  ])
    expect(prompt(setup, "chat")).toBeNull();
  // A Launchpad served on this origin (a workstation): a path, which the
  // page moves to without a reload.
  const local = JSON.parse(
    JSON.stringify(
      shellDocument({
        preset: "local",
        machine: null,
        locale: "cs",
        catalog: { kind: "catalog", organizations: [] },
      }),
    ),
  );
  const workstation = parseShell({
    ...local,
    setup: { ai: "missing", github: "missing" },
  });
  if (workstation === null) throw new Error("fixture");
  expect(columnSetupPrompt(workstation, shellCs, "apps")?.href).toBe(
    "/settings/start",
  );
});

test("gh's state for the shell: asked with this Environment's gh, kept a minute, replaced by readings", async () => {
  const home = await mkdtemp(join(tmpdir(), "first-run-gh-"));
  try {
    const calls: string[][] = [];
    let answer = { exitCode: 1, stdout: "", stderr: "not logged in" };
    let clock = 0;
    const environment = (path: string) => ({
      path,
      home,
      platform: process.platform,
      run: (async (command) => {
        calls.push([...command.slice(1)]);
        return answer;
      }) as ToolRunner,
    });
    // No gh at all: GitHub is missing, nothing is run.
    const none = createGithubProbe(environment(join(home, "none")));
    expect(await none.state()).toBe("missing");
    expect(calls).toEqual([]);
    await mkdir(join(home, "bin"));
    await writeFile(join(home, "bin", "gh"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const probe = createGithubProbe(environment(join(home, "bin")), {
      now: () => clock,
    });
    expect(await probe.state()).toBe("missing");
    const asked = calls.length;
    expect(asked).toBeGreaterThan(0);
    answer = {
      exitCode: 0,
      stdout: JSON.stringify({
        hosts: {
          "github.com": [{ state: "success", active: true, login: "octocat" }],
        },
      }),
      stderr: "",
    };
    clock += 30_000;
    expect(await probe.state()).toBe("missing");
    expect(calls.length).toBe(asked);
    clock += 31_000;
    expect(await probe.state()).toBe("connected");
    // A reading of Settings → Nástroje replaces it at once.
    probe.remember(true, { state: "signed-out" });
    expect(await probe.state()).toBe("missing");
    probe.remember(false, undefined);
    expect(await probe.state()).toBe("missing");
    // An unprobed reading says nothing new.
    probe.remember(true, undefined);
    expect(await probe.state()).toBe("missing");
    // A sign-in through this Launchpad: asked again.
    probe.forget();
    expect(await probe.state()).toBe("connected");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("prepare-content: a Folder prompt for the Environment's operator, opened in the Folder's root", () => {
  expect(isPromptId("prepare-content")).toBe(true);
  expect(promptAudience("prepare-content")).toBe("environment-operator");
  expect(promptScope("prepare-content")).toBe("folder");
  expect(isOrganizationPrompt("prepare-content")).toBe(false);
  expect(isOrganizationPrompt("new-module")).toBe(true);
  const document = prepareContentDocument(
    "/home/x/Lazurio",
    {
      target: { kind: "personalspace" },
      failure: { step: "Stahuji", detail: "denied" },
    },
    cs,
  );
  expect(document.schema).toBe("lazurio.prompt.v1");
  expect(document.id).toBe("prepare-content");
  expect(document.cwd).toBe("/home/x/Lazurio");
  expect(document.text).toStartWith(
    "Příprava mého osobního prostoru (Personalspace) v tomto Prostředí se zastavila u kroku „Stahuji“:\ndenied\n",
  );
  expect(document.text).toContain("`lazurio personalspace install`");
});

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

// A hosted work Environment whose gh is signed out. With `content`, what
// lives here and the last installation are stubbed; without it, the
// Launchpad's own content routes answer.
async function hosted(content?: ContentReader) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-first-run-")),
  );
  const home = join(parent, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await writeOrganization(folder, "other_GEN3", {
    slug: "other",
    state: "current",
    modules: [{ id: "deals" }],
  });
  const preset = "hosted-organization-personal";
  const machine = organizationWithEntry(freePort());
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
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
    undefined,
    { fetcher },
    { path: bin, home, platform: process.platform, run },
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    content,
  );
  const host = new URL(entry.externalOrigin).host;
  return {
    folder,
    base: `http://127.0.0.1:${entry.listenPort}`,
    host,
    valid: { host, cookie: "__Secure-lazurio-workspace=valid" },
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const stub = (list: unknown, job: unknown): ContentReader => ({
  list: async () => list,
  lastJob: async () => job,
});
const listAnswer = {
  allowed: true,
  items: [
    {
      kind: "organization",
      login: "example-org",
      name: "Example",
      state: "absent",
    },
  ],
};
const failedAnswer = {
  id: "job-7",
  state: "failed",
  steps: [],
  failure: {
    item: { kind: "organization", login: "example-org" },
    key: "root",
    code: "clone-failed",
    detail: "git clone failed: Permission denied (publickey)",
  },
};

// The shell document's `setup` once the Launchpad has read it: the document
// never waits for GitHub (F36's addendum of 2026-10-08), so the first
// answers say nothing of it while the reading runs in the background.
async function knownSetup(app: Awaited<ReturnType<typeof hosted>>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const answer = await fetch(`${app.base}/.lazurio/shell.json`, {
      headers: app.valid,
    });
    expect(answer.status).toBe(200);
    const setup = parseShell(await answer.json())?.setup;
    if (setup !== undefined) return setup;
    await Bun.sleep(50);
  }
  return undefined;
}

posixTest(
  "hosted: the shell document says what is missing from the real content routes; with a stopped job, what stopped",
  async () => {
    // No stub: the Launchpad's own content routes (src/content) answer. A
    // work Environment's content is the Organization of its handover, and
    // it is not here yet.
    const without = await hosted();
    try {
      expect(await knownSetup(without)).toEqual({
        ai: "missing",
        github: "missing",
        content: "missing",
        item: { kind: "organization", name: "example", login: "example" },
      });
    } finally {
      await without.close();
    }
    const stopped = await hosted(stub(listAnswer, failedAnswer));
    try {
      expect(await knownSetup(stopped)).toEqual({
        ai: "missing",
        github: "missing",
        content: "failed",
        item: { kind: "organization", name: "Example", login: "example-org" },
      });
    } finally {
      await stopped.close();
    }
  },
  30_000,
);

posixTest(
  "hosted: prepare-content behind the admission, for the content that stopped, the same 404 otherwise",
  async () => {
    const app = await hosted(stub(listAnswer, failedAnswer));
    try {
      const { base, host, valid, folder } = app;
      const path = `${base}/.lazurio/prompts/prepare-content?org=example-org`;
      expect((await fetch(path, { headers: { host } })).status).toBe(401);
      const answer = await fetch(path, { headers: valid });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      const document = (await answer.json()) as Record<string, string>;
      expect(document.schema).toBe("lazurio.prompt.v1");
      expect(document.id).toBe("prepare-content");
      // The Lazurio Folder's root: the Organization is not here yet.
      expect(document.cwd).toBe(folder);
      expect(document.text?.split("\n").slice(0, 2)).toEqual([
        "Příprava Organizace Example (GitHub example-org) v tomto Prostředí se zastavila u kroku „Stahuji Organizaci“:",
        "git clone failed: Permission denied (publickey)",
      ]);
      expect(document.text).toContain(
        "`lazurio organization install example-org`",
      );
      // Without the login (a later fork that needs none): the same prompt.
      const bare = await fetch(`${base}/.lazurio/prompts/prepare-content`, {
        headers: valid,
      });
      expect(bare.status).toBe(200);
      for (const other of [
        "/.lazurio/prompts/prepare-content?org=someone-else",
        "/.lazurio/prompts/prepare-content?org=-x",
        "/.lazurio/prompts/prepare-content?org=example-org&text=hello",
        "/.lazurio/prompts/prepare-content?org=example-org&org=example-org",
      ]) {
        const refused = await fetch(`${base}${other}`, { headers: valid });
        expect([other, refused.status, await refused.json()]).toEqual([
          other,
          404,
          { error: "not-found" },
        ]);
      }
    } finally {
      await app.close();
    }
    // Nothing stopped, by a stub or by the real routes before any job:
    // nothing to resolve.
    for (const reader of [stub(listAnswer, null), undefined]) {
      const quiet = await hosted(reader);
      try {
        const refused = await fetch(
          `${quiet.base}/.lazurio/prompts/prepare-content?org=example-org`,
          { headers: quiet.valid },
        );
        expect(refused.status).toBe(404);
      } finally {
        await quiet.close();
      }
    }
  },
  60_000,
);

const tool = (overrides: Partial<ToolOverview>): ToolOverview => ({
  name: "composio",
  command: "composio",
  tier: "recommended",
  setup: "launchpad",
  enabled: false,
  offered: true,
  purpose: "Catalog purpose.",
  usage: "Usage.",
  source: "https://example.invalid",
  installed: true,
  prompt: "Prompt.",
  ...overrides,
});

test("auto-on: a sign-in of this session turns the switch on, never for a tool signed in before", () => {
  const signedIn = { kind: "signed-in", tool: "composio" } as const;
  expect(autoEnable(tool({}), signedIn)).toBe(true);
  expect(autoEnable(tool({}), { ...signedIn, already: true })).toBe(false);
  expect(autoEnable(tool({ enabled: true }), signedIn)).toBe(false);
  // A required tool has no switch (always on).
  expect(autoEnable(tool({ name: "gh", tier: "required" }), signedIn)).toBe(
    false,
  );
  expect(autoEnable(undefined, signedIn)).toBe(false);
  expect(autoEnable(tool({}), { kind: "expired", tool: "composio" })).toBe(
    false,
  );
});

test("Nástroje: one plain sentence per tool, connected or not, the version in its details", () => {
  expect(toolDescription(tool({ name: "gh" }), cs)).toBe(
    "Připojení na GitHub, kde jsou uložené vaše moduly. Bez něj tu nic nefunguje.",
  );
  expect(toolDescription(tool({ name: "neon" }), cs)).toBe(
    "Připojení na databáze Neon, hlavně pro vývoj aplikací.",
  );
  // A tool without a sentence of its own keeps the catalog's purpose.
  expect(toolDescription(tool({ name: "other" }), cs)).toBe("Catalog purpose.");
  expect(
    connectionLine(
      tool({ signIn: { state: "signed-in", account: "octocat" } }),
      cs,
    ),
  ).toEqual({ text: "Připojeno jako octocat", state: "signed-in", ssh: null });
  expect(
    connectionLine(tool({ signIn: { state: "signed-out" } }), cs).text,
  ).toBe("Nepřipojeno");
  expect(connectionLine(tool({ installed: false }), cs)).toEqual({
    text: "Ještě není přidané",
    state: "missing",
    ssh: null,
  });
  // gh's SSH key shows only when it needs the person.
  const gh = (state: "linked" | "not-linked" | "unknown") =>
    connectionLine(
      tool({
        name: "gh",
        tier: "required",
        signIn: { state: "signed-in", account: "octocat", ssh: { state } },
      }),
      cs,
    );
  expect(gh("linked")).toEqual({
    text: "Připojeno jako octocat",
    state: "signed-in",
    ssh: null,
  });
  expect(gh("not-linked").ssh).toBe("SSH klíč nepropojený");
  expect(gh("unknown").ssh).toBeNull();
  expect(loginTitle("gh", "login", cs)).toBe("Připojit GitHub");
  expect(loginTitle("composio", "install", cs)).toBe("Připojit aplikace");
  expect(loginTitle("wacli", "login", cs)).toBe("Připojit wacli");
  expect(cs.toolsSignInAction).toBe("Připojit");
  expect(cs.toolsSignOutAction).toBe("Odpojit");
  // Not added yet, and set up by an agent (the wireframe's labels).
  expect(cs.toolsInstallAction).toBe("Přidat a připojit");
  expect(cs.toolsAgentAction).toBe("Připojit s pomocí agenta");
});
