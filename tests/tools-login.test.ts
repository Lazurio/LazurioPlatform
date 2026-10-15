import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activatableTools } from "../src/tools/catalog";
import {
  challengeUrl,
  createLoginSessions,
  type LoginEnvironment,
  type LoginState,
  normalizePhone,
  parseComposioOrganizations,
} from "../src/tools/login";
import { runTool, toolsSignIn } from "../src/tools/status";
import {
  fakeCodes,
  fakeLoginTools,
  realSshKeygen,
} from "./fixtures/fake-login-tools";
import { runChild } from "./fixtures/run-child";

const posix = process.platform !== "win32";
// The gh sign-in links an SSH key, which needs ssh-keygen.
const keygen = posix && realSshKeygen !== null;

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
    machine: "vm-01",
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

test.skipIf(!keygen)(
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
        "auth login --hostname github.com --git-protocol ssh --web --scopes admin:public_key --clipboard=false",
      );
      // Another handle sees nothing.
      expect(sessions.poll("gh", "0".repeat(32))).toEqual({
        kind: "none",
        tool: "gh",
      });
      await opened.approve();
      expect(await settle(sessions, "gh", started.session)).toMatchObject({
        kind: "signed-in",
        tool: "gh",
        account: "octocat",
        ssh: { state: "linked" },
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
  "gh older than the clipboard flag: the flow runs once more without it",
  async () => {
    const opened = await home(["gh"]);
    await writeFile(join(opened.directory, "gh.old"), "");
    const sessions = createLoginSessions(opened.environment);
    try {
      const started = await sessions.start("gh");
      expect(started).toMatchObject({
        kind: "pending",
        challenge: { kind: "device-code", code: fakeCodes.gh },
      });
      const calls = (await readFile(join(opened.directory, "gh.calls"), "utf8"))
        .trim()
        .split("\n");
      expect(calls).toEqual([
        "auth login --hostname github.com --git-protocol ssh --web --scopes admin:public_key --clipboard=false",
        "auth login --hostname github.com --git-protocol ssh --web --scopes admin:public_key",
      ]);
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
      lifetimes: { gh: 1_500 },
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
  "composio: the first step is a process of the session and ends with it",
  async () => {
    const opened = await home(["composio"]);
    await writeFile(join(opened.directory, "composio.hang"), "");
    const sessions = createLoginSessions(opened.environment);
    try {
      const started = sessions.start("composio");
      const marker = join(opened.directory, "composio.first");
      await waitFor(async () => {
        try {
          await readFile(marker, "utf8");
          return true;
        } catch {
          return false;
        }
      });
      const first = Number(await readFile(marker, "utf8"));
      expect(alive(first)).toBe(true);
      // A new start replaces the running login; its first step goes too.
      await rm(join(opened.directory, "composio.hang"));
      const second = await sessions.start("composio");
      await waitFor(() => !alive(first));
      expect((await started).kind).not.toBe("signed-in");
      if (second.kind !== "pending") throw new Error("not pending");
      expect(sessions.cancel("composio", second.session)).toEqual({
        kind: "cancelled",
        tool: "composio",
      });
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
        sshKey: { state: "no-key" },
      });
      const calls = await readFile(join(opened.directory, "gh.calls"), "utf8");
      expect(calls).toContain("auth logout --hostname github.com");
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

// ---------------------------------------------------------------------------
// The SSH key of the gh sign-in (decision F19, addendum 2026-09-28). The real
// ssh-keygen runs only on files under the temporary home; gh and ssh are
// fakes on a PATH without system directories.

async function makeKey(
  directory: string,
  name: string,
  options: Readonly<{ type?: string; passphrase?: string }> = {},
) {
  const path = join(directory, ".ssh", name);
  const result = await runChild(
    [
      realSshKeygen as string,
      "-q",
      "-t",
      options.type ?? "ed25519",
      ...(options.type === "rsa" ? ["-b", "2048"] : []),
      "-N",
      options.passphrase ?? "",
      "-C",
      "test",
      "-f",
      path,
    ],
    { env: { HOME: directory } },
  );
  if (result.exitCode !== 0) throw new Error("ssh-keygen failed");
  return path;
}

async function sshHome() {
  const opened = await home(["gh"]);
  await mkdir(join(opened.directory, ".ssh"), { recursive: true, mode: 0o700 });
  return opened;
}

const publicKey = async (path: string) =>
  (await readFile(`${path}.pub`, "utf8"))
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");

// No private key and no public key blob in anything returned.
async function assertNoKeyMaterial(directory: string, value: unknown) {
  const text = JSON.stringify(value);
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const path = join(directory, ".ssh", name);
    let privateKey: string;
    try {
      privateKey = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const line of privateKey.split("\n"))
      if (line.length > 20 && !line.startsWith("-----"))
        expect(text.includes(line)).toBe(false);
    const blob = (await publicKey(path)).split(" ")[1] as string;
    expect(text.includes(blob)).toBe(false);
  }
}

async function signInGh(
  opened: Awaited<ReturnType<typeof home>>,
  sessions: ReturnType<typeof createLoginSessions>,
) {
  const started = await sessions.start("gh");
  if (started.kind !== "pending") throw new Error("not pending");
  await opened.approve();
  return settle(sessions, "gh", started.session);
}

const keyLines = async (directory: string) =>
  (await readFile(join(directory, "gh.keys"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

test.skipIf(!keygen)(
  "gh on a fresh Machine: a new ed25519 key, registered, GitHub's host keys, the proof; linking is a step of its own",
  async () => {
    const opened = await home(["gh"]);
    // The proof hangs until the test lets it go, so the linking step is seen.
    await writeFile(join(opened.directory, "hang.ssh"), "");
    const sessions = createLoginSessions(opened.environment);
    try {
      const started = await sessions.start("gh");
      if (started.kind !== "pending") throw new Error("not pending");
      await opened.approve();
      await waitFor(async () => {
        try {
          await readFile(join(opened.directory, "hang.pid"), "utf8");
          return true;
        } catch {
          return false;
        }
      });
      const linking = sessions.poll("gh", started.session);
      expect(linking).toMatchObject({ kind: "pending", step: "ssh-key" });
      // The device code is gone once signed in.
      expect("challenge" in linking).toBe(false);
      await rm(join(opened.directory, "hang.ssh"));
      process.kill(
        Number(await readFile(join(opened.directory, "hang.pid"), "utf8")),
      );
      const state = await settle(sessions, "gh", started.session);
      const key = join(opened.directory, ".ssh", "id_ed25519");
      if (state.kind !== "signed-in" || state.ssh?.state !== "linked")
        throw new Error(`not linked: ${JSON.stringify(state)}`);
      expect(state).toEqual({
        kind: "signed-in",
        tool: "gh",
        account: "octocat",
        ssh: {
          state: "linked",
          key: {
            path: key,
            fingerprint: state.ssh.key.fingerprint,
            created: true,
          },
          registration: "added",
          knownHosts: "added",
        },
      });
      // The fingerprint is the one ssh-keygen prints.
      const listed = await runChild([
        realSshKeygen as string,
        "-l",
        "-f",
        `${key}.pub`,
      ]);
      expect(listed.stdout.split(" ")[1]).toBe(state.ssh.key.fingerprint);
      expect((await stat(join(opened.directory, ".ssh"))).mode & 0o777).toBe(
        0o700,
      );
      expect((await stat(key)).mode & 0o777).toBe(0o600);
      expect(await readFile(`${key}.pub`, "utf8")).toContain("lazurio@vm-01");
      // Registered once, titled with Lazurio and the Machine.
      expect(await keyLines(opened.directory)).toEqual([
        `101\tLazurio: vm-01\t${await publicKey(key)}`,
      ]);
      expect(
        (await readFile(join(opened.directory, ".ssh", "known_hosts"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => line.split(" ")[0]),
      ).toEqual(["github.com", "github.com", "github.com"]);
      expect(
        (await readFile(join(opened.directory, "ssh.calls"), "utf8")).trim(),
      ).toBe(
        "-T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 git@github.com",
      );
      const calls = await readFile(join(opened.directory, "gh.calls"), "utf8");
      expect(calls).toContain(
        `ssh-key add ${key}.pub --title Lazurio: vm-01 --type authentication`,
      );
      expect(calls).toContain("api meta --jq .ssh_keys");
      await assertNoKeyMaterial(opened.directory, state);
      // The sign-in probe now says the key is linked, without the network
      // beyond gh's own calls.
      const probe = activatableTools().find((tool) => tool.name === "gh")
        ?.activation.signInProbe;
      const [signIn] = await toolsSignIn(
        [
          {
            probe,
            status: {
              name: "gh",
              command: "gh",
              installed: true,
              path: join(opened.directory, ".local", "bin", "gh"),
              updater: "none",
              source: "https://github.com/cli/cli#installation",
            },
          },
        ],
        {
          path: opened.environment.path,
          home: opened.directory,
          run: runTool,
        },
      );
      expect(signIn).toEqual({
        state: "signed-in",
        account: "octocat",
        ssh: { state: "linked", fingerprint: state.ssh.key.fingerprint },
        identity: "person",
      });
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!keygen)(
  "gh: an existing default key is used byte for byte; a key already on the account is not added twice",
  async () => {
    const opened = await sshHome();
    const key = await makeKey(opened.directory, "id_ed25519");
    const before = {
      private: await readFile(key),
      public: await readFile(`${key}.pub`),
      mtime: (await stat(key)).mtimeMs,
    };
    await writeFile(
      join(opened.directory, "gh.keys"),
      `7\tMy laptop\t${await publicKey(key)}\n`,
    );
    const sessions = createLoginSessions(opened.environment);
    try {
      const state = await signInGh(opened, sessions);
      expect(state).toMatchObject({
        kind: "signed-in",
        ssh: {
          state: "linked",
          key: { path: key, created: false },
          registration: "already-registered",
        },
      });
      expect(await readFile(key)).toEqual(before.private);
      expect(await readFile(`${key}.pub`)).toEqual(before.public);
      expect((await stat(key)).mtimeMs).toBe(before.mtime);
      expect((await readdir(join(opened.directory, ".ssh"))).sort()).toEqual([
        "id_ed25519",
        "id_ed25519.pub",
        "known_hosts",
      ]);
      expect(await keyLines(opened.directory)).toHaveLength(1);
      const keygenCalls = await readFile(
        join(opened.directory, "ssh-keygen.calls"),
        "utf8",
      );
      expect(keygenCalls).not.toContain("-t ed25519");
      await assertNoKeyMaterial(opened.directory, state);
      // Sign-out keeps a key the operator registered by hand.
      const out = await sessions.logout("gh");
      expect(out).toMatchObject({
        kind: "logged-out",
        sshKey: { state: "kept-not-lazurio" },
      });
      expect(await keyLines(opened.directory)).toHaveLength(1);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!keygen)(
  "gh: a public key file without its private key is never overwritten and no key is created",
  async () => {
    for (const name of ["id_ed25519", "id_rsa"]) {
      const opened = await sshHome();
      const made = await makeKey(opened.directory, name);
      const orphan = await readFile(`${made}.pub`);
      await rm(made);
      const sessions = createLoginSessions(opened.environment);
      try {
        const state = await signInGh(opened, sessions);
        expect(state).toMatchObject({
          kind: "signed-in",
          ssh: {
            state: "not-linked",
            reason: "key-incomplete",
            fallback: "agent",
          },
        });
        expect(await readdir(join(opened.directory, ".ssh"))).toEqual([
          `${name}.pub`,
        ]);
        expect(await readFile(`${made}.pub`)).toEqual(orphan);
        expect(await keyLines(opened.directory)).toEqual([]);
      } finally {
        await sessions.close();
        await opened.close();
      }
    }
  },
);

test.skipIf(!keygen)(
  "gh: a key in use by another account is reported and no second key is created",
  async () => {
    const opened = await sshHome();
    const key = await makeKey(opened.directory, "id_ed25519");
    const bytes = await readFile(key);
    await writeFile(
      join(opened.directory, "gh.foreign"),
      `${await publicKey(key)}\n`,
    );
    const sessions = createLoginSessions(opened.environment);
    try {
      const state = await signInGh(opened, sessions);
      expect(state).toMatchObject({
        kind: "signed-in",
        account: "octocat",
        ssh: {
          state: "not-linked",
          reason: "key-in-use",
          key: { path: key, created: false },
          fallback: "agent",
        },
      });
      expect((await readdir(join(opened.directory, ".ssh"))).sort()).toEqual([
        "id_ed25519",
        "id_ed25519.pub",
      ]);
      expect(await readFile(key)).toEqual(bytes);
      expect(await keyLines(opened.directory)).toEqual([]);
      await assertNoKeyMaterial(opened.directory, state);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!keygen)(
  "gh: a github.com entry that differs from the published keys stops everything; a hashed matching entry is kept",
  async () => {
    const opened = await sshHome();
    // A different host key for github.com, hashed as HashKnownHosts writes it.
    const other = await makeKey(opened.directory, "other", { type: "ecdsa" });
    const knownHosts = join(opened.directory, ".ssh", "known_hosts");
    await writeFile(knownHosts, `github.com ${await publicKey(other)}\n`);
    await runChild([realSshKeygen as string, "-H", "-f", knownHosts], {
      env: { HOME: opened.directory },
    });
    await rm(`${knownHosts}.old`, { force: true });
    await rm(other);
    await rm(`${other}.pub`);
    const hashed = await readFile(knownHosts, "utf8");
    expect(hashed.startsWith("|1|")).toBe(true);
    const sessions = createLoginSessions(opened.environment);
    try {
      const state = await signInGh(opened, sessions);
      expect(state).toMatchObject({
        kind: "signed-in",
        ssh: { state: "not-linked", reason: "host-key-mismatch" },
      });
      expect(await readFile(knownHosts, "utf8")).toBe(hashed);
      await expect(
        readFile(join(opened.directory, "ssh.calls"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await sessions.close();
      await opened.close();
    }
    // The published ed25519 key, hashed: recognized, the other two added.
    const second = await sshHome();
    const file = join(second.directory, ".ssh", "known_hosts");
    await writeFile(
      file,
      "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    );
    await runChild([realSshKeygen as string, "-H", "-f", file], {
      env: { HOME: second.directory },
    });
    await rm(`${file}.old`, { force: true });
    const kept = (await readFile(file, "utf8")).trim();
    const again = createLoginSessions(second.environment);
    try {
      expect(await signInGh(second, again)).toMatchObject({
        ssh: { state: "linked", knownHosts: "added" },
      });
      const lines = (await readFile(file, "utf8")).trim().split("\n");
      expect(lines[0]).toBe(kept);
      expect(lines.slice(1).map((line) => line.split(" ")[1])).toEqual([
        "ecdsa-sha2-nistp256",
        "ssh-rsa",
      ]);
    } finally {
      await again.close();
      await second.close();
    }
  },
);

test.skipIf(!keygen)(
  "Link SSH key: a gh signed in by hand without the scope gets a refresh code, then the key is linked",
  async () => {
    const opened = await sshHome();
    await writeFile(join(opened.directory, "gh.state"), "octocat\n");
    await writeFile(
      join(opened.directory, "gh.scopes"),
      "gist read:org repo\n",
    );
    const sessions = createLoginSessions(opened.environment);
    const probe = activatableTools().find((tool) => tool.name === "gh")
      ?.activation.signInProbe;
    const status = {
      name: "gh",
      command: "gh",
      installed: true,
      path: join(opened.directory, ".local", "bin", "gh"),
      updater: "none",
      source: "https://github.com/cli/cli#installation",
    } as const;
    const read = async () =>
      (
        await toolsSignIn([{ probe, status }], {
          path: opened.environment.path,
          home: opened.directory,
          run: runTool,
        })
      )[0];
    try {
      expect(await read()).toEqual({
        state: "signed-in",
        account: "octocat",
        ssh: { state: "not-linked", reason: "no-key" },
        identity: "person",
      });
      const started = await sessions.start("gh", { sshKey: true });
      expect(started).toMatchObject({
        kind: "pending",
        challenge: { kind: "device-code", code: fakeCodes.gh },
      });
      if (started.kind !== "pending") throw new Error("not pending");
      const calls = await readFile(join(opened.directory, "gh.calls"), "utf8");
      expect(calls).toContain(
        "auth refresh --hostname github.com --scopes admin:public_key --clipboard=false",
      );
      expect(calls).not.toContain("auth login");
      await opened.approve();
      const state = await settle(sessions, "gh", started.session);
      expect(state).toMatchObject({
        kind: "signed-in",
        account: "octocat",
        ssh: { state: "linked", key: { created: true } },
      });
      expect(await read()).toMatchObject({ ssh: { state: "linked" } });
      // A second link needs no code: the key is on the account already.
      const again = await sessions.start("gh", { sshKey: true });
      if (again.kind !== "pending") throw new Error("not pending");
      expect(again.challenge).toBeUndefined();
      expect(await settle(sessions, "gh", again.session)).toMatchObject({
        ssh: {
          state: "linked",
          key: { created: false },
          registration: "already-registered",
          knownHosts: "present",
        },
      });
      expect(await keyLines(opened.directory)).toHaveLength(1);
      // Without a sign-in there is nothing to link.
      await rm(join(opened.directory, "gh.state"));
      expect(await sessions.start("gh", { sshKey: true })).toEqual({
        kind: "failed",
        tool: "gh",
        reason: "not-signed-in",
      });
      await expect(
        sessions.start("composio", { sshKey: true }),
      ).rejects.toThrow();
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);

test.skipIf(!keygen)(
  "gh: a failing proof, another account greeted, and a key with a passphrase are never reported as linked",
  async () => {
    const cases: readonly {
      prepare: (directory: string) => Promise<void>;
      expected: Record<string, unknown>;
    }[] = [
      {
        prepare: (directory) => writeFile(join(directory, "ssh.fail"), ""),
        expected: { state: "not-linked", reason: "proof-failed" },
      },
      {
        // ssh offers id_rsa before id_ed25519; that key belongs to another
        // account.
        prepare: async (directory) => {
          const rsa = await makeKey(directory, "id_rsa", { type: "rsa" });
          await writeFile(
            join(directory, "gh.foreign"),
            `${await publicKey(rsa)}\n`,
          );
          await makeKey(directory, "id_ed25519");
        },
        expected: {
          state: "not-linked",
          reason: "proof-other-account",
          provedAs: "someone-else",
        },
      },
      {
        prepare: async (directory) => {
          await makeKey(directory, "id_ed25519", {
            passphrase: "not-for-agents",
          });
        },
        expected: { state: "not-linked", reason: "key-passphrase" },
      },
    ];
    for (const { prepare, expected } of cases) {
      const opened = await sshHome();
      await prepare(opened.directory);
      const sessions = createLoginSessions(opened.environment);
      try {
        const state = await signInGh(opened, sessions);
        expect(state).toMatchObject({
          kind: "signed-in",
          account: "octocat",
          ssh: { ...expected, fallback: "agent" },
        });
        await assertNoKeyMaterial(opened.directory, state);
      } finally {
        await sessions.close();
        await opened.close();
      }
    }
  },
);

test.skipIf(!keygen)(
  "cancelling the link in any step kills the running step's process group",
  async () => {
    for (const step of ["ssh-keygen", "ssh-key-add", "api-meta", "ssh"]) {
      const opened = await sshHome();
      await writeFile(join(opened.directory, "gh.state"), "octocat\n");
      await writeFile(
        join(opened.directory, "gh.scopes"),
        "gist read:org repo admin:public_key\n",
      );
      await writeFile(join(opened.directory, `hang.${step}`), "");
      const sessions = createLoginSessions(opened.environment);
      try {
        const started = await sessions.start("gh", { sshKey: true });
        if (started.kind !== "pending") throw new Error("not pending");
        const marker = join(opened.directory, "hang.pid");
        await waitFor(async () => {
          try {
            await readFile(marker, "utf8");
            return true;
          } catch {
            return false;
          }
        });
        const helper = Number(await readFile(marker, "utf8"));
        expect(alive(helper)).toBe(true);
        expect(sessions.poll("gh", started.session)).toMatchObject({
          kind: "pending",
          step: "ssh-key",
        });
        expect(sessions.cancel("gh", started.session).kind).toBe("cancelled");
        await waitFor(() => !alive(helper));
      } finally {
        await sessions.close();
        await opened.close();
      }
    }
  },
);

test.skipIf(!keygen)(
  "sign-out removes only this Machine's key that Lazurio registered; the key files stay",
  async () => {
    const opened = await sshHome();
    const key = await makeKey(opened.directory, "id_ed25519");
    const other = await makeKey(opened.directory, "elsewhere");
    await writeFile(join(opened.directory, "gh.state"), "octocat\n");
    await writeFile(
      join(opened.directory, "gh.scopes"),
      "gist read:org repo admin:public_key\n",
    );
    await writeFile(
      join(opened.directory, "gh.keys"),
      `5\tLazurio: other-vm\t${await publicKey(other)}\n9\tLazurio: vm-01\t${await publicKey(key)}\n`,
    );
    const sessions = createLoginSessions(opened.environment);
    try {
      const out = await sessions.logout("gh");
      expect(out).toMatchObject({
        kind: "logged-out",
        tool: "gh",
        sshKey: { state: "removed" },
      });
      await assertNoKeyMaterial(opened.directory, out);
      expect(await keyLines(opened.directory)).toEqual([
        `5\tLazurio: other-vm\t${await publicKey(other)}`,
      ]);
      expect(
        await readFile(join(opened.directory, "gh.calls"), "utf8"),
      ).toContain("ssh-key delete 9 --yes");
      await stat(key);
      await stat(`${key}.pub`);
      // Without the scope nothing is removed, and the result says so.
      await writeFile(join(opened.directory, "gh.state"), "octocat\n");
      await writeFile(
        join(opened.directory, "gh.scopes"),
        "gist read:org repo\n",
      );
      await writeFile(
        join(opened.directory, "gh.keys"),
        `9\tLazurio: vm-01\t${await publicKey(key)}\n`,
      );
      expect(await sessions.logout("gh")).toMatchObject({
        kind: "logged-out",
        sshKey: { state: "not-removed", reason: "scope-missing" },
      });
      expect(await keyLines(opened.directory)).toHaveLength(1);
    } finally {
      await sessions.close();
      await opened.close();
    }
  },
);
