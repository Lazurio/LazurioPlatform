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
  shellSetup,
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
import { columnSetupLine } from "../src/shell/view";
import type { ToolOverview } from "../src/tools/overview";
import type { ToolRunner } from "../src/tools/status";
import { writeOrganization } from "./fixtures/catalog-folder";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// The first run (root decision 0188) beyond the page: the shell document's
// optional `setup`, the column head's line in Chat and Automate, the
// prepared prompt `prepare-content` for "Vyřešit v Chatu", and in Settings
// → Nástroje the plain sentences and the switch turned on after a sign-in.

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
      github: "missing",
      list: workList,
      job: null,
    }),
  ).toBeUndefined();
  expect(
    shellSetup({
      preset: "local",
      github: "unknown",
      list: workList,
      job: null,
    }),
  ).toBeUndefined();
  // No content routes: GitHub alone.
  expect(
    shellSetup({ preset: "local", github: "missing", list: null, job: null }),
  ).toEqual({ github: "missing" });
  expect(
    shellSetup({
      preset: "hosted-organization-personal",
      github: "connected",
      list: workList,
      job: null,
    }),
  ).toEqual({
    github: "connected",
    content: "missing",
    item: { kind: "organization", name: "Example", login: "example-org" },
  });
  expect(
    shellSetup({
      preset: "hosted-organization-personal",
      github: "connected",
      list: workList,
      job: failedJob,
    }),
  ).toEqual({
    github: "connected",
    content: "failed",
    item: { kind: "organization", name: "Example", login: "example-org" },
  });
  expect(
    shellSetup({
      preset: "hosted-personal",
      github: "connected",
      list: parseContentList({
        allowed: true,
        items: [{ kind: "personalspace", login: "octocat", state: "present" }],
      }),
      job: null,
    }),
  ).toEqual({ github: "connected", content: "ready" });
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

test("the column head's line: in Chat and Automate only, its buttons lead to the Launchpad's Settings", () => {
  const launchpad = "https://launchpad.workspace.example.lazurio.io";
  const missingGithub = hostedShell({ github: "missing" });
  expect(columnSetupLine(missingGithub, shellCs, "chat")).toEqual({
    tone: "info",
    icon: "key",
    text: "Bez GitHubu agenti nepracují.",
    links: [
      {
        label: "Připojit GitHub",
        href: `${launchpad}/settings/tools#lazurio-start=sign-in-gh`,
      },
    ],
  });
  expect(columnSetupLine(missingGithub, shellCs, "automate")?.text).toBe(
    "Bez GitHubu agenti nepracují.",
  );
  // Apps and Settings say it themselves.
  expect(columnSetupLine(missingGithub, shellCs, "apps")).toBeNull();
  expect(columnSetupLine(missingGithub, shellCs, null)).toBeNull();
  const install = `${launchpad}/settings/machine#lazurio-start=install-content`;
  expect(
    columnSetupLine(
      hostedShell({
        github: "connected",
        content: "missing",
        item: { kind: "organization", name: "Example", login: "example-org" },
      }),
      shellCs,
      "chat",
    ),
  ).toEqual({
    tone: "info",
    icon: "download",
    text: "Example tu ještě není.",
    links: [{ label: "Stáhnout", href: install }],
  });
  expect(
    columnSetupLine(
      hostedShell({
        github: "connected",
        content: "missing",
        item: { kind: "personalspace", login: "octocat" },
      }),
      shellCs,
      "chat",
    ),
  ).toEqual({
    tone: "info",
    icon: "download",
    text: "Osobní prostor tu ještě není.",
    links: [{ label: "Připravit", href: install }],
  });
  // Stopped: Chat with the prompt by its id and the login, never its text;
  // and trying again in Settings.
  const failed = {
    github: "connected",
    content: "failed",
    item: { kind: "organization", name: "Example", login: "example-org" },
  };
  expect(columnSetupLine(hostedShell(failed), shellCs, "automate")).toEqual({
    tone: "failed",
    icon: "warning",
    text: "Příprava se zastavila.",
    links: [
      {
        label: "Vyřešit v Chatu",
        href: "https://t3code.workspace.example.lazurio.io/#lazurio-prompt=prepare-content&lazurio-org=example-org",
      },
      { label: "Zkusit znovu", href: install },
    ],
  });
  // Without Chat here, or without a login to name, only trying again.
  expect(
    columnSetupLine(hostedShell(failed, false), shellCs, "automate")?.links,
  ).toEqual([{ label: "Zkusit znovu", href: install }]);
  // Usable, or nothing known: no line.
  for (const setup of [
    { github: "connected", content: "ready" },
    { github: "connected" },
    undefined,
  ])
    expect(columnSetupLine(hostedShell(setup), shellCs, "chat")).toBeNull();
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
    "Příprava mého osobního prostoru (Personalspace) v tomhle Environmentu se zastavila u kroku „Stahuji“:\ndenied\n",
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

// A hosted work Environment whose gh is signed out, with the content routes
// stubbed: what lives here and the last installation as `content` says.
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

posixTest(
  "hosted: the shell document says GitHub is missing; with the content routes, what stopped",
  async () => {
    const without = await hosted();
    try {
      const answer = await fetch(`${without.base}/.lazurio/shell.json`, {
        headers: without.valid,
      });
      expect(answer.status).toBe(200);
      expect(parseShell(await answer.json())?.setup).toEqual({
        github: "missing",
      });
    } finally {
      await without.close();
    }
    const stopped = await hosted(stub(listAnswer, failedAnswer));
    try {
      const answer = await fetch(`${stopped.base}/.lazurio/shell.json`, {
        headers: stopped.valid,
      });
      expect(parseShell(await answer.json())?.setup).toEqual({
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
        "Příprava Organizace Example (GitHub example-org) v tomhle Environmentu se zastavila u kroku „Stahuji Organizaci“:",
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
    // Nothing stopped, or no content routes: nothing to resolve.
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
    "Připojení na GitHub, kde jsou uložené tvoje moduly. Bez něj tu nic nefunguje.",
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
});
