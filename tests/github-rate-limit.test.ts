import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentItem } from "../src/launchpad/content-client";
import { contentView } from "../src/launchpad/content-view";
import {
  appsSetupLine,
  autoStartStep,
  basicState,
  contentBlockedBy,
  githubFact,
  githubLimitReset,
  shellSetup,
  startDecision,
} from "../src/launchpad/first-run";
import { messages } from "../src/launchpad/messages";
import { createGithubProbe } from "../src/launchpad/setup-state";
import {
  type StartFacts,
  startCount,
  startView,
} from "../src/launchpad/start-view";
import {
  clockTime,
  connectionLine,
  createLimitRefresh,
  curatedActions,
  limitRefreshDelay,
} from "../src/launchpad/tools-view";
import { findTool } from "../src/tools/catalog";
import {
  checkFailure,
  ghStatus,
  rateLimited,
  readGhJsonStatus,
} from "../src/tools/gh-status";
import type { ToolOverview } from "../src/tools/overview";
import { createSshProofs } from "../src/tools/ssh-key";
import { runTool, type ToolSignIn, toolsSignIn } from "../src/tools/status";
import { fakeLoginTools } from "./fixtures/fake-login-tools";

// GitHub's used-up rate limit is not a missing sign-in (#1223). gh checks
// its token with one REST request; when the account's hourly limit is used
// up, GitHub answers 403 "API rate limit exceeded" and gh reports an
// invalid token. Lazurio keeps such a gh signed in with `limit` (its reset
// when `gh api rate_limit`, which GitHub does not count, says it), asks
// nothing else of GitHub's API meanwhile, and Začínáme, Nástroje, Apps and
// doctor say GitHub refuses requests for now instead of "Nepřipojeno".

const cs = messages("cs");
const en = messages("en");
// 2026-11-23 22:06:06 UTC
const resetSeconds = 1_795_471_566;
const resetIso = new Date(resetSeconds * 1000).toISOString();

const entry = (fields: Record<string, unknown>) =>
  JSON.stringify({
    hosts: {
      "github.com": [
        {
          active: true,
          host: "github.com",
          login: "octocat",
          tokenSource: "keyring",
          gitProtocol: "ssh",
          ...fields,
        },
      ],
    },
  });

test("gh's JSON status: GitHub's rate limit is signed in with `limit`, a revoked token is signed out", () => {
  for (const error of [
    "HTTP 403: API rate limit exceeded for user ID 583231. (https://api.github.com/)",
    "HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (https://api.github.com/)",
    "HTTP 429: rate limit exceeded (https://api.github.com/)",
  ])
    expect(readGhJsonStatus(entry({ state: "error", error }))).toEqual({
      signIn: {
        state: "signed-in",
        account: "octocat",
        identity: "person",
        limit: {},
      },
      scopes: undefined,
    });
  // A revoked or invalid token, or another error: as before, signed out.
  for (const error of [
    "HTTP 401: Bad credentials (https://api.github.com/)",
    "HTTP 403: Resource not accessible by integration (https://api.github.com/)",
  ])
    expect(readGhJsonStatus(entry({ state: "error", error }))?.signIn).toEqual({
      state: "signed-out",
    });
  expect(rateLimited("HTTP 401: Bad credentials")).toBe(false);
  expect(rateLimited("HTTP 502: rate limit of the proxy")).toBe(false);
});

async function home() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-gh-limit-")),
  );
  const path = await fakeLoginTools(directory, ["gh"]);
  await writeFile(join(directory, "gh.state"), "octocat\n");
  await writeFile(
    join(directory, "gh.scopes"),
    "gist read:org repo admin:public_key\n",
  );
  const gh = join(directory, ".local", "bin", "gh");
  const env = { HOME: directory, PATH: path };
  const run = (command: readonly string[], timeoutMs: number) =>
    runTool(command, timeoutMs, env);
  const calls = async () =>
    (await readFile(join(directory, "gh.calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.length > 0);
  const sshCalls = async () =>
    (await readFile(join(directory, "ssh.calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.length > 0).length;
  return {
    directory,
    path,
    gh,
    run,
    calls,
    sshCalls,
    flag: (name: string, text = "") => writeFile(join(directory, name), text),
    unflag: (name: string) => rm(join(directory, name), { force: true }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("ghStatus reads the reset from `gh api rate_limit` and keeps the limit until then without running gh", async () => {
  const opened = await home();
  try {
    await opened.flag("gh.limited", `${resetSeconds}\n`);
    let clock = Date.parse(resetIso) - 30 * 60_000;
    const now = () => clock;
    const limits = createSshProofs({ now });
    const first = await ghStatus(opened.run, opened.gh, 10_000, limits, now);
    expect(first.signIn).toEqual({
      state: "signed-in",
      account: "octocat",
      identity: "person",
      limit: { reset: resetIso },
    });
    expect(await opened.calls()).toEqual([
      "auth status --json hosts",
      "api rate_limit",
    ]);
    // Within the limit: answered from memory, no request to GitHub.
    clock += 10 * 60_000;
    expect(await ghStatus(opened.run, opened.gh, 10_000, limits, now)).toEqual(
      first,
    );
    expect((await opened.calls()).length).toBe(2);
    // After the reset, gh is asked again, and it works.
    await opened.unflag("gh.limited");
    clock = Date.parse(resetIso) + 1000;
    const after = await ghStatus(opened.run, opened.gh, 10_000, limits, now);
    expect(after.signIn.state).toBe("signed-in");
    expect(after.signIn.limit).toBeUndefined();
    expect((await opened.calls()).length).toBe(3);
    // A sign-in or sign-out forgets a kept limit.
    await opened.flag("gh.limited", `${resetSeconds + 3600}\n`);
    clock = Date.parse(resetIso) + 2000;
    await ghStatus(opened.run, opened.gh, 10_000, limits, now);
    limits.forget();
    await ghStatus(opened.run, opened.gh, 10_000, limits, now);
    expect((await opened.calls()).length).toBe(7);
    // A secondary limit, which leaves core requests: no reset, kept a
    // minute.
    await opened.flag("gh.limited", "");
    limits.forget();
    const secondary = await ghStatus(
      opened.run,
      opened.gh,
      10_000,
      limits,
      now,
    );
    expect(secondary.signIn.limit).toEqual({});
    clock += 59_000;
    await ghStatus(opened.run, opened.gh, 10_000, limits, now);
    expect((await opened.calls()).length).toBe(9);
    clock += 2000;
    await ghStatus(opened.run, opened.gh, 10_000, limits, now);
    expect((await opened.calls()).length).toBe(11);
  } finally {
    await opened.close();
  }
});

test("an older gh without --json: its text form with GitHub's rate-limit error is signed in with `limit`", async () => {
  const opened = await home();
  try {
    await opened.flag("gh.nojson");
    await opened.flag("gh.limited", `${resetSeconds}\n`);
    const status = await ghStatus(opened.run, opened.gh, 10_000);
    expect(status.signIn).toMatchObject({
      state: "signed-in",
      account: "octocat",
      limit: { reset: resetIso },
    });
  } finally {
    await opened.close();
  }
});

test("the tools' sign-in and the shell's GitHub: a limited gh is signed in, and its SSH is not proved, which would ask GitHub's API again", async () => {
  const opened = await home();
  try {
    await opened.flag("gh.limited", `${resetSeconds}\n`);
    const [signIn] = await toolsSignIn(
      [
        {
          probe: findTool("gh")?.signInProbe,
          status: {
            name: "gh",
            command: "gh",
            installed: true,
            path: opened.gh,
            updater: "none",
            source: "https://github.com/cli/cli#installation",
          },
        },
      ],
      { path: opened.path, home: opened.directory, run: runTool },
    );
    expect(signIn).toEqual({
      state: "signed-in",
      account: "octocat",
      identity: "person",
      limit: { reset: resetIso },
    });
    // Only gh's own status and the free rate_limit: no key list, no meta,
    // no ssh.
    expect(await opened.calls()).toEqual([
      "auth status --json hosts",
      "api rate_limit",
    ]);
    expect(await opened.sshCalls()).toBe(0);
    const probe = createGithubProbe({
      path: opened.path,
      home: opened.directory,
      platform: process.platform,
      run: runTool,
    });
    expect(await probe.state()).toBe("connected");
    // A revoked token (401) is still signed out: "Připojit" belongs there.
    await opened.unflag("gh.limited");
    await opened.flag("gh.unauthorized");
    const [revoked] = await toolsSignIn(
      [
        {
          probe: findTool("gh")?.signInProbe,
          status: {
            name: "gh",
            command: "gh",
            installed: true,
            path: opened.gh,
            updater: "none",
            source: "https://github.com/cli/cli#installation",
          },
        },
      ],
      { path: opened.path, home: opened.directory, run: runTool },
    );
    expect(revoked).toEqual({ state: "signed-out" });
  } finally {
    await opened.close();
  }
}, 30_000);

const limitedIn: ToolSignIn = {
  state: "signed-in",
  account: "octocat",
  identity: "person",
  limit: { reset: resetIso },
};
const reading = (signIn: ToolSignIn) => ({
  revision: 1,
  sharedEnvironment: false,
  tools: [{ name: "gh", installed: true, signIn }],
});

const personalspace: ContentItem = {
  kind: "personalspace",
  login: "octocat",
  state: "absent",
};
const facts = (overrides: Partial<StartFacts> = {}): StartFacts => ({
  preset: "hosted-personal",
  ai: "connected",
  aiReading: { state: "missing", providers: [] },
  github: "limited",
  githubLogin: "octocat",
  githubLimitTime: "22:06",
  content: { state: "missing", item: personalspace },
  list: { allowed: true, items: [personalspace] },
  ...overrides,
});

test("Začínáme: a limited GitHub stays done with why and when, offers nothing to connect, and the personal space waits for it", () => {
  expect(githubFact(reading(limitedIn), 1)).toBe("limited");
  expect(githubLimitReset(reading(limitedIn))).toBe(resetIso);
  expect(githubLimitReset(reading({ ...limitedIn, limit: {} }))).toBeNull();
  expect(
    githubLimitReset(reading({ state: "signed-in", account: "octocat" })),
  ).toBeUndefined();

  const view = startView(facts(), cs);
  expect(view?.steps[1]).toEqual({
    basic: "github",
    mark: "done",
    title: "GitHub",
    status:
      "Připojeno jako @octocat. GitHub teď odmítá požadavky, protože je vyčerpaný hodinový limit. Obnoví se v 22:06, nic znovu nepřipojujte.",
  });
  expect(view?.github).toBeNull();
  expect(view?.steps[2]).toMatchObject({
    basic: "content",
    mark: "later",
    status: "Čeká, až GitHub obnoví hodinový limit.",
  });
  // The count does not drop: AI and GitHub are done.
  expect(view?.done).toBe(2);
  expect(startCount(facts())).toBe("2/3");
  expect(startCount(facts({ github: "missing" }))).toBe("1/3");
  // Without a reset, and in English.
  expect(
    startView(facts({ githubLimitTime: null }), cs)?.steps[1]?.status,
  ).toBe(
    "Připojeno jako @octocat. GitHub teď odmítá požadavky, protože je vyčerpaný hodinový limit. Obnoví se sám, nic znovu nepřipojujte.",
  );
  expect(startView(facts(), en)?.steps[1]?.status).toBe(
    "Connected as @octocat. GitHub refuses requests for now because the hourly limit is used up. It resets at 22:06; there is nothing to connect again.",
  );
  // A run the limit stopped waits too, instead of showing a failure.
  expect(
    startView(
      facts({
        content: {
          state: "failed",
          item: personalspace,
          job: { state: "failed", steps: [] },
        } as never,
      }),
      cs,
    )?.steps[2],
  ).toMatchObject({ mark: "later" });

  expect(basicState(facts(), "github")).toBe("done");
  expect(contentBlockedBy(facts())).toBe("github-limit");
  expect(startDecision("sign-in-gh", facts())).toBe("drop");
  expect(startDecision("install-content", facts())).toBe("drop");
  expect(
    contentView({ allowed: true, items: [personalspace] }, null, cs, {
      github: "limited",
      blockedBy: "github-limit",
    }),
  ).toMatchObject({
    action: null,
    note: "Spustí se samo, až GitHub obnoví hodinový limit.",
  });
  expect(appsSetupLine(facts(), cs)).toEqual({
    tone: "info",
    icon: "key",
    text: "GitHub teď odmítá požadavky, protože je vyčerpaný hodinový limit. Příprava se spustí sama, až se limit obnoví.",
    actions: [{ action: "open-start", label: cs.setupShow }],
  });
  expect(
    shellSetup({
      preset: "hosted-personal",
      ai: "connected",
      github: "limited",
      list: { allowed: true, items: [personalspace] },
      job: null,
    })?.github,
  ).toBe("connected");
});

test("Nástroje: a limited gh shows its account and why, in no success colour, and offers no SSH link", () => {
  const gh: ToolOverview = {
    name: "gh",
    command: "gh",
    tier: "required",
    setup: "launchpad",
    enabled: true,
    offered: true,
    purpose: "Purpose.",
    usage: "Usage.",
    source: "https://github.com/cli/cli",
    installed: true,
    prompt: "Task.",
    signIn: limitedIn,
  };
  const time = clockTime(resetIso, "cs");
  expect(connectionLine(gh, cs, false, "cs")).toEqual({
    text: "Připojeno jako octocat",
    state: "limited",
    ssh: `GitHub do ${time} odmítá požadavky, hodinový limit je vyčerpaný`,
  });
  expect(
    connectionLine({ ...gh, signIn: { ...limitedIn, limit: {} } }, en),
  ).toMatchObject({
    ssh: "GitHub refuses requests for now: the hourly limit is used up",
  });
  expect(curatedActions(gh, cs)).toMatchObject({
    primary: null,
    logout: true,
    linkSsh: false,
  });
});

test("the content waits for the limit and starts by itself once GitHub answers again", () => {
  const limited = facts();
  const first = autoStartStep(
    { ai: null, github: null, armed: false },
    limited,
    false,
  );
  expect(first.start).toBe(false);
  const waiting = autoStartStep(first.state, limited, false);
  expect(waiting.start).toBe(false);
  const reset = autoStartStep(
    waiting.state,
    { ...facts(), github: "connected" },
    false,
  );
  expect(reset.start).toBe(true);
});

// Pablo's review of #1224 (3): a check that never reached GitHub says
// nothing about the sign-in, so it is unknown and offers no sign-in; only
// GitHub's 4xx other than the limit is signed out.
test("gh's check that never reached GitHub is unknown, a 4xx answer is signed out, the limit is limited", async () => {
  expect(
    checkFailure(
      'Get "https://api.github.com/": dial tcp: lookup api.github.com: no such host',
    ),
  ).toBe("unreachable");
  expect(checkFailure("HTTP 502: Bad Gateway (https://api.github.com/)")).toBe(
    "unreachable",
  );
  expect(
    checkFailure("error connecting to api.github.com: dial tcp: i/o timeout"),
  ).toBe("unreachable");
  expect(
    checkFailure("HTTP 401: Bad credentials (https://api.github.com/)"),
  ).toBe("rejected");
  expect(checkFailure("HTTP 403: API rate limit exceeded for user ID 1.")).toBe(
    "limited",
  );
  expect(
    readGhJsonStatus(
      entry({
        state: "error",
        error: "error connecting to api.github.com: dial tcp: i/o timeout",
      }),
    ),
  ).toEqual({ signIn: { state: "unknown" }, scopes: undefined });
  const opened = await home();
  try {
    await opened.flag("gh.unreachable");
    expect((await ghStatus(opened.run, opened.gh, 10_000)).signIn).toEqual({
      state: "unknown",
    });
    await opened.unflag("gh.unreachable");
    await opened.flag("gh.unauthorized");
    expect((await ghStatus(opened.run, opened.gh, 10_000)).signIn).toEqual({
      state: "signed-out",
    });
  } finally {
    await opened.close();
  }
});

// Pablo's review of #1224 (2): a run stopped while GitHub refused requests
// for its limit waits on Začínáme, and runs once more when GitHub answers;
// a stop GitHub's limit did not hold is never started again by itself.
test("a run the limit stopped runs once more when GitHub answers again; another stop does not", () => {
  const failed = {
    state: "failed",
    item: personalspace,
    job: { state: "failed", steps: [] },
  } as never;
  const limited = facts({ content: failed });
  const seen = autoStartStep(
    { ai: true, github: true, armed: false },
    limited,
    false,
  );
  expect(seen.start).toBe(false);
  expect(seen.state.limitStop).toBe(true);
  // Still limited on the next reading, and while a run is under way.
  const still = autoStartStep(seen.state, limited, false);
  expect(still.start).toBe(false);
  const answered = {
    ...facts({ content: failed }),
    github: "connected" as const,
  };
  expect(autoStartStep(still.state, answered, true).start).toBe(false);
  const reset = autoStartStep(still.state, answered, false);
  expect(reset.start).toBe(true);
  expect(reset.state.limitStop).toBeUndefined();
  // Once: the same stop afterwards is not started again.
  expect(autoStartStep(reset.state, answered, false).start).toBe(false);
  // A stop seen only with GitHub connected is never retried by itself.
  expect(
    autoStartStep({ ai: true, github: true, armed: true }, answered, false)
      .start,
  ).toBe(false);
});

// Pablo's review of #1224 (1): a page left open reads GitHub again at the
// reset, without a manual refresh.
test("the page reads GitHub again at the limit's reset, a minute without one, and stops once GitHub answers", () => {
  const at = Date.parse(resetIso);
  expect(limitRefreshDelay(undefined, at)).toBeNull();
  expect(limitRefreshDelay(null, at)).toBe(60_000);
  expect(limitRefreshDelay(resetIso, at - 10 * 60_000)).toBe(
    10 * 60_000 + 2000,
  );
  // A page clock ahead of the reset asks again in 15 s, not at once.
  expect(limitRefreshDelay(resetIso, at + 60_000)).toBe(15_000);
  expect(limitRefreshDelay(resetIso, at - 5 * 60 * 60_000)).toBe(60 * 60_000);

  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  let refreshed = 0;
  const refresh = createLimitRefresh({
    refresh: () => {
      refreshed += 1;
    },
    now: () => at - 60_000,
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });
  refresh.observe(resetIso);
  expect(timers.map((timer) => timer.ms)).toEqual([62_000]);
  // Another reading of the same limit replaces the timer: one at most.
  refresh.observe(resetIso);
  expect(timers.map((timer) => timer.cleared)).toEqual([true, false]);
  timers[1]?.run();
  expect(refreshed).toBe(1);
  // GitHub answers: no timer any more.
  refresh.observe(undefined);
  expect(timers.length).toBe(2);
});
