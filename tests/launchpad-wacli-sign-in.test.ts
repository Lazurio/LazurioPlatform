import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import type { LoginJournalEntry } from "../src/tools/login";
import { runTool } from "../src/tools/status";
import { fakeLoginTools } from "./fixtures/fake-login-tools";

// The curated wacli sign-in (#98) driven through the routes the Settings →
// Tools dialog uses, with stand-in executables for `wacli` that behave as the
// real one may on a Machine whose Launchpad runs as a service: no terminal,
// the QR code only as `--events` NDJSON on stderr, late, never, or an exit at
// once. HOME and XDG are temporary; nothing reaches the network.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

// A realistic pairing payload shape (a link with the four keys and the client
// type); every value here is made up.
const payload =
  "https://wa.me/settings/linked_devices#2@standinref,AAAAnoisekey=,BBBBidentity=,CCCCadv=,1";
const qrEvent = `{"event":"qr_code","data":{"code":"${payload}"},"ts":2}`;

// `auth status` answers "not signed in"; `auth` records whether any standard
// stream is a terminal and its pid, then runs the variant's body.
const standIn = (body: string) => `#!/bin/sh
case "$1 $2" in
"--version ") echo "wacli 0.18.2"; exit 0;;
"auth status") echo '{"authenticated":false}'; exit 0;;
esac
tty=none
[ -t 0 ] && tty=stdin
[ -t 1 ] && tty=stdout
[ -t 2 ] && tty=stderr
echo "$tty" > "$HOME/wacli.tty"
echo $$ > "$HOME/wacli.pid"
echo '{"event":"auth_starting","ts":1}' >&2
${body}
`;

async function launchpad(
  body: string | null,
  login: Readonly<{ firstChallengeMs: number; challengeMs: number }>,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-wacli-")),
  );
  const home = join(parent, "home");
  const path = await fakeLoginTools(home, body === null ? [] : ["wacli"]);
  if (body !== null) {
    const script = join(home, ".local", "bin", "wacli");
    await writeFile(script, standIn(body));
    await chmod(script, 0o755);
  }
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  });
  const journal: LoginJournalEntry[] = [];
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {},
    {
      path,
      home,
      xdg: {
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CONFIG_HOME: join(home, ".config"),
      },
      platform: process.platform,
      run: runTool,
    },
    {
      login: {
        ...login,
        probeIntervalMs: 50,
        journal: (entry) => journal.push(entry),
      },
    },
  );
  const url = new URL(app.url);
  const post = async (route: string, value: unknown) => {
    const response = await fetch(new URL(route, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
      },
      body: JSON.stringify(value),
    });
    return (await response.json()) as Json;
  };
  const pid = async () =>
    Number((await readFile(join(home, "wacli.pid"), "utf8")).trim());
  let stopped: Promise<unknown> | null = null;
  const stop = () => {
    stopped ??= app.close();
    return stopped;
  };
  return {
    home,
    journal,
    post,
    pid,
    stop,
    async close() {
      await stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
}

// The journal names the tool and the outcome only: no payload, no output.
function journaled(journal: readonly LoginJournalEntry[], end: Json): void {
  expect(journal).toEqual([
    { tool: "wacli", event: "start" },
    { tool: "wacli", event: "end", ...end } as LoginJournalEntry,
  ]);
  expect(JSON.stringify(journal)).not.toContain("standinref");
}

test.skipIf(!posix)(
  "wacli without a terminal: a QR code printed late on stderr reaches the dialog through start and poll",
  async () => {
    const opened = await launchpad(
      `sleep 1\necho '${qrEvent}' >&2\nexec sleep 300`,
      {
        firstChallengeMs: 200,
        challengeMs: 10_000,
      },
    );
    try {
      const started = await opened.post("/api/tools/login/start", {
        tool: "wacli",
      });
      // The start answered before the code: pending, nothing to show yet.
      expect(started).toMatchObject({ kind: "pending", tool: "wacli" });
      expect(started.challenge).toBeUndefined();
      const session = started.session as string;
      const deadline = Date.now() + 10_000;
      let polled: Json = started;
      while (polled.challenge === undefined && Date.now() < deadline) {
        await Bun.sleep(50);
        polled = await opened.post("/api/tools/login/poll", {
          tool: "wacli",
          session,
        });
      }
      expect(polled).toMatchObject({
        kind: "pending",
        challenge: { kind: "qr", payload, sequence: 1 },
      });
      expect(polled.qrSvg as string).toStartWith("<svg ");
      // The tool ran with no terminal on any standard stream.
      expect(
        (await readFile(join(opened.home, "wacli.tty"), "utf8")).trim(),
      ).toBe("none");
      const pid = await opened.pid();
      expect(
        await opened.post("/api/tools/login/cancel", {
          tool: "wacli",
          session,
        }),
      ).toEqual({ kind: "cancelled", tool: "wacli" });
      expect(await gone(pid)).toBe(true);
      journaled(opened.journal, { outcome: "cancelled" });
    } finally {
      await opened.close();
    }
  },
  20_000,
);

test.skipIf(!posix)(
  "wacli with its QR code only on stderr and stdout closed: the start answers with the code",
  async () => {
    const opened = await launchpad(
      `exec 1>&-\necho '${qrEvent}' >&2\nexec sleep 300`,
      {
        firstChallengeMs: 5_000,
        challengeMs: 10_000,
      },
    );
    try {
      const started = await opened.post("/api/tools/login/start", {
        tool: "wacli",
      });
      expect(started).toMatchObject({
        kind: "pending",
        challenge: { kind: "qr", payload, sequence: 1 },
      });
      expect(started.qrSvg as string).toStartWith("<svg ");
      const pid = await opened.pid();
      await opened.stop();
      expect(await gone(pid)).toBe(true);
      // The owner's shutdown ended it.
      journaled(opened.journal, { outcome: "cancelled" });
    } finally {
      await opened.close();
    }
  },
  20_000,
);

test.skipIf(!posix)(
  "wacli that exits at once with a non-zero status ends the start as tool-exit",
  async () => {
    const opened = await launchpad(
      `echo '{"event":"error","data":{"message":"stand-in failure"},"ts":2}' >&2\nexit 1`,
      { firstChallengeMs: 5_000, challengeMs: 10_000 },
    );
    try {
      const started = await opened.post("/api/tools/login/start", {
        tool: "wacli",
      });
      expect(started).toEqual({
        kind: "failed",
        tool: "wacli",
        reason: "tool-exit",
      });
      journaled(opened.journal, { outcome: "failed", reason: "tool-exit" });
      expect(JSON.stringify(opened.journal)).not.toContain("stand-in failure");
    } finally {
      await opened.close();
    }
  },
  20_000,
);

test.skipIf(!posix)(
  "wacli that prints nothing and keeps running ends as no-challenge within the bound and is killed",
  async () => {
    const opened = await launchpad("exec sleep 300", {
      firstChallengeMs: 200,
      challengeMs: 600,
    });
    try {
      const began = Date.now();
      const started = await opened.post("/api/tools/login/start", {
        tool: "wacli",
      });
      expect(started).toMatchObject({ kind: "pending", tool: "wacli" });
      const session = started.session as string;
      let polled: Json = started;
      while (polled.kind === "pending" && Date.now() - began < 5_000) {
        await Bun.sleep(50);
        polled = await opened.post("/api/tools/login/poll", {
          tool: "wacli",
          session,
        });
      }
      expect(polled).toEqual({
        kind: "failed",
        tool: "wacli",
        reason: "no-challenge",
      });
      expect(Date.now() - began).toBeLessThan(5_000);
      expect(await gone(await opened.pid())).toBe(true);
      journaled(opened.journal, { outcome: "failed", reason: "no-challenge" });
    } finally {
      await opened.close();
    }
  },
  20_000,
);

test.skipIf(!posix)(
  "wacli missing from PATH ends the start as not-installed",
  async () => {
    const opened = await launchpad(null, {
      firstChallengeMs: 5_000,
      challengeMs: 10_000,
    });
    try {
      expect(
        await opened.post("/api/tools/login/start", { tool: "wacli" }),
      ).toEqual({ kind: "failed", tool: "wacli", reason: "not-installed" });
      journaled(opened.journal, { outcome: "failed", reason: "not-installed" });
    } finally {
      await opened.close();
    }
  },
  20_000,
);
