import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLoginSessions,
  type LoginEnvironment,
  type LoginState,
} from "../src/tools/login";
import { runTool } from "../src/tools/status";
import { fakeLoginTools, realGit } from "./fixtures/fake-login-tools";
import { runChild } from "./fixtures/run-child";

// The gh sign-in sets the person's Git identity where git has none (decision
// F19, addendum 2026-10-14). The Launchpad's Settings → Nástroje, the
// Environment's first run and `lazurio tools login gh` all run this session.
// gh and ssh are fakes; git is the system's own, reading and writing only the
// configuration under a temporary home (its system configuration is
// `$HOME/system.gitconfig`, never the runner's).

const usable = process.platform !== "win32" && realGit !== null;

const noreply = "583231+octocat@users.noreply.github.com";

async function home(refused?: LoginEnvironment["refused"]) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-git-identity-")),
  );
  const path = await fakeLoginTools(directory, ["gh"], { git: true });
  const environment: LoginEnvironment = {
    path,
    home: directory,
    xdg: { XDG_CONFIG_HOME: join(directory, ".config") },
    platform: process.platform,
    run: runTool,
    firstChallengeMs: 5_000,
    probeIntervalMs: 50,
    machine: "vm-01",
    ...(refused === undefined ? {} : { refused }),
  };
  return {
    directory,
    environment,
    // What git itself answers in that home, as a commit would read it.
    async config(key: string, scope = "--global") {
      const result = await runChild(
        [realGit as string, "config", scope, "--includes", "--get", key],
        {
          env: {
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, ".config"),
            GIT_CONFIG_SYSTEM: join(directory, "system.gitconfig"),
          },
        },
      );
      return result.exitCode === 0 ? result.stdout.trim() : null;
    },
    gitconfig: () =>
      readFile(join(directory, ".gitconfig"), "utf8").catch(() => null),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

async function signIn(
  opened: Awaited<ReturnType<typeof home>>,
): Promise<LoginState> {
  const sessions = createLoginSessions(opened.environment);
  try {
    const started = await sessions.start("gh");
    if (started.kind !== "pending") throw new Error("not pending");
    await writeFile(join(opened.directory, "approve"), "");
    const deadline = Date.now() + 15_000;
    for (;;) {
      await sessions.changed("gh", started.session, 100);
      const state = sessions.poll("gh", started.session);
      if (state.kind !== "pending") return state;
      if (Date.now() > deadline) throw new Error("Session did not settle");
    }
  } finally {
    await sessions.close();
  }
}

test.skipIf(!usable)(
  "a sign-in where git has no identity sets the person's GitHub name and noreply address globally",
  async () => {
    const opened = await home();
    try {
      const state = await signIn(opened);
      expect(state).toMatchObject({
        kind: "signed-in",
        tool: "gh",
        account: "octocat",
        gitIdentity: {
          state: "set",
          fields: ["user.name", "user.email"],
          identity: { name: "The Octocat", email: noreply },
        },
      });
      // A commit anywhere in the Environment now finds both.
      expect(await opened.config("user.name")).toBe("The Octocat");
      expect(await opened.config("user.email")).toBe(noreply);
      // From the account gh signed in, read through gh.
      expect(
        await readFile(join(opened.directory, "gh.calls"), "utf8"),
      ).toContain("api user\n");
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "without a profile name the login, as GitHub spells it, is the name",
  async () => {
    const opened = await home();
    try {
      await writeFile(
        join(opened.directory, "gh.user"),
        '{"login":"OctoCat","id":583231,"name":null}\n',
      );
      const state = await signIn(opened);
      expect(state).toMatchObject({
        gitIdentity: {
          state: "set",
          identity: {
            name: "OctoCat",
            email: "583231+OctoCat@users.noreply.github.com",
          },
        },
      });
      expect(await opened.config("user.name")).toBe("OctoCat");
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "an identity git already has is never changed, and only a missing field is added",
  async () => {
    const opened = await home();
    try {
      const existing =
        "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n";
      await writeFile(join(opened.directory, ".gitconfig"), existing);
      expect(await signIn(opened)).toMatchObject({
        kind: "signed-in",
        gitIdentity: { state: "present" },
      });
      expect(await opened.gitconfig()).toBe(existing);
      // GitHub was not even asked.
      expect(
        await readFile(join(opened.directory, "gh.calls"), "utf8"),
      ).not.toContain("api user\n");

      // Only the name: the email is added, the name stays.
      await writeFile(
        join(opened.directory, ".gitconfig"),
        "[user]\n\tname = Ada Lovelace\n",
      );
      expect(await signIn(opened)).toMatchObject({
        gitIdentity: { state: "set", fields: ["user.email"] },
      });
      expect(await opened.config("user.name")).toBe("Ada Lovelace");
      expect(await opened.config("user.email")).toBe(noreply);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "an identity of git's system configuration or an included file counts as present",
  async () => {
    const opened = await home();
    try {
      await writeFile(
        join(opened.directory, "system.gitconfig"),
        "[user]\n\tname = Machine Default\n\temail = default@example.com\n",
      );
      expect(await signIn(opened)).toMatchObject({
        gitIdentity: { state: "present" },
      });
      expect(await opened.gitconfig()).toBeNull();

      await rm(join(opened.directory, "system.gitconfig"));
      await writeFile(
        join(opened.directory, "identity.gitconfig"),
        "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
      );
      const including = `[include]\n\tpath = ${join(opened.directory, "identity.gitconfig")}\n`;
      await writeFile(join(opened.directory, ".gitconfig"), including);
      expect(await signIn(opened)).toMatchObject({
        gitIdentity: { state: "present" },
      });
      expect(await opened.gitconfig()).toBe(including);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "when GitHub does not return the signed-in account nothing is written, and the result says why",
  async () => {
    const opened = await home();
    try {
      await writeFile(join(opened.directory, "gh.nouser"), "");
      expect(await signIn(opened)).toMatchObject({
        kind: "signed-in",
        account: "octocat",
        gitIdentity: {
          state: "not-set",
          reason: "viewer-unavailable",
          missing: ["user.name", "user.email"],
        },
      });
      expect(await opened.gitconfig()).toBeNull();

      // Another account than the one gh confirmed is not the person's.
      await rm(join(opened.directory, "gh.nouser"));
      await writeFile(
        join(opened.directory, "gh.user"),
        '{"login":"someone-else","id":7,"name":"Someone Else"}\n',
      );
      expect(await signIn(opened)).toMatchObject({
        gitIdentity: { state: "not-set", reason: "viewer-unavailable" },
      });
      expect(await opened.gitconfig()).toBeNull();
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "a write git refuses is reported, and the sign-in still ends signed in",
  async () => {
    const opened = await home();
    try {
      await writeFile(join(opened.directory, "git.readonly"), "");
      expect(await signIn(opened)).toMatchObject({
        kind: "signed-in",
        account: "octocat",
        gitIdentity: {
          state: "not-set",
          reason: "write-failed",
          missing: ["user.name", "user.email"],
        },
      });
      expect(await opened.gitconfig()).toBeNull();
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "an Environment that becomes a Team one before the write ends blocked, with no identity written",
  async () => {
    // The Team rule turns true once git was read, i.e. right before the
    // write: the session must ask it there and stop.
    let directory = "";
    const opened = await home(async () => {
      try {
        await readFile(join(directory, "git.calls"), "utf8");
        return true;
      } catch {
        return false;
      }
    });
    directory = opened.directory;
    try {
      expect(await signIn(opened)).toEqual({
        kind: "blocked",
        tool: "gh",
        reason: "team-environment",
        action: "login",
      });
      expect(await opened.gitconfig()).toBeNull();
      const calls = await readFile(join(directory, "git.calls"), "utf8");
      expect(calls).toContain("config --global --includes --get user.name");
      expect(calls).not.toMatch(/config --global -- user\./);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "on a Team Environment the gh sign-in is refused, so git is never touched",
  async () => {
    const opened = await home(async () => true);
    try {
      expect(await signIn(opened)).toMatchObject({
        kind: "blocked",
        reason: "team-environment",
      });
      expect(await opened.gitconfig()).toBeNull();
      expect(
        await readFile(join(opened.directory, "git.calls"), "utf8").catch(
          () => null,
        ),
      ).toBeNull();
    } finally {
      await opened.close();
    }
  },
);

// Review of #416: the Team rule before each write, the presence check again
// right before each write, and a partial write reported as it is.

test.skipIf(!usable)(
  "the Team rule is asked before each field: turning true after user.name stops before user.email",
  async () => {
    let directory = "";
    const opened = await home(async () => {
      const calls = await readFile(join(directory, "git.calls"), "utf8").catch(
        () => "",
      );
      return calls.includes("config --global -- user.name");
    });
    directory = opened.directory;
    try {
      expect(await signIn(opened)).toEqual({
        kind: "blocked",
        tool: "gh",
        reason: "team-environment",
        action: "login",
      });
      // The name written before the Environment became a Team one stays;
      // the email is never written.
      expect(await opened.config("user.name")).toBe("The Octocat");
      expect(await opened.config("user.email")).toBeNull();
      expect(
        await readFile(join(directory, "git.calls"), "utf8"),
      ).not.toContain("config --global -- user.email");
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "a field set while GitHub answers is never replaced, and is reported as git's own",
  async () => {
    const opened = await home();
    try {
      // Only the name appears meanwhile: it stays, the email is added.
      await writeFile(
        join(opened.directory, "gh.user.fill"),
        "[user]\n\tname = Ada Lovelace\n",
      );
      expect(await signIn(opened)).toMatchObject({
        kind: "signed-in",
        gitIdentity: { state: "set", fields: ["user.email"] },
      });
      expect(await opened.config("user.name")).toBe("Ada Lovelace");
      expect(await opened.config("user.email")).toBe(noreply);

      // Both appear meanwhile: nothing is written, the identity is present.
      await rm(join(opened.directory, ".gitconfig"));
      const filled =
        "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n";
      await writeFile(join(opened.directory, "gh.user.fill"), filled);
      const state = await signIn(opened);
      expect(state).toMatchObject({ gitIdentity: { state: "present" } });
      expect(await opened.gitconfig()).toBe(filled);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "a presence check that cannot answer right before the write fails closed",
  async () => {
    const opened = await home();
    try {
      // A malformed configuration appears while GitHub answers.
      await writeFile(join(opened.directory, "gh.user.fill"), "[user\n");
      expect(await signIn(opened)).toMatchObject({
        kind: "signed-in",
        gitIdentity: {
          state: "not-set",
          reason: "config-unreadable",
          missing: ["user.name", "user.email"],
        },
      });
      expect(
        await readFile(join(opened.directory, "git.calls"), "utf8"),
      ).not.toContain("config --global -- user.");
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!usable)(
  "a second write that fails after the first succeeded reports exactly what was written",
  async () => {
    const opened = await home();
    try {
      await writeFile(join(opened.directory, "git.readonly"), "user.email");
      expect(await signIn(opened)).toMatchObject({
        kind: "signed-in",
        gitIdentity: {
          state: "set",
          fields: ["user.name"],
          identity: { name: "The Octocat", email: noreply },
          incomplete: { reason: "write-failed", missing: ["user.email"] },
        },
      });
      expect(await opened.config("user.name")).toBe("The Octocat");
      expect(await opened.config("user.email")).toBeNull();
      // A later sign-in completes it and leaves the name alone.
      await rm(join(opened.directory, "git.readonly"));
      expect(await signIn(opened)).toMatchObject({
        gitIdentity: { state: "set", fields: ["user.email"] },
      });
      expect(await opened.config("user.email")).toBe(noreply);
    } finally {
      await opened.close();
    }
  },
);
