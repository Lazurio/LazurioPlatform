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
import { findTool } from "../src/tools/catalog";
import {
  createSshProofs,
  fingerprintOf,
  type SshProofs,
} from "../src/tools/ssh-key";
import { runTool, toolsSignIn } from "../src/tools/status";
import {
  fakeLoginTools,
  githubHostKeys,
  realSshKeygen,
} from "./fixtures/fake-login-tools";
import { runChild } from "./fixtures/run-child";

// GitHub's SSH status (#515, decision F19's addendum of 2026-10-19): a
// signed-in gh is ready only when this Environment reaches GitHub over SSH
// as that account. The status runs the sign-in's own proof: GitHub's
// published host keys against `known_hosts`, then `ssh -T` with BatchMode
// and StrictHostKeyChecking=yes, whose greeting must name the signed-in
// login. `unknown` only when GitHub cannot be reached or read. gh and ssh
// are the fakes of the sign-in's tests; the real ssh-keygen runs on files
// under the temporary home.

const keygen = process.platform !== "win32" && realSshKeygen !== null;

async function world(
  options: Readonly<{
    key?: boolean;
    registered?: boolean;
    hostKeys?: boolean;
    scopes?: string;
  }> = {},
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-ssh-status-")),
  );
  const path = await fakeLoginTools(directory, ["gh"]);
  await mkdir(join(directory, ".ssh"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "gh.state"), "octocat\n");
  await writeFile(
    join(directory, "gh.scopes"),
    `${options.scopes ?? "gist read:org repo admin:public_key"}\n`,
  );
  const key = join(directory, ".ssh", "id_ed25519");
  let publicKey: string | null = null;
  if (options.key !== false) {
    const made = await runChild(
      [
        realSshKeygen as string,
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "test",
        "-f",
        key,
      ],
      { env: { HOME: directory } },
    );
    if (made.exitCode !== 0) throw new Error("ssh-keygen failed");
    publicKey = (await readFile(`${key}.pub`, "utf8"))
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(" ");
    if (options.registered !== false)
      await writeFile(
        join(directory, "gh.keys"),
        `101\tLazurio: vm-01\t${publicKey}\n`,
      );
  }
  if (options.hostKeys !== false)
    await writeFile(
      join(directory, ".ssh", "known_hosts"),
      `${githubHostKeys.map((entry) => `github.com ${entry}`).join("\n")}\n`,
    );
  const read = async (proofs?: SshProofs) =>
    (
      await toolsSignIn(
        [
          {
            probe: findTool("gh")?.signInProbe,
            status: {
              name: "gh",
              command: "gh",
              installed: true,
              path: join(directory, ".local", "bin", "gh"),
              updater: "none",
              source: "https://github.com/cli/cli#installation",
            },
          },
        ],
        {
          path,
          home: directory,
          run: runTool,
          ...(proofs === undefined ? {} : { sshProofs: proofs }),
        },
      )
    )[0];
  const sshCalls = async () =>
    (await readFile(join(directory, "ssh.calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.length > 0).length;
  return {
    directory,
    // Only where the world has a key.
    fingerprint: publicKey === null ? "" : fingerprintOf(publicKey),
    read,
    sshCalls,
    flag: (name: string, text = "") => writeFile(join(directory, name), text),
    unflag: (name: string) => rm(join(directory, name), { force: true }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test.skipIf(!keygen)(
  "the status runs the sign-in's own proof: linked only when ssh -T greets the signed-in account (#515)",
  async () => {
    const linked = await world();
    try {
      expect(await linked.read()).toEqual({
        state: "signed-in",
        account: "octocat",
        ssh: { state: "linked", fingerprint: linked.fingerprint },
        identity: "person",
      });
      // The proof is the sign-in's: GitHub's published keys and ssh -T with
      // BatchMode and StrictHostKeyChecking=yes.
      expect(
        (await readFile(join(linked.directory, "ssh.calls"), "utf8")).trim(),
      ).toBe(
        "-T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 git@github.com",
      );
      expect(
        await readFile(join(linked.directory, "gh.calls"), "utf8"),
      ).toContain("api meta --jq .ssh_keys");
    } finally {
      await linked.close();
    }
    // Registered, but without GitHub's host keys: git clone would refuse
    // the host, so it is not linked.
    const noHostKeys = await world({ hostKeys: false });
    try {
      expect((await noHostKeys.read())?.ssh).toEqual({
        state: "not-linked",
        reason: "proof-failed",
        fingerprint: noHostKeys.fingerprint,
      });
    } finally {
      await noHostKeys.close();
    }
    // Another account greets: another key is offered first.
    const other = await world();
    try {
      const rsa = join(other.directory, ".ssh", "id_rsa");
      const made = await runChild(
        [
          realSshKeygen as string,
          "-q",
          "-t",
          "rsa",
          "-b",
          "2048",
          "-N",
          "",
          "-C",
          "test",
          "-f",
          rsa,
        ],
        { env: { HOME: other.directory } },
      );
      if (made.exitCode !== 0) throw new Error("ssh-keygen failed");
      await other.flag(
        "gh.foreign",
        `${(await readFile(`${rsa}.pub`, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ")}\n`,
      );
      // ed25519 is this Environment's key (Lazurio's order); OpenSSH offers
      // id_rsa first, and GitHub greets its account.
      const signIn = await other.read();
      expect(signIn?.ssh?.state).toBe("not-linked");
      expect(signIn?.ssh?.reason).toBe("other-account");
    } finally {
      await other.close();
    }
    // A github.com host key GitHub does not publish: not linked, and ssh
    // never connects to whoever answers.
    const foreign = await world({ hostKeys: false });
    try {
      const host = join(foreign.directory, "host");
      const made = await runChild(
        [
          realSshKeygen as string,
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-C",
          "host",
          "-f",
          host,
        ],
        { env: { HOME: foreign.directory } },
      );
      if (made.exitCode !== 0) throw new Error("ssh-keygen failed");
      await foreign.flag(
        join(".ssh", "known_hosts"),
        `github.com ${(await readFile(`${host}.pub`, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ")}\n`,
      );
      expect((await foreign.read())?.ssh).toMatchObject({
        state: "not-linked",
        reason: "proof-failed",
      });
      expect(await foreign.sshCalls()).toBe(0);
    } finally {
      await foreign.close();
    }
  },
  // Real processes (the fakes, ssh-keygen): slower under a loaded run.
  30_000,
);

test.skipIf(!keygen)(
  "no key, or a key the account does not list, is not linked without connecting over SSH",
  async () => {
    const none = await world({ key: false });
    try {
      expect((await none.read())?.ssh).toEqual({
        state: "not-linked",
        reason: "no-key",
      });
      expect(await none.sshCalls()).toBe(0);
    } finally {
      await none.close();
    }
    const unlisted = await world({ registered: false });
    try {
      expect((await unlisted.read())?.ssh).toEqual({
        state: "not-linked",
        reason: "not-registered",
        fingerprint: unlisted.fingerprint,
      });
      expect(await unlisted.sshCalls()).toBe(0);
    } finally {
      await unlisted.close();
    }
  },
  // Real processes (the fakes, ssh-keygen): slower under a loaded run.
  30_000,
);

test.skipIf(!keygen)(
  "unknown only when GitHub cannot be reached or read",
  async () => {
    const opened = await world();
    try {
      for (const flag of ["ssh.unreachable", "gh.meta.fail", "gh.keys.fail"]) {
        await opened.flag(flag);
        expect([flag, (await opened.read())?.ssh]).toEqual([
          flag,
          {
            state: "unknown",
            reason: "unreadable",
            fingerprint: opened.fingerprint,
          },
        ]);
        await opened.unflag(flag);
      }
      expect((await opened.read())?.ssh?.state).toBe("linked");
    } finally {
      await opened.close();
    }
  },
  // Real processes (the fakes, ssh-keygen): slower under a loaded run.
  30_000,
);

test.skipIf(!keygen)(
  "a token that cannot read the account's keys: the proof alone decides",
  async () => {
    const working = await world({ scopes: "gist read:org repo" });
    try {
      expect((await working.read())?.ssh).toEqual({
        state: "linked",
        fingerprint: working.fingerprint,
      });
    } finally {
      await working.close();
    }
    const broken = await world({
      scopes: "gist read:org repo",
      registered: false,
    });
    try {
      expect((await broken.read())?.ssh).toEqual({
        state: "not-linked",
        reason: "proof-failed",
        fingerprint: broken.fingerprint,
      });
    } finally {
      await broken.close();
    }
  },
  // Real processes (the fakes, ssh-keygen): slower under a loaded run.
  30_000,
);

test.skipIf(!keygen)(
  "the proof's cost: a pass is kept per key and account for a while, a failure is asked again after a short pause, a sign-in refreshes it",
  async () => {
    const opened = await world();
    let clock = 1_000_000;
    const proofs = createSshProofs({
      passMs: 300_000,
      failMs: 20_000,
      now: () => clock,
    });
    try {
      expect((await opened.read(proofs))?.ssh?.state).toBe("linked");
      expect(await opened.sshCalls()).toBe(1);
      // Read again within the pass's time: no second connection, also when
      // reads meet.
      await Promise.all([opened.read(proofs), opened.read(proofs)]);
      expect(await opened.sshCalls()).toBe(1);
      // Once it is older, it is proved again; now it fails.
      await opened.flag("ssh.fail");
      clock += 300_001;
      expect((await opened.read(proofs))?.ssh?.state).toBe("not-linked");
      expect(await opened.sshCalls()).toBe(2);
      // A failure is kept only briefly: the fix shows on a read soon after.
      await opened.unflag("ssh.fail");
      clock += 5_000;
      expect((await opened.read(proofs))?.ssh?.state).toBe("not-linked");
      expect(await opened.sshCalls()).toBe(2);
      clock += 20_000;
      expect((await opened.read(proofs))?.ssh?.state).toBe("linked");
      expect(await opened.sshCalls()).toBe(3);
      // A sign-in or a link of this Launchpad: what it proved is kept, and
      // a sign-in or sign-out that starts forgets everything.
      await opened.flag("ssh.fail");
      proofs.forget();
      expect((await opened.read(proofs))?.ssh?.state).toBe("not-linked");
      expect(await opened.sshCalls()).toBe(4);
      // The account's name is GitHub's, whatever its case.
      proofs.passed(opened.fingerprint, "OctoCat");
      expect((await opened.read(proofs))?.ssh?.state).toBe("linked");
      expect(await opened.sshCalls()).toBe(4);
    } finally {
      await opened.close();
    }
  },
  // Real processes (the fakes, ssh-keygen): slower under a loaded run.
  30_000,
);
