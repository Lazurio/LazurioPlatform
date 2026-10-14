import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  newModulePrompt,
  newPersonalModulePrompt,
} from "../src/launchpad/apps-view";
import {
  chatPromptsSince,
  chatTakesPromptsAt,
  createChatPromptCheck,
  t3Version,
} from "../src/launchpad/chat";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import {
  type BoundOrganization,
  isOrganizationPrompt,
  isPromptId,
  personalModuleDocument,
  promptAudience,
  promptDocument,
  promptOrganization,
  promptScope,
} from "../src/launchpad/prompts";
import { startLaunchpad } from "../src/launchpad/server";
import type {
  Catalog,
  CatalogOrganization,
} from "../src/organizations/catalog";
import type { ToolRunner } from "../src/tools/status";
import {
  folderFixture,
  writeOrganization,
  writePersonalspaceModule,
} from "./fixtures/catalog-folder";
import {
  checkoutWithOrigin,
  contentHost,
  createWorld,
  presetFolder,
  stubGitHub,
  type World,
} from "./fixtures/content-world";
import {
  organizationWithEntry,
  personalWithEntry,
} from "./fixtures/machine-bindings";

// "+ Nový modul" opens Chat with a prepared prompt (Lazurio/t3code#35): the
// Launchpad serves `GET /.lazurio/prompts/<id>?org=<login>` only to whom the
// prompt names (the tile's Owner rule), the same 404 to anyone else; the
// link carries the id and the login, never the text; and the page hands the
// prompt over by link only where this Environment's T3 Code takes it,
// otherwise through the clipboard.

const posixTest = test.skipIf(process.platform === "win32");
const cs = messages("cs");
const en = messages("en");

let world: World | undefined;
let closing: (() => Promise<unknown>) | undefined;
async function closeLaunchpad() {
  await closing?.();
  closing = undefined;
}
afterEach(async () => {
  await closeLaunchpad();
  await world?.close();
  world = undefined;
});

function organization(directory: string): CatalogOrganization;
function organization(directory: string, forgeLogin: string): BoundOrganization;
function organization(
  directory: string,
  forgeLogin?: string,
): CatalogOrganization {
  return {
    directory,
    organization: directory.replace(/_GEN3$/, ""),
    displayName: "Example Company",
    ...(forgeLogin === undefined ? {} : { forgeLogin }),
    state: "current",
    issues: [],
    executable: true,
    teams: [],
    modules: [],
    repositories: [],
  };
}

test("the prompts: new-module for the Organization's Owner, new-personal-module for the Personalspace's holder in the Folder's root", () => {
  expect(isPromptId("new-module")).toBe(true);
  for (const id of ["other", "New-Module", "__proto__", "constructor", ""])
    expect([id, isPromptId(id)]).toEqual([id, false]);
  expect(promptAudience("new-module")).toBe("organization-owner");
  expect(isPromptId("new-personal-module")).toBe(true);
  expect(promptAudience("new-personal-module")).toBe("personalspace-holder");
  expect(promptScope("new-personal-module")).toBe("folder");
  expect(isOrganizationPrompt("new-personal-module")).toBe(false);
});

test("the personal module's document: only for the holder's own login, letter case ignored, in the Folder's root", () => {
  const held = {
    kind: "held",
    login: "Example",
    directory: "/home/x/Lazurio/personalspace/Example_GEN3",
  } as const;
  for (const login of ["Example", "example", "EXAMPLE"])
    expect(personalModuleDocument("/home/x/Lazurio", held, login, cs)).toEqual({
      schema: "lazurio.prompt.v1",
      id: "new-personal-module",
      // The login as GitHub spells it, not as the link does.
      text: newPersonalModulePrompt("Example", cs),
      cwd: "/home/x/Lazurio",
    });
  expect(
    personalModuleDocument("relative/Lazurio", held, "example", en)?.cwd,
  ).toStartWith("/");
  for (const login of ["someone", "examples", "a/b", "-x", ""])
    expect([
      login,
      personalModuleDocument("/home/x/Lazurio", held, login, cs),
    ]).toEqual([login, null]);
  for (const holder of [
    { kind: "absent" },
    { kind: "blocked", reason: "personalspace-foreign", login: "example" },
    { kind: "blocked", reason: "github-identity-mismatch", login: "example" },
    { kind: "blocked", reason: "personalspace-unverified", login: null },
  ] as const)
    expect(
      personalModuleDocument("/home/x/Lazurio", holder, "example", cs),
    ).toBeNull();
});

test("the Organization a login names: exactly one bound to it, case-insensitively", () => {
  const example = organization("example_GEN3", "Example-Org");
  const catalog: Catalog = {
    kind: "catalog",
    organizations: [
      example,
      organization("unbound_GEN3"),
      organization("twin_GEN3", "twin"),
      organization("twin-copy_GEN3", "Twin"),
    ],
    personalspace: organization("personalspace", "personal-login"),
  };
  expect(promptOrganization(catalog, "example-org")).toBe(example);
  expect(promptOrganization(catalog, "Example-Org")).toBe(example);
  for (const login of [
    "twin",
    "unknown",
    "personal-login",
    "unbound",
    "-bad",
    "a/b",
    "",
    "x".repeat(40),
  ])
    expect([login, promptOrganization(catalog, login)]).toEqual([login, null]);
});

test("the document: the brief in the person's language, opened in the Lazurio Folder's root (root decision 0189), absolute", () => {
  const example = organization("example_GEN3", "Example-Org");
  const document = promptDocument("new-module", "/home/x/Lazurio", example, cs);
  expect(document).toEqual({
    schema: "lazurio.prompt.v1",
    id: "new-module",
    text: newModulePrompt("Example Company", "Example-Org", cs),
    cwd: "/home/x/Lazurio",
  });
  expect(
    promptDocument("new-module", "relative/Lazurio", example, cs).cwd,
  ).toStartWith("/");
});

test("Chat takes a prompt by link only from the first fork release with the hand-off, per channel", () => {
  expect(chatPromptsSince).toEqual({
    stable: "0.0.45-lazurio.2",
    preview: "0.0.45-preview.20261004.1",
  });
  for (const version of [
    "0.0.45-lazurio.2",
    "0.0.45-lazurio.10",
    "0.0.46-lazurio.1",
    "0.1.0-lazurio.1",
    "0.0.45-preview.20261004.1",
    "0.0.45-preview.20261101.1",
    "0.0.46-preview.20261001.1",
    "v0.0.45-lazurio.2",
  ])
    expect([version, chatTakesPromptsAt(version)]).toEqual([version, true]);
  for (const version of [
    "0.0.45-lazurio.1",
    "0.0.44-lazurio.9",
    "0.0.45-preview.20261002.1",
    "0.0.44-preview.20261101.1",
    // Vanilla upstream and anything else: no.
    "0.0.45",
    "0.0.46",
    "0.0.45-nightly.20261101.1",
    "lazurio",
    "",
  ])
    expect([version, chatTakesPromptsAt(version)]).toEqual([version, false]);
  expect(t3Version("t3 v0.0.45-lazurio.2\n")).toBe("0.0.45-lazurio.2");
  expect(t3Version("0.0.46-preview.20261101.3")).toBe(
    "0.0.46-preview.20261101.3",
  );
  expect(t3Version("t3 v0.0.45")).toBe("0.0.45");
  expect(t3Version("t3 v0.0.45-lazurio.2 v0.0.46-lazurio.1")).toBeNull();
  expect(t3Version("something else")).toBeNull();
});

async function withLauncher(
  answer: Awaited<ReturnType<ToolRunner>> | (() => never),
  run: (
    check: ReturnType<typeof createChatPromptCheck>,
    calls: string[][],
    clock: { now: number },
  ) => Promise<void>,
  launcher = true,
) {
  const home = await mkdtemp(join(tmpdir(), "chat-prompts-"));
  try {
    await mkdir(join(home, "bin"));
    if (launcher)
      await writeFile(join(home, "bin", "t3"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
    const calls: string[][] = [];
    const clock = { now: 1_000 };
    const check = createChatPromptCheck(
      {
        path: join(home, "bin"),
        home,
        platform: process.platform,
        run: async (command) => {
          calls.push([...command.slice(1)]);
          return typeof answer === "function" ? answer() : answer;
        },
      },
      () => clock.now,
    );
    await run(check, calls, clock);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

posixTest(
  "the Environment's own t3 answers, kept five minutes; every failure is no",
  async () => {
    await withLauncher(
      { exitCode: 0, stdout: "t3 v0.0.45-lazurio.2\n", stderr: "" },
      async (check, calls, clock) => {
        expect(await check.accepted()).toBe(true);
        expect(await check.accepted()).toBe(true);
        expect(calls).toEqual([["--version"]]);
        clock.now += 5 * 60_000 + 1;
        expect(await check.accepted()).toBe(true);
        expect(calls).toHaveLength(2);
      },
    );
    for (const answer of [
      { exitCode: 0, stdout: "t3 v0.0.45-lazurio.1\n", stderr: "" },
      { exitCode: 0, stdout: "t3 v0.0.45\n", stderr: "" },
      { exitCode: 1, stdout: "t3 v0.0.45-lazurio.2\n", stderr: "" },
      { exitCode: 0, stdout: "not a version", stderr: "" },
      "timeout" as const,
      () => {
        throw new Error("spawn failed");
      },
    ])
      await withLauncher(answer, async (check) => {
        expect(await check.accepted()).toBe(false);
      });
    await withLauncher(
      { exitCode: 0, stdout: "t3 v0.0.45-lazurio.2\n", stderr: "" },
      async (check, calls) => {
        expect(await check.accepted()).toBe(false);
        expect(calls).toEqual([]);
      },
      false,
    );
  },
);

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

// A hosted Launchpad of a personal work Environment whose Folder holds the
// Organization `example` bound to the GitHub login `Example-Org`. Its `gh`
// answers the membership question as `owner` says and its `t3` prints
// `version`; both are recorded.
async function hostedLaunchpad(owner: boolean, version: string) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-prompts-")),
  );
  const home = join(parent, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  for (const tool of ["gh", "t3"])
    await writeFile(join(bin, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await writeOrganization(folder, "example_GEN3", {
    slug: "example",
    state: "current",
    forge: "Example-Org",
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
  const calls: string[][] = [];
  const run: ToolRunner = async (command) => {
    calls.push([...command.slice(1)]);
    if (command[1] === "api")
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state: "active",
          role: owner ? "admin" : "member",
        }),
        stderr: "",
      };
    if (command[1] === "--version")
      return { exitCode: 0, stdout: `t3 v${version}\n`, stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    { path: bin, home, platform: process.platform, run },
  );
  const base = `http://127.0.0.1:${entry.listenPort}`;
  const host = new URL(entry.externalOrigin).host;
  return {
    folder,
    base,
    host,
    entry,
    calls,
    valid: { host, cookie: "__Secure-lazurio-workspace=valid" },
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

posixTest(
  "hosted: the prompt for the Organization's Owner, behind the gateway's admission, never cached",
  async () => {
    const hosted = await hostedLaunchpad(true, "0.0.45-lazurio.2");
    try {
      const { base, host, valid, folder, calls } = hosted;
      const path = `${base}/.lazurio/prompts/new-module?org=example-org`;
      expect((await fetch(path, { headers: { host } })).status).toBe(401);
      expect(calls).toEqual([]);
      const answer = await fetch(path, { headers: valid });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(answer.headers.get("content-type")).toStartWith(
        "application/json",
      );
      expect(await answer.json()).toEqual({
        schema: "lazurio.prompt.v1",
        id: "new-module",
        text: newModulePrompt("Example Company", "Example-Org", cs),
        cwd: folder,
      });
      // GitHub's own answer for the login the manifest binds.
      expect(calls).toEqual([["api", "user/memberships/orgs/Example-Org"]]);
      // Only GET.
      const posted = await fetch(path, {
        method: "POST",
        headers: {
          ...valid,
          origin: hosted.entry.externalOrigin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(posted.status).toBe(405);
      // Anything else is the same 404, and says nothing more.
      for (const other of [
        "/.lazurio/prompts/other?org=example-org",
        "/.lazurio/prompts/new-module?org=unknown",
        "/.lazurio/prompts/new-module",
        "/.lazurio/prompts/new-module?org=example-org&text=hello",
        "/.lazurio/prompts/new-module?org=example-org&org=example-org",
        "/.lazurio/prompts/new-module?org=a%2Fb",
      ]) {
        const refused = await fetch(`${base}${other}`, { headers: valid });
        expect([other, refused.status, await refused.json()]).toEqual([
          other,
          404,
          { error: "not-found" },
        ]);
      }
      // Chat on this Environment takes the prompt by link: its own t3 says
      // so.
      const handoff = await fetch(`${base}/api/chat/prompt-handoff`, {
        headers: valid,
      });
      expect(await handoff.json()).toEqual({
        kind: "chat-prompt-handoff",
        accepted: true,
      });
      expect(calls.at(-1)).toEqual(["--version"]);
      expect(
        (await fetch(`${base}/api/chat/prompt-handoff`, { headers: { host } }))
          .status,
      ).toBe(401);
    } finally {
      await hosted.close();
    }
  },
  30_000,
);

posixTest(
  "hosted: not an Owner, the same 404; an older T3 Code takes no prompt by link",
  async () => {
    const hosted = await hostedLaunchpad(false, "0.0.45-lazurio.1");
    try {
      const { base, valid } = hosted;
      const refused = await fetch(
        `${base}/.lazurio/prompts/new-module?org=example-org`,
        { headers: valid },
      );
      expect([refused.status, await refused.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
      const handoff = await fetch(`${base}/api/chat/prompt-handoff`, {
        headers: valid,
      });
      expect(await handoff.json()).toEqual({
        kind: "chat-prompt-handoff",
        accepted: false,
      });
    } finally {
      await hosted.close();
    }
  },
  30_000,
);

posixTest(
  "locally: the prompt only with the token; a workstation's Chat takes none by link",
  async () => {
    await folderFixture(async (folder) => {
      const bin = await mkdtemp(join(tmpdir(), "launchpad-prompts-bin-"));
      for (const tool of ["gh", "t3"])
        await writeFile(join(bin, tool), "#!/bin/sh\nexit 1\n", {
          mode: 0o755,
        });
      const calls: string[][] = [];
      const app = await startLaunchpad(
        folder,
        undefined,
        undefined,
        undefined,
        {},
        {
          path: bin,
          home: bin,
          platform: process.platform,
          run: async (command) => {
            calls.push([...command.slice(1)]);
            return {
              exitCode: 0,
              stdout:
                command[1] === "api"
                  ? '{"state":"active","role":"admin"}'
                  : "t3 v0.0.45-lazurio.2\n",
              stderr: "",
            };
          },
        },
      );
      const session = new URL(app.url);
      const token = session.hash.slice(1);
      try {
        const path = new URL("/.lazurio/prompts/new-module?org=alpha", session);
        expect((await fetch(path)).status).toBe(403);
        const answer = await fetch(path, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(answer.status).toBe(200);
        expect(await answer.json()).toMatchObject({
          schema: "lazurio.prompt.v1",
          id: "new-module",
          cwd: folder,
        });
        const handoff = await fetch(
          new URL("/api/chat/prompt-handoff", session),
          { headers: { Authorization: `Bearer ${token}` } },
        );
        expect(await handoff.json()).toEqual({
          kind: "chat-prompt-handoff",
          accepted: false,
        });
        // No Chat origin here: its t3 is never asked.
        expect(calls).toEqual([["api", "user/memberships/orgs/alpha"]]);
      } finally {
        await app.close();
        await rm(bin, { recursive: true, force: true });
      }
    });
  },
  30_000,
);

// A Launchpad of `preset` over a Folder whose personalspace/ holds `checkout`
// (a directory and the repository its origin names), with the content world's
// stub GitHub: hosted behind the gateway's admission, or a workstation with
// its token. Its tools are stubs that fail, so only the stub GitHub answers.
async function personalLaunchpad(
  preset: "hosted-personal" | "hosted-organization-personal" | "local",
  github: ReturnType<typeof stubGitHub>["github"],
  checkout: readonly [string, string] | null,
) {
  const active = world as World;
  const machine =
    preset === "hosted-personal"
      ? personalWithEntry(freePort())
      : preset === "hosted-organization-personal"
        ? organizationWithEntry(freePort())
        : null;
  const folder = await presetFolder(active, preset, machine);
  if (checkout !== null) {
    const [name, origin] = checkout;
    await writePersonalspaceModule(folder, name, "example", { id: "notes" });
    await checkoutWithOrigin(join(folder, "personalspace", name), origin);
  }
  const bin = join(active.root, `bin-${crypto.randomUUID()}`);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  for (const tool of ["gh", "t3"])
    await writeFile(join(bin, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    {
      path: bin,
      home: bin,
      platform: process.platform,
      run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    },
    {},
    undefined,
    undefined,
    undefined,
    contentHost(active, github),
  );
  closing = () => app.close();
  const entry = machine?.entry;
  if (entry === undefined) {
    const session = new URL(app.url);
    const headers = { Authorization: `Bearer ${session.hash.slice(1)}` };
    return {
      folder,
      get: (path: string, authorized = true) =>
        fetch(new URL(path, session), authorized ? { headers } : {}),
    };
  }
  const host = new URL(entry.externalOrigin).host;
  return {
    folder,
    get: (path: string, authorized = true) =>
      fetch(`http://127.0.0.1:${entry.listenPort}${path}`, {
        headers: authorized
          ? { host, cookie: "__Secure-lazurio-workspace=valid" }
          : { host },
      }),
  };
}

const ownPersonalspace = {
  "example/example_GEN3": {
    owner: { login: "example", databaseId: 12345, kind: "User" as const },
  },
};
const personalPrompt = "/.lazurio/prompts/new-personal-module";

posixTest(
  "hosted personal: new-personal-module for the Personalspace's holder by its own login, in the Folder's root; the same 404 for anyone and anything else",
  async () => {
    world = await createWorld();
    const own = stubGitHub(world, { repositories: ownPersonalspace });
    const held = await personalLaunchpad("hosted-personal", own.github, [
      "example_GEN3",
      "example/example_GEN3",
    ]);
    // Behind the gateway's admission, before anything is asked.
    expect(
      (await held.get(`${personalPrompt}?org=example`, false)).status,
    ).toBe(401);
    expect(own.calls).toEqual([]);
    for (const login of ["example", "Example"]) {
      const answer = await held.get(`${personalPrompt}?org=${login}`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(await answer.json()).toEqual({
        schema: "lazurio.prompt.v1",
        id: "new-personal-module",
        text: newPersonalModulePrompt("example", en),
        cwd: held.folder,
      });
    }
    for (const other of [
      `${personalPrompt}?org=someone`,
      `${personalPrompt}?org=a%2Fb`,
      personalPrompt,
      `${personalPrompt}?org=example&text=hello`,
      `${personalPrompt}?org=example&org=example`,
    ]) {
      const refused = await held.get(other);
      expect([other, refused.status, await refused.json()]).toEqual([
        other,
        404,
        { error: "not-found" },
      ]);
    }
    await closeLaunchpad();

    // Not held: another account signed in (not the handover's Owner), the
    // account's checkout of another's Personalspace, a public one, gh
    // signed out, no Personalspace here. Each the same 404.
    const cases: readonly [
      string,
      Parameters<typeof stubGitHub>[1],
      readonly [string, string] | null,
    ][] = [
      [
        "identity mismatch",
        {
          viewer: {
            kind: "signed-in",
            viewer: { login: "someone", databaseId: 999 },
          },
          repositories: {
            "someone/someone_GEN3": {
              owner: { login: "someone", databaseId: 999, kind: "User" },
            },
          },
        },
        ["someone_GEN3", "someone/someone_GEN3"],
      ],
      [
        "foreign",
        { repositories: ownPersonalspace },
        ["stranger_GEN3", "stranger/stranger_GEN3"],
      ],
      [
        "public",
        {
          repositories: {
            "example/example_GEN3": {
              ...ownPersonalspace["example/example_GEN3"],
              private: false,
            },
          },
        },
        ["example_GEN3", "example/example_GEN3"],
      ],
      [
        "signed out",
        { viewer: { kind: "signed-out" } },
        ["example_GEN3", "example/example_GEN3"],
      ],
      ["absent", { repositories: ownPersonalspace }, null],
    ];
    for (const [name, options, checkout] of cases) {
      const stub = stubGitHub(world, options);
      const app = await personalLaunchpad(
        "hosted-personal",
        stub.github,
        checkout,
      );
      for (const login of ["example", "someone"]) {
        const refused = await app.get(`${personalPrompt}?org=${login}`);
        expect([name, login, refused.status, await refused.json()]).toEqual([
          name,
          login,
          404,
          { error: "not-found" },
        ]);
      }
      await closeLaunchpad();
    }
  },
  90_000,
);

posixTest(
  "a workstation: new-personal-module for the holder only with the token; an Organization Environment never serves it",
  async () => {
    world = await createWorld();
    const own = stubGitHub(world, { repositories: ownPersonalspace });
    const local = await personalLaunchpad("local", own.github, [
      "example_GEN3",
      "example/example_GEN3",
    ]);
    expect(
      (await local.get(`${personalPrompt}?org=example`, false)).status,
    ).toBe(403);
    const answer = await local.get(`${personalPrompt}?org=example`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      schema: "lazurio.prompt.v1",
      id: "new-personal-module",
      text: newPersonalModulePrompt("example", en),
      cwd: local.folder,
    });
    await closeLaunchpad();
    // A work Environment has no Personalspace: a stray personalspace/ is
    // never read, and nothing is asked.
    const asked = stubGitHub(world, { repositories: ownPersonalspace });
    const work = await personalLaunchpad(
      "hosted-organization-personal",
      asked.github,
      ["example_GEN3", "example/example_GEN3"],
    );
    const refused = await work.get(`${personalPrompt}?org=example`);
    expect([refused.status, await refused.json()]).toEqual([
      404,
      { error: "not-found" },
    ]);
    expect(asked.calls.filter((call) => call.kind !== "membership")).toEqual(
      [],
    );
  },
  60_000,
);
