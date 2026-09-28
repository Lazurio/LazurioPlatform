import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { gzipSync } from "node:zlib";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { messages } from "../src/launchpad/messages";
import { startLaunchpad } from "../src/launchpad/server";
import {
  curatedActions,
  logoutOutcome,
  parseToolsOverview,
  signInLine,
  teamInstallOutcome,
} from "../src/launchpad/tools-view";
import { toolPrompt } from "../src/tools/catalog";
import { runToolsCommand } from "../src/tools/cli";
import { sharedSignInsText } from "../src/tools/curated-cli";
import { ghJsonStatusArgs, readGhJsonStatus } from "../src/tools/gh-status";
import { hostedEnvironmentPreset } from "../src/tools/github-gate";
import type { InstallFetch } from "../src/tools/install";
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
  // Not installed: "Install" only, never "Install and sign in".
  expect(curatedActions({ ...gh(), installed: false }, copy, true)).toEqual({
    primary: { mode: "install-only", label: "Install" },
    linkSsh: false,
    logout: false,
  });
  expect(
    curatedActions({ ...gh(), installed: false }, messages("cs"), true).primary
      ?.label,
  ).toBe("Nainstalovat");
  // The Organization's App identity works there; nobody signed in.
  const bot = gh({
    state: "signed-in",
    account: "lazurio-for-github[bot]",
    identity: "app",
  });
  expect(signInLine(bot, copy, true)).toBe("Works as lazurio-for-github[bot]");
  expect(signInLine(bot, messages("cs"), true)).toBe(
    "Pracuje jako lazurio-for-github[bot]",
  );
  expect(signInLine(bot, copy, false)).toBe(
    "Signed in as lazurio-for-github[bot]",
  );
  expect(
    signInLine(
      gh({ state: "signed-in", account: "annavesela", identity: "person" }),
      copy,
      true,
    ),
  ).toBe("Signed in as annavesela");
  // "Install" on the Team row ends with the Team sentence, not a sign-in.
  expect(
    teamInstallOutcome(
      { kind: "installed", tool: "gh", version: "2.101.0", onPath: true },
      "gh",
      copy,
    ),
  ).toEqual({
    kind: "updated",
    reload: false,
    message: `${copy.toolsInstalledNow.replace("{name}", "gh").replace("{version}", "2.101.0")} ${teamGithubText.en}`,
  });
  expect(
    teamInstallOutcome(
      { kind: "install-failed", tool: "gh", stage: "download", reason: "x" },
      "gh",
      copy,
    ).kind,
  ).toBe("failed");
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
async function environment(
  preset: PresetName,
  tools: Parameters<typeof fakeLoginTools>[1] = ["gh", "composio"],
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-team-github-")),
  );
  const home = join(parent, "home");
  const path = await fakeLoginTools(home, tools);
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
    /** The Organization's brokered gh (`gh.broker`) or a gh older than the
     * JSON status (`gh.nojson`). */
    mode: (name: "gh.broker" | "gh.nojson") => writeFile(join(home, name), ""),
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
        "(works as lazurio-for-github[bot], uses Lazurio for GitHub)",
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

test("gh's JSON status gives the state, the login, the kind and the scopes, never the token", () => {
  const entry = (fields: Record<string, unknown>) =>
    JSON.stringify({
      hosts: {
        "github.com": [
          {
            state: "success",
            active: true,
            host: "github.com",
            gitProtocol: "ssh",
            ...fields,
          },
        ],
      },
    });
  // The broker wrapper's answer.
  expect(
    readGhJsonStatus(
      entry({
        login: "lazurio-for-github[bot]",
        tokenSource: "lazurio-broker-live-proof",
        scopes: "",
        gitProtocol: "https",
      }),
    ),
  ).toEqual({
    signIn: {
      state: "signed-in",
      account: "lazurio-for-github[bot]",
      identity: "app",
    },
    scopes: [],
  });
  // A person's stored sign-in; a token printed by mistake is never read.
  const person = readGhJsonStatus(
    entry({
      login: "annavesela",
      tokenSource: "/home/operator/.config/gh/hosts.yml",
      scopes: "admin:public_key, gist, read:org, repo",
      token: "gho_TOKEN-SECRET",
    }),
  );
  expect(person).toEqual({
    signIn: { state: "signed-in", account: "annavesela", identity: "person" },
    scopes: ["admin:public_key", "gist", "read:org", "repo"],
  });
  expect(JSON.stringify(person)).not.toContain("SECRET");
  expect(
    readGhJsonStatus(entry({ login: "octocat", tokenSource: "GH_TOKEN" }))
      ?.signIn,
  ).toEqual({ state: "signed-in", account: "octocat", identity: "variable" });
  // The active entry decides, wherever gh lists it.
  expect(
    readGhJsonStatus(
      JSON.stringify({
        hosts: {
          "github.com": [
            { state: "success", active: false, login: "other" },
            {
              state: "success",
              active: true,
              login: "octocat",
              tokenSource: "keyring",
            },
          ],
        },
      }),
    )?.signIn.account,
  ).toBe("octocat");
  expect(readGhJsonStatus('{"hosts":{}}')?.signIn).toEqual({
    state: "signed-out",
  });
  expect(
    readGhJsonStatus(entry({ state: "error", login: "octocat" }))?.signIn,
  ).toEqual({ state: "signed-out" });
  expect(
    readGhJsonStatus(entry({ state: "timeout", login: "octocat" }))?.signIn,
  ).toEqual({ state: "unknown" });
  // A login that is not a GitHub login is not shown.
  expect(
    readGhJsonStatus(entry({ login: "not a login", tokenSource: "keyring" }))
      ?.signIn,
  ).toEqual({ state: "signed-in", identity: "unknown" });
  // Not the JSON status: the caller falls back to the text form.
  for (const output of ["", "unknown flag: --json", "[]", '{"other":1}'])
    expect(readGhJsonStatus(output)).toBeUndefined();
  expect(ghJsonStatusArgs).toEqual(["auth", "status", "--json", "hosts"]);
});

test.skipIf(!posix)(
  "the Organization's brokered gh on a Team Environment works as the bot: no sign-out, logout refused",
  async () => {
    const team = await environment("hosted-organization-team");
    try {
      await team.mode("gh.broker");
      const listed = await runToolsCommand(
        ["list", "--folder", team.folder, "--sign-in", "--json"],
        team.context(),
      );
      const gh = (listed.result.tools as Record<string, unknown>[])[0];
      expect(gh?.signIn).toMatchObject({
        state: "signed-in",
        account: "lazurio-for-github[bot]",
        identity: "app",
      });
      const text = await runToolsCommand(
        ["list", "--folder", team.folder, "--sign-in"],
        team.context(),
      );
      expect(text.text).toContain(
        "(works as lazurio-for-github[bot], uses Lazurio for GitHub)",
      );
      const refused = await runToolsCommand(
        ["logout", "gh", "--json"],
        team.context(),
      );
      expect(refused.code).toBe(2);
      expect(refused.result).toMatchObject({ reason: "team-environment" });
      // Only the one command the wrapper answers ran against it.
      const calls = (await team.ghCalls())
        .trim()
        .split("\n")
        .filter((call) => call !== "--version");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call === "auth status --json hosts")).toBe(
        true,
      );
      expect(await team.ghCalls()).not.toContain("--show-token");
      // The Launchpad row: no Sign out for the bot.
      const signIn = gh?.signIn as ToolSignIn;
      expect(
        curatedActions(
          {
            name: "gh",
            command: "gh",
            tier: "required",
            setup: "launchpad",
            enabled: true,
            purpose: "",
            usage: "",
            source: "",
            installed: true,
            prompt: "",
            signIn,
          },
          messages("en"),
          true,
        ),
      ).toEqual({ primary: null, linkSsh: false, logout: false });
    } finally {
      await team.close();
    }
  },
);

test.skipIf(!posix)(
  "a person's account reads through the JSON status: sign-out on a Team Environment, unchanged on a Work Environment; an older gh falls back to the text form",
  async () => {
    const team = await environment("hosted-organization-team");
    const work = await environment("hosted-organization-personal");
    try {
      for (const opened of [team, work]) {
        await opened.signIn("annavesela");
        const listed = await runToolsCommand(
          ["list", "--folder", opened.folder, "--sign-in", "--json"],
          opened.context(),
        );
        expect(
          (listed.result.tools as Record<string, unknown>[])[0]?.signIn,
        ).toMatchObject({
          state: "signed-in",
          account: "annavesela",
          identity: "person",
        });
        // The JSON status answered; the text form did not run.
        const calls = await opened.ghCalls();
        expect(calls).toContain("auth status --json hosts");
        expect(calls).not.toContain("auth status --hostname github.com");
        expect(calls).not.toContain("--show-token");
      }
      const work2 = await runToolsCommand(
        ["list", "--folder", work.folder, "--sign-in"],
        work.context(),
      );
      expect(work2.text).toContain(
        "(signed in as annavesela, SSH key not linked: lazurio tools login gh --ssh-key)",
      );
      // A gh older than 2.81.0: the text form says the same.
      await team.mode("gh.nojson");
      const old = await runToolsCommand(
        ["list", "--folder", team.folder, "--sign-in", "--json"],
        team.context(),
      );
      expect(
        (old.result.tools as Record<string, unknown>[])[0]?.signIn,
      ).toMatchObject({
        state: "signed-in",
        account: "annavesela",
        identity: "person",
      });
      expect(await team.ghCalls()).toContain(
        "auth status --hostname github.com",
      );
      // Signing the person's account out works on both kinds.
      for (const opened of [team, work]) {
        const out = await runToolsCommand(
          ["logout", "gh", "--json"],
          opened.context(),
        );
        expect(out.result).toMatchObject({ kind: "logged-out", tool: "gh" });
      }
    } finally {
      await team.close();
      await work.close();
    }
  },
);

test.skipIf(!posix)(
  "the Launchpad of a Team Folder with the broker: the bot's status, no sign-out, and gh's Team prompt",
  async () => {
    const team = await environment("hosted-organization-team");
    await team.mode("gh.broker");
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
      { login: { firstChallengeMs: 5_000, probeIntervalMs: 50 } },
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
    try {
      const status = await call("/api/tools/status", { signIn: true });
      const overview = parseToolsOverview(status.body);
      const gh = overview?.tools[0];
      expect(gh?.signIn).toMatchObject({
        state: "signed-in",
        account: "lazurio-for-github[bot]",
        identity: "app",
      });
      expect(gh?.prompt).toBe(
        toolPrompt("gh", overview?.locale ?? "en", { team: true }),
      );
      expect(curatedActions(gh as ToolOverview, messages("en"), true)).toEqual({
        primary: null,
        linkSsh: false,
        logout: false,
      });
      expect(signInLine(gh as ToolOverview, messages("en"), true)).toBe(
        "Works as lazurio-for-github[bot]",
      );
      expect(await call("/api/tools/logout", { tool: "gh" })).toMatchObject({
        status: 409,
        body: { reason: "team-environment", action: "logout" },
      });
    } finally {
      await app.close();
      await team.close();
    }
  },
);

const teamSentence = {
  en: "On a Team Environment (hosted-organization-team) do not sign in gh or link a key: the Environment works in GitHub through Lazurio for GitHub, set up by the Organization.",
  cs: "V týmovém Environmentu (hosted-organization-team) gh nepřihlašuj a klíč nepropojuj: Environment pracuje v GitHubu přes Lazurio for GitHub, které nastavuje Organizace.",
};

test("gh's prompt: the Team sentence where the kind is unknown, the Team target state instead of the sign-in on a Team Environment", () => {
  for (const locale of ["en", "cs"] as const) {
    const general = toolPrompt("gh", locale) as string;
    expect(general).toContain(teamSentence[locale]);
    expect(general).toContain("gh auth login");
    const team = toolPrompt("gh", locale, { team: true }) as string;
    expect(team).not.toContain("gh auth login");
    expect(team).not.toContain("ssh-key add");
    expect(team).not.toContain(teamSentence[locale]);
    expect(team).toContain(
      locale === "en"
        ? "Do not sign in gh or link a key: the Environment works in GitHub through Lazurio for GitHub, set up by the Organization."
        : "gh nepřihlašuj a klíč nepropojuj: Environment pracuje v GitHubu přes Lazurio for GitHub, které nastavuje Organizace.",
    );
    expect(team).toContain("hosted-organization-team");
    // Tools without a Team target state keep their prompt.
    expect(toolPrompt("composio", locale, { team: true })).toBe(
      toolPrompt("composio", locale),
    );
  }
});

test.skipIf(!posix)(
  "lazurio tools prompt gh knows a hosted Team Environment from the operator Folder",
  async () => {
    const team = await environment("hosted-organization-team");
    const work = await environment("hosted-organization-personal");
    try {
      for (const locale of ["en", "cs"] as const) {
        const onTeam = await runToolsCommand(
          ["prompt", "gh", "--locale", locale],
          team.context(),
        );
        expect(onTeam.text).toBe(
          toolPrompt("gh", locale, { team: true }) as string,
        );
        const onWork = await runToolsCommand(
          ["prompt", "gh", "--locale", locale],
          work.context(),
        );
        expect(onWork.text).toBe(toolPrompt("gh", locale) as string);
        const nowhere = await runToolsCommand(
          ["prompt", "gh", "--locale", locale],
          team.context({ hostedFolder: undefined }),
        );
        expect(nowhere.text).toBe(toolPrompt("gh", locale) as string);
      }
    } finally {
      await team.close();
      await work.close();
    }
  },
);

test.skipIf(!posix)(
  "tools install gh on a Team Environment ends with Lazurio for GitHub, elsewhere with the sign-in",
  async () => {
    const version = "2.101.0";
    const base = `gh_${version}_linux_amd64`;
    const body = `#!/bin/sh\n[ "$1" = "--version" ] && echo "gh version ${version} (2026-09-01)"\n`;
    const block = (name: string, size: number) => {
      const header = new Uint8Array(512);
      const put = (value: string, at: number) =>
        header.set(new TextEncoder().encode(value), at);
      put(name, 0);
      put("0000755\0", 100);
      put(`${size.toString(8).padStart(11, "0")}\0`, 124);
      put("0", 156);
      put("ustar\0", 257);
      return header;
    };
    const data = new TextEncoder().encode(body);
    const padded = new Uint8Array(512);
    padded.set(data);
    const archive = new Uint8Array(
      gzipSync(
        Buffer.concat([
          block(`${base}/bin/gh`, data.length),
          padded,
          new Uint8Array(1024),
        ]),
      ),
    );
    const digest = createHash("sha256").update(archive).digest("hex");
    const root = `https://github.com/cli/cli/releases/download/v${version}`;
    const files: Record<string, BodyInit> = {
      "https://api.github.com/repos/cli/cli/releases/latest": `{"tag_name":"v${version}"}`,
      [`${root}/gh_${version}_checksums.txt`]: `${digest}  ${base}.tar.gz\n`,
      [`${root}/${base}.tar.gz`]: archive,
    };
    const fetcher: InstallFetch = async (url) =>
      files[url] === undefined
        ? new Response("", { status: 404 })
        : new Response(files[url]);
    for (const preset of [
      "hosted-organization-team",
      "hosted-organization-personal",
    ] as const) {
      const opened = await environment(preset, ["composio"]);
      try {
        const result = await runToolsCommand(
          ["install", "gh"],
          opened.context({
            install: { fetch: fetcher, platform: "linux", arch: "x64" },
          }),
        );
        expect(result.code).toBe(0);
        expect(result.text).toContain(`gh ${version} installed at`);
        if (preset === "hosted-organization-team") {
          expect(result.text).not.toContain("lazurio tools login gh");
          expect(result.text.endsWith(teamGithubText.en)).toBe(true);
        } else expect(result.text).toContain("Next: lazurio tools login gh");
      } finally {
        await opened.close();
      }
    }
  },
);
