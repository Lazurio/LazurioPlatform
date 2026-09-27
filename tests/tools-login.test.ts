import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  challengeUrl,
  createLoginSessions,
  type LoginEnvironment,
  type LoginState,
  normalizePhone,
  parseComposioOrganizations,
} from "../src/tools/login";
import { runTool } from "../src/tools/status";
import { fakeCodes, fakeLoginTools } from "./fixtures/fake-login-tools";

const posix = process.platform !== "win32";

async function home(tools?: Parameters<typeof fakeLoginTools>[1]) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-login-")),
  );
  const path = await fakeLoginTools(directory, tools);
  const environment: LoginEnvironment = {
    path,
    home: directory,
    xdg: { XDG_CONFIG_HOME: join(directory, ".config") },
    platform: process.platform,
    run: runTool,
    firstChallengeMs: 5_000,
    probeIntervalMs: 50,
  };
  return {
    directory,
    environment,
    approve: () => writeFile(join(directory, "approve"), ""),
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// Polls the holder's session until it is no longer pending.
async function settle(
  sessions: ReturnType<typeof createLoginSessions>,
  tool: string,
  handle: string,
  limitMs = 10_000,
): Promise<LoginState> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    await sessions.changed(tool, handle, 100);
    const state = sessions.poll(tool, handle);
    if (state.kind !== "pending") return state;
    if (Date.now() > deadline) throw new Error("Session did not settle");
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await Bun.sleep(25);
  }
}

// Every file under the home except the fake tools' own stores (a real tool
// keeps its pending login or session there, which is the tool's custody).
async function lazurioFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if ([".composio", ".wacli", "bin"].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk(directory);
  return files;
}

async function assertNoChallengeStored(directory: string) {
  for (const file of await lazurioFiles(directory)) {
    const contents = await readFile(file, "utf8");
    for (const secret of Object.values(fakeCodes))
      expect(contents.includes(secret)).toBe(false);
  }
}

test("a challenge URL is only https on exactly the expected host", () => {
  expect(challengeUrl("https://github.com/login/device", ["github.com"])).toBe(
    "https://github.com/login/device",
  );
  for (const url of [
    "http://github.com/login/device",
    "https://github.com.evil.example/login/device",
    "https://user@github.com/login/device",
    "https://github.com:8443/login/device",
    "https://evil.example/?next=https://github.com",
    "javascript:alert(1)",
    "not a url",
  ])
    expect(challengeUrl(url, ["github.com"])).toBeUndefined();
});

test("a phone number becomes + and digits, or is refused", () => {
  expect(normalizePhone("+420 123 456 789")).toBe("+420123456789");
  expect(normalizePhone("(1) 234-567-8900")).toBe("+12345678900");
  for (const bad of [
    "",
    "123",
    "+0123456789",
    "12a4567890",
    "+1234567890123456",
  ])
    expect(normalizePhone(bad)).toBeUndefined();
});

test("composio organizations are read only in their exact form", () => {
  expect(
    parseComposioOrganizations(
      'noise\n[{"id":"org_1","name":"First","is_selected_global_org":true},{"id":"org_2","name":"Second\\u202e","is_selected_global_org":false}]\n',
    ),
  ).toEqual([
    { id: "org_1", name: "First", current: true },
    { id: "org_2", name: "Second", current: false },
  ]);
  expect(parseComposioOrganizations("")).toBeUndefined();
  expect(
    parseComposioOrganizations('[{"id":"../x","name":"A"}]'),
  ).toBeUndefined();
  expect(
    parseComposioOrganizations('[{"id":"a","name":"A"},{"id":"a","name":"B"}]'),
  ).toBeUndefined();
});

test.skipIf(!posix)(
  "gh: the device code and page as the challenge, no clipboard, signed in when the probe confirms",
  async () => {
    const opened = await home(["gh"]);
    const sessions = createLoginSessions(opened.environment);
    try {
      const started = await sessions.start("gh");
      expect(started).toMatchObject({
        kind: "pending",
        tool: "gh",
        challenge: {
          kind: "device-code",
          url: "https://github.com/login/device",
          code: fakeCodes.gh,
        },
      });
      if (started.kind !== "pending") throw new Error("not pending");
      // Exactly the documented command, the clipboard off for this run.
      const calls = await readFile(join(opened.directory, "gh.calls"), "utf8");
      expect(calls.trim()).toBe(
        "auth login --hostname github.com --git-protocol ssh --web --clipboard=false",
      );
      // Another handle sees nothing.
      expect(sessions.poll("gh", "0".repeat(32))).toEqual({
        kind: "none",
        tool: "gh",
      });
      await opened.approve();
      expect(await settle(sessions, "gh", started.session)).toEqual({
        kind: "signed-in",
        tool: "gh",
        account: "octocat",
      });
      // The outcome is read once; then the session is gone.
      expect(sessions.poll("gh", started.session).kind).toBe("none");
      await assertNoChallengeStored(opened.directory);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "gh: a page that is not https://github.com/login/device ends the session",
  async () => {
    for (const url of [
      "https://github.evil.example/login/device",
      "http://github.com/login/device",
      "https://github.com/login/oauth/authorize?client_id=x",
    ]) {
      const opened = await home(["gh"]);
      await writeFile(join(opened.directory, "gh.url"), url);
      const sessions = createLoginSessions(opened.environment);
      try {
        const started = await sessions.start("gh");
        expect(started).toEqual({
          kind: "failed",
          tool: "gh",
          reason: "unexpected-url",
        });
        // The helper process of the refused tool is gone too.
        const child = Number(
          await readFile(join(opened.directory, "gh.child"), "utf8"),
        );
        await waitFor(() => !alive(child));
      } finally {
        await sessions.close();
        await opened.close();
      }
    }
  },
);

test.skipIf(!posix)(
  "gh: cancel kills the tool's whole process group; a new start replaces a running one",
  async () => {
    const opened = await home(["gh"]);
    const sessions = createLoginSessions(opened.environment);
    try {
      const first = await sessions.start("gh");
      if (first.kind !== "pending") throw new Error("not pending");
      const child = Number(
        await readFile(join(opened.directory, "gh.child"), "utf8"),
      );
      expect(alive(child)).toBe(true);
      const second = await sessions.start("gh");
      if (second.kind !== "pending") throw new Error("not pending");
      expect(second.session).not.toBe(first.session);
      await waitFor(() => !alive(child));
      // The replaced holder learns nothing more.
      expect(sessions.poll("gh", first.session).kind).toBe("none");
      const again = Number(
        await readFile(join(opened.directory, "gh.child"), "utf8"),
      );
      expect(sessions.cancel("gh", second.session)).toEqual({
        kind: "cancelled",
        tool: "gh",
      });
      await waitFor(() => !alive(again));
      expect(sessions.poll("gh", second.session).kind).toBe("none");
      expect(sessions.cancel("gh", second.session).kind).toBe("none");
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "an unfinished session expires at its lifetime and its process group is killed",
  async () => {
    const opened = await home(["gh"]);
    const sessions = createLoginSessions({
      ...opened.environment,
      lifetimes: { gh: 400 },
    });
    try {
      const started = await sessions.start("gh");
      if (started.kind !== "pending") throw new Error("not pending");
      const child = Number(
        await readFile(join(opened.directory, "gh.child"), "utf8"),
      );
      expect(await settle(sessions, "gh", started.session)).toEqual({
        kind: "expired",
        tool: "gh",
      });
      await waitFor(() => !alive(child));
      await assertNoChallengeStored(opened.directory);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "gh: a tool that ends without a sign-in is a failure, a missing tool is not-installed",
  async () => {
    const opened = await home(["gh"]);
    await writeFile(join(opened.directory, "gh.fail"), "");
    const sessions = createLoginSessions(opened.environment);
    try {
      const started = await sessions.start("gh");
      if (started.kind !== "pending") throw new Error("not pending");
      await opened.approve();
      expect(await settle(sessions, "gh", started.session)).toEqual({
        kind: "failed",
        tool: "gh",
        reason: "tool-exit",
      });
      expect(await sessions.start("wacli")).toEqual({
        kind: "failed",
        tool: "wacli",
        reason: "not-installed",
      });
      await expect(sessions.start("neon")).rejects.toThrow();
      await expect(sessions.start("gogcli")).rejects.toThrow();
      await expect(
        sessions.start("gh", { phone: "+420123456789" }),
      ).rejects.toThrow();
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "composio: the dashboard link as the challenge, then the poll step, the organization choice",
  async () => {
    const opened = await home(["composio"]);
    const sessions = createLoginSessions(opened.environment);
    try {
      const started = await sessions.start("composio");
      expect(started).toMatchObject({
        kind: "pending",
        challenge: {
          kind: "url",
          url: `https://dashboard.composio.dev/?cliKey=${fakeCodes.composioKey}`,
        },
      });
      if (started.kind !== "pending") throw new Error("not pending");
      await opened.approve();
      expect(await settle(sessions, "composio", started.session)).toEqual({
        kind: "signed-in",
        tool: "composio",
        account: "op@example.com",
        organization: "First",
      });
      const calls = (
        await readFile(join(opened.directory, "composio.calls"), "utf8")
      )
        .trim()
        .split("\n");
      expect(calls.slice(0, 2)).toEqual([
        "login --no-wait --no-skill-install",
        "login --poll --no-skill-install",
      ]);
      expect(await sessions.composioOrganizations()).toEqual({
        kind: "composio-organizations",
        organizations: [
          { id: "org_1", name: "First", current: true },
          { id: "org_2", name: "Second", current: false },
        ],
      });
      expect(await sessions.selectComposioOrganization("org_2")).toEqual({
        kind: "composio-organization-selected",
        id: "org_2",
        organization: "Second",
      });
      expect(await sessions.selectComposioOrganization("org_9")).toEqual({
        kind: "composio-organization-failed",
        reason: "unknown-organization",
      });
      await assertNoChallengeStored(opened.directory);
      expect(await sessions.logout("composio")).toEqual({
        kind: "logged-out",
        tool: "composio",
        revocation: "local-only",
      });
      expect((await sessions.composioOrganizations()).kind).toBe(
        "composio-organizations-failed",
      );
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "composio: a link on another host is refused and never becomes a challenge",
  async () => {
    const opened = await home(["composio"]);
    await writeFile(
      join(opened.directory, "composio.url"),
      "https://dashboard.composio.dev.evil.example/?cliKey=x",
    );
    const sessions = createLoginSessions(opened.environment);
    try {
      expect(await sessions.start("composio")).toEqual({
        kind: "failed",
        tool: "composio",
        reason: "unexpected-url",
      });
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "wacli: rotating QR codes replace each other; signed in on the probe; the first sync runs on",
  async () => {
    const opened = await home(["wacli"]);
    const sessions = createLoginSessions(opened.environment);
    try {
      const started = await sessions.start("wacli");
      expect(started).toMatchObject({
        kind: "pending",
        challenge: { kind: "qr", payload: fakeCodes.qrFirst, sequence: 1 },
      });
      if (started.kind !== "pending") throw new Error("not pending");
      await writeFile(join(opened.directory, "rotate"), "");
      await waitFor(() => {
        const state = sessions.poll("wacli", started.session);
        return (
          state.kind === "pending" &&
          state.challenge?.kind === "qr" &&
          state.challenge.sequence === 2
        );
      });
      expect(sessions.poll("wacli", started.session)).toMatchObject({
        challenge: { kind: "qr", payload: fakeCodes.qrSecond, sequence: 2 },
      });
      const args = (
        await readFile(join(opened.directory, "wacli.calls"), "utf8")
      ).split("\n")[0];
      expect(args).toBe("auth --events --idle-exit 30s");
      await opened.approve();
      expect(await settle(sessions, "wacli", started.session)).toEqual({
        kind: "signed-in",
        tool: "wacli",
        account: "420123456789",
      });
      // The pairing process still runs its bootstrap sync.
      const child = Number(
        await readFile(join(opened.directory, "wacli.child"), "utf8"),
      );
      expect(alive(child)).toBe(true);
      let settled = false;
      const done = sessions.settled().then(() => {
        settled = true;
      });
      await Bun.sleep(100);
      expect(settled).toBe(false);
      await writeFile(join(opened.directory, "synced"), "");
      await done;
      await assertNoChallengeStored(opened.directory);
      expect(await sessions.logout("wacli")).toEqual({
        kind: "logged-out",
        tool: "wacli",
        revocation: "remote",
      });
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "wacli: pairing with a phone number yields the pairing code; an invalid number is refused",
  async () => {
    const opened = await home(["wacli"]);
    const sessions = createLoginSessions({
      ...opened.environment,
      backgroundMs: 200,
    });
    try {
      expect(await sessions.start("wacli", { phone: "12" })).toEqual({
        kind: "failed",
        tool: "wacli",
        reason: "invalid-phone",
      });
      const started = await sessions.start("wacli", {
        phone: "+420 123 456 789",
      });
      expect(started).toMatchObject({
        kind: "pending",
        challenge: {
          kind: "pair-code",
          phone: "+420123456789",
          code: fakeCodes.pair,
          sequence: 1,
        },
      });
      if (started.kind !== "pending") throw new Error("not pending");
      expect(
        (await readFile(join(opened.directory, "wacli.calls"), "utf8")).trim(),
      ).toBe("auth --events --idle-exit 30s --phone +420123456789");
      await opened.approve();
      expect((await settle(sessions, "wacli", started.session)).kind).toBe(
        "signed-in",
      );
      // The background sync is bounded: here 200 ms, then its group is killed.
      const child = Number(
        await readFile(join(opened.directory, "wacli.child"), "utf8"),
      );
      await waitFor(() => !alive(child));
      await sessions.settled();
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "closing the owner drops every session and kills every process, background included",
  async () => {
    const opened = await home();
    const sessions = createLoginSessions(opened.environment);
    try {
      const gh = await sessions.start("gh");
      const wacli = await sessions.start("wacli");
      if (gh.kind !== "pending" || wacli.kind !== "pending")
        throw new Error("not pending");
      const children = await Promise.all(
        ["gh.child", "wacli.child"].map(async (file) =>
          Number(await readFile(join(opened.directory, file), "utf8")),
        ),
      );
      await sessions.close();
      for (const child of children) await waitFor(() => !alive(child));
      expect(sessions.poll("gh", gh.session).kind).toBe("none");
      await expect(sessions.start("gh")).rejects.toThrow();
      await assertNoChallengeStored(opened.directory);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "logout of gh forgets the sign-in on this Machine only",
  async () => {
    const opened = await home(["gh"]);
    await mkdir(join(opened.directory, ".config"), { recursive: true });
    await writeFile(join(opened.directory, "gh.state"), "octocat\n");
    const sessions = createLoginSessions(opened.environment);
    try {
      expect(await sessions.logout("gh")).toEqual({
        kind: "logged-out",
        tool: "gh",
        revocation: "local-only",
      });
      const calls = await readFile(join(opened.directory, "gh.calls"), "utf8");
      expect(calls).toContain("auth logout --hostname github.com");
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);
