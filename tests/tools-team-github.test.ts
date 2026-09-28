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
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { messages } from "../src/launchpad/messages";
import { startLaunchpad } from "../src/launchpad/server";
import { curatedActions, logoutOutcome } from "../src/launchpad/tools-view";
import { runToolsCommand } from "../src/tools/cli";
import { sharedSignInsText } from "../src/tools/curated-cli";
import { hostedEnvironmentPreset } from "../src/tools/github-gate";
import type { ToolOverview } from "../src/tools/overview";
import { runTool, type ToolSignIn } from "../src/tools/status";
import {
  ghIdentity,
  githubActionRefused,
  teamGithubLogoutText,
  teamGithubText,
} from "../src/tools/team-github";
import { fakeLoginTools } from "./fixtures/fake-login-tools";
import { bindings } from "./fixtures/machine-bindings";

const posix = process.platform !== "win32";
const os = executionOs(process.platform);

test("the kind of gh's identity comes from the active entry of gh auth status", () => {
  const entry = (login: string, source: string, token = "gho_****") =>
    `github.com\n  ✓ Logged in to github.com account ${login} (${source})\n  - Active account: true\n  - Token: ${token}\n`;
  expect(ghIdentity(entry("octocat", "keyring"))).toBe("person");
  expect(
    ghIdentity(entry("octocat", "/home/operator/.config/gh/hosts.yml")),
  ).toBe("person");
  // Older gh: "as" and the config key.
  expect(ghIdentity("✓ Logged in to github.com as octo (oauth_token)\n")).toBe(
    "person",
  );
  // A GitHub App's identity: the [bot] login, or an installation token.
  expect(ghIdentity(entry("lazurio-for-github[bot]", "GH_TOKEN"))).toBe("app");
  expect(ghIdentity(entry("lazurio-for-github[bot]", "keyring"))).toBe("app");
  expect(ghIdentity(entry("someone", "keyring", "ghs_****"))).toBe("app");
  // A token from a variable is not a stored sign-in.
  expect(ghIdentity(entry("octocat", "GH_TOKEN"))).toBe("variable");
  expect(ghIdentity(entry("octocat", "GITHUB_TOKEN"))).toBe("variable");
  // Only the active (first) entry counts.
  expect(
    ghIdentity(
      `${entry("lazurio-for-github[bot]", "GH_TOKEN")}\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: false\n`,
    ),
  ).toBe("app");
  expect(ghIdentity(entry("octocat", "something else"))).toBe("unknown");
  expect(ghIdentity("You are not logged into any GitHub hosts.")).toBe(
    "unknown",
  );
});

test("the rule: gh on a brokered preset takes no sign-in or key, and signs out only a person", () => {
  const person: ToolSignIn = { state: "signed-in", identity: "person" };
  for (const action of ["login", "ssh-key"] as const) {
    expect(githubActionRefused({ brokered: true, tool: "gh", action })).toBe(
      true,
    );
    expect(githubActionRefused({ brokered: false, tool: "gh", action })).toBe(
      false,
    );
    for (const tool of ["composio", "wacli"])
      expect(githubActionRefused({ brokered: true, tool, action })).toBe(false);
  }
  expect(
    githubActionRefused({
      brokered: true,
      tool: "gh",
      action: "logout",
      signIn: person,
    }),
  ).toBe(false);
  for (const signIn of [
    undefined,
    { state: "signed-in" },
    { state: "signed-in", identity: "app" },
    { state: "signed-in", identity: "variable" },
    { state: "signed-in", identity: "unknown" },
    { state: "signed-out" },
    { state: "unknown" },
  ] as const)
    expect(
      githubActionRefused({
        brokered: true,
        tool: "gh",
        action: "logout",
        signIn,
      }),
    ).toBe(true);
  expect(
    githubActionRefused({
      brokered: false,
      tool: "gh",
      action: "logout",
      signIn: { state: "signed-in", identity: "app" },
    }),
  ).toBe(false);
});

test("the Launchpad's Team gh row offers Sign out exactly for a person's account, with one wording", () => {
  const copy = messages("en");
  const gh = (signIn?: ToolSignIn): ToolOverview => ({
    name: "gh",
    command: "gh",
    tier: "required",
    setup: "launchpad",
    enabled: true,
    purpose: "Purpose.",
    usage: "Usage.",
    source: "https://github.com/cli/cli#installation",
    installed: true,
    prompt: "Task: install.",
    ...(signIn === undefined ? {} : { signIn }),
  });
  const none = { primary: null, linkSsh: false, logout: false };
  expect(
    curatedActions(
      gh({
        state: "signed-in",
        account: "annavesela",
        identity: "person",
        ssh: { state: "not-linked", reason: "not-registered" },
      }),
      copy,
      true,
    ),
  ).toEqual({ primary: null, linkSsh: false, logout: true });
  for (const signIn of [
    undefined,
    { state: "signed-out" },
    { state: "unknown" },
    { state: "signed-in", account: "lazurio-for-github[bot]", identity: "app" },
    { state: "signed-in", account: "octocat", identity: "variable" },
    { state: "signed-in", account: "octocat" },
  ] as const)
    expect(curatedActions(gh(signIn), copy, true)).toEqual(none);
  // Not installed: nothing to install from here either.
  expect(curatedActions({ ...gh(), installed: false }, copy, true)).toEqual(
    none,
  );
  // Elsewhere gh keeps its actions.
  expect(curatedActions(gh({ state: "signed-out" }), copy, false)).toEqual({
    primary: { mode: "login", label: copy.toolsSignInAction },
    logout: false,
    linkSsh: false,
  });
  // One wording: the page's sentence is the rule's text.
  expect(messages("en").toolsTeamGithub).toBe(teamGithubText.en);
  expect(messages("cs").toolsTeamGithub).toBe(teamGithubText.cs);
  expect(messages("en").toolsSshTeam).toBe("Uses Lazurio for GitHub");
  expect(messages("cs").toolsSshTeam).toBe("Používá Lazurio for GitHub");
  expect(
    logoutOutcome(
      {
        kind: "blocked",
        reason: "team-environment",
        tool: "gh",
        action: "logout",
      },
      "gh",
      copy,
    ),
  ).toEqual({
    kind: "failed",
    reload: false,
    message: `${teamGithubText.en} ${teamGithubLogoutText.en}`,
  });
});

// A Folder of one preset and a private home with fake gh and composio.
async function environment(preset: PresetName) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-team-github-")),
  );
  const home = join(parent, "home");
  const path = await fakeLoginTools(home, ["gh", "composio"]);
  const folder = join(parent, "Lazurio");
  if (preset === "local")
    await initializeFolder(folder, {
      os,
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
  else {
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    if (preset === "hosted-personal")
      await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    await initializeHandoverFolder(folder, {
      preset,
      machine:
        preset === "hosted-personal"
          ? bindings.personal
          : preset === "hosted-organization-personal"
            ? bindings.organization
            : bindings.team,
      profile: presetProfile(preset, os),
    });
  }
  const lines: string[] = [];
  return {
    home,
    folder,
    path,
    lines,
    context: (extra: Record<string, unknown> = {}) => ({
      env: { HOME: home, PATH: path },
      platform: process.platform,
      write: (line: string) => lines.push(line),
      login: { firstChallengeMs: 5_000, probeIntervalMs: 50, machine: "vm-01" },
      hostedFolder: async () => folder,
      ...extra,
    }),
    signIn: async (account: string) => {
      await writeFile(join(home, "gh.state"), `${account}\n`);
      await writeFile(join(home, "gh.scopes"), "gist read:org repo\n");
    },
    ghCalls: () => readFile(join(home, "gh.calls"), "utf8").catch(() => ""),
    close: () => rm(parent, { recursive: true, force: true }),
  };
}

test.skipIf(!posix)(
  "the CLI reads the kind of Environment from the hosted operator Folder; none means as before",
  async () => {
    const team = await environment("hosted-organization-team");
    try {
      expect(await hostedEnvironmentPreset(async () => team.folder)).toBe(
        "hosted-organization-team",
      );
      expect(await hostedEnvironmentPreset(undefined)).toBeUndefined();
      expect(
        await hostedEnvironmentPreset(async () => undefined),
      ).toBeUndefined();
      // A Folder that cannot be read: as on a workstation.
      expect(
        await hostedEnvironmentPreset(async () => join(team.home, "nothing")),
      ).toBeUndefined();
      expect(
        await hostedEnvironmentPreset(async () => {
          throw new Error("no handover");
        }),
      ).toBeUndefined();
    } finally {
      await team.close();
    }
  },
);

test.skipIf(!posix)(
  "tools login gh and --ssh-key are refused on a Team Environment before gh runs",
  async () => {
    const team = await environment("hosted-organization-team");
    try {
      for (const args of [
        ["login", "gh", "--json"],
        ["login", "gh", "--ssh-key", "--json"],
      ]) {
        const refused = await runToolsCommand(args, team.context());
        expect(refused.code).toBe(2);
        expect(refused.result).toEqual({
          kind: "blocked",
          reason: "team-environment",
          tool: "gh",
          action: args.includes("--ssh-key") ? "ssh-key" : "login",
        });
        expect(JSON.parse(refused.text)).toEqual(refused.result);
      }
      const text = await runToolsCommand(["login", "gh"], team.context());
      expect(text.code).toBe(2);
      expect(text.text).toBe(teamGithubText.en);
      expect(team.lines).toEqual([]);
      // Nothing ran: no gh process, no key, no code.
      expect(await team.ghCalls()).toBe("");
    } finally {
      await team.close();
    }
  },
);

test.skipIf(!posix)(
  "tools logout gh on a Team Environment signs out a person's account, never the Organization's identity",
  async () => {
    const team = await environment("hosted-organization-team");
    try {
      // Not signed in: nothing personal to sign out.
      const nothing = await runToolsCommand(
        ["logout", "gh", "--json"],
        team.context(),
      );
      expect(nothing.code).toBe(2);
      expect(nothing.result).toEqual({
        kind: "blocked",
        reason: "team-environment",
        tool: "gh",
        action: "logout",
      });
      // The Organization's App identity stays signed in.
      await team.signIn("lazurio-for-github[bot]");
      const bot = await runToolsCommand(["logout", "gh"], team.context());
      expect(bot.code).toBe(2);
      expect(bot.text).toBe(`${teamGithubText.en} ${teamGithubLogoutText.en}`);
      expect(await readFile(join(team.home, "gh.state"), "utf8")).toBe(
        "lazurio-for-github[bot]\n",
      );
      const calls = await team.ghCalls();
      expect(calls).not.toContain("auth logout");
      expect(calls).not.toContain("ssh-key");
      // A person's account left from the ended exception is signed out.
      await team.signIn("annavesela");
      const out = await runToolsCommand(
        ["logout", "gh", "--json"],
        team.context(),
      );
      expect(out.code).toBe(0);
      expect(out.result).toMatchObject({ kind: "logged-out", tool: "gh" });
      expect(await team.ghCalls()).toContain(
        "auth logout --hostname github.com",
      );
    } finally {
      await team.close();
    }
  },
);

test.skipIf(!posix)(
  "composio signs in on a Team Environment with the shared sign-ins warning",
  async () => {
    const team = await environment("hosted-organization-team");
    try {
      const signal = AbortSignal.abort();
      const out = await runToolsCommand(
        ["login", "composio"],
        team.context({ signal }),
      );
      expect(out.result).toMatchObject({ kind: "cancelled", tool: "composio" });
      expect(team.lines[0]).toBe(sharedSignInsText);
    } finally {
      await team.close();
    }
  },
);

test.skipIf(!posix)(
  "the other presets and a workstation keep gh's sign-in unchanged",
  async () => {
    for (const preset of [
      "hosted-organization-personal",
      "hosted-personal",
      "local",
    ] as const) {
      const opened = await environment(preset);
      try {
        for (const context of [
          opened.context(),
          opened.context({ hostedFolder: undefined }),
        ]) {
          // gh runs: a gh that is not signed in ends as not-signed-in.
          const linked = await runToolsCommand(
            ["login", "gh", "--ssh-key", "--json"],
            context,
          );
          expect(linked.code).toBe(1);
          expect(linked.result).toMatchObject({
            kind: "failed",
            reason: "not-signed-in",
          });
          expect(opened.lines.join("\n")).not.toContain(sharedSignInsText);
        }
        expect(await opened.ghCalls()).toContain("auth status");
        // The Organization's identity is nobody's concern here: logout runs.
        await opened.signIn("lazurio-for-github[bot]");
        const out = await runToolsCommand(
          ["logout", "gh", "--json"],
          opened.context(),
        );
        expect(out.result).toMatchObject({ kind: "logged-out" });
      } finally {
        await opened.close();
      }
    }
  },
);

test.skipIf(!posix)(
  "the Launchpad of a Team Folder refuses gh's sign-in, key and poll, and signs out only a person",
  async () => {
    const team = await environment("hosted-organization-team");
    const app = await startLaunchpad(
      team.folder,
      undefined,
      undefined,
      undefined,
      {},
      {
        path: team.path,
        home: team.home,
        xdg: {},
        platform: process.platform,
        run: runTool,
      },
      {
        login: { firstChallengeMs: 5_000, probeIntervalMs: 50 },
      },
    );
    const url = new URL(app.url);
    const call = async (route: string, body: unknown) => {
      const response = await fetch(new URL(route, url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: url.origin,
          Authorization: `Bearer ${url.hash.slice(1)}`,
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    const refusal = (action: string) => ({
      status: 409,
      body: { kind: "blocked", reason: "team-environment", tool: "gh", action },
    });
    try {
      expect(await call("/api/tools/login/start", { tool: "gh" })).toEqual(
        refusal("login"),
      );
      expect(
        await call("/api/tools/login/start", { tool: "gh", sshKey: true }),
      ).toEqual(refusal("ssh-key"));
      // A malformed request is still a malformed request.
      expect(
        (await call("/api/tools/login/start", { tool: "gh", sshKey: "yes" }))
          .status,
      ).toBe(400);
      expect(
        await call("/api/tools/login/poll", {
          tool: "gh",
          session: "0".repeat(32),
        }),
      ).toEqual(refusal("login"));
      // Cancelling is always possible.
      expect(
        await call("/api/tools/login/cancel", {
          tool: "gh",
          session: "0".repeat(32),
        }),
      ).toEqual({ status: 200, body: { kind: "none", tool: "gh" } });
      expect(await team.ghCalls()).toBe("");
      expect(await call("/api/tools/logout", { tool: "gh" })).toEqual(
        refusal("logout"),
      );
      await team.signIn("lazurio-for-github[bot]");
      expect(await call("/api/tools/logout", { tool: "gh" })).toEqual(
        refusal("logout"),
      );
      expect(await team.ghCalls()).not.toContain("auth logout");
      // The status names the kind, so the page can offer Sign out.
      const status = await call("/api/tools/status", { signIn: true });
      expect(
        (status.body.tools as Record<string, unknown>[])[0]?.signIn,
      ).toMatchObject({
        state: "signed-in",
        account: "lazurio-for-github[bot]",
        identity: "app",
      });
      await team.signIn("annavesela");
      const out = await call("/api/tools/logout", { tool: "gh" });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ kind: "logged-out", tool: "gh" });
      // composio is not gh: its sign-in starts on a Team Environment.
      const composio = await call("/api/tools/login/start", {
        tool: "composio",
      });
      expect(composio.status).toBe(200);
      expect(composio.body).toMatchObject({ tool: "composio" });
      expect(composio.body.kind).not.toBe("blocked");
      await call("/api/tools/login/cancel", {
        tool: "composio",
        session: composio.body.session,
      });
    } finally {
      await app.close();
      await team.close();
    }
  },
);

test.skipIf(!posix)(
  "tools list --sign-in on a Team Environment names Lazurio for GitHub instead of inviting a key",
  async () => {
    const team = await environment("hosted-organization-team");
    const personal = await environment("hosted-organization-personal");
    try {
      const line = async (opened: typeof team) =>
        (
          await runToolsCommand(
            ["list", "--folder", opened.folder, "--sign-in"],
            opened.context(),
          )
        ).text
          .split("\n")
          .find((entry) => entry.startsWith("gh "));
      await team.signIn("lazurio-for-github[bot]");
      const bot = await line(team);
      expect(bot).toContain(
        "(signed in as lazurio-for-github[bot], uses Lazurio for GitHub)",
      );
      expect(bot).not.toContain("SSH key");
      await team.signIn("annavesela");
      expect(await line(team)).toContain(
        "(signed in as annavesela, uses Lazurio for GitHub; a personal account is signed in here: lazurio tools logout gh)",
      );
      // Elsewhere the SSH key is what the line is about.
      await personal.signIn("annavesela");
      expect(await line(personal)).toContain(
        "(signed in as annavesela, SSH key not linked: lazurio tools login gh --ssh-key)",
      );
    } finally {
      await team.close();
      await personal.close();
    }
  },
);
