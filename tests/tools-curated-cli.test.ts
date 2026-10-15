import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { runToolsCommand, ToolsUsageError } from "../src/tools/cli";
import type { InstallFetch } from "../src/tools/install";
import {
  fakeCodes,
  fakeLoginTools,
  realSshKeygen,
} from "./fixtures/fake-login-tools";

const posix = process.platform !== "win32";
const keygen = posix && realSshKeygen !== null;

async function home(tools?: Parameters<typeof fakeLoginTools>[1]) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-curated-cli-")),
  );
  const path = await fakeLoginTools(directory, tools);
  const lines: string[] = [];
  return {
    directory,
    path,
    lines,
    context: (extra: Record<string, unknown> = {}) => ({
      env: { HOME: directory, PATH: path },
      platform: process.platform,
      write: (line: string) => lines.push(line),
      login: { firstChallengeMs: 5_000, probeIntervalMs: 50, machine: "vm-01" },
      ...extra,
    }),
    approve: () => writeFile(join(directory, "approve"), ""),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

async function allFiles(directory: string): Promise<string[]> {
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

test("agent-setup and unknown tools are refused with a pointer; options belong to their command", async () => {
  const context = {
    env: { HOME: "/nonexistent", PATH: "" },
    platform: process.platform,
    write: () => undefined,
  };
  for (const command of ["install", "login", "logout"]) {
    const refused = await runToolsCommand([command, "neon", "--json"], context);
    expect(refused.code).toBe(2);
    expect(refused.result).toEqual({
      kind: "blocked",
      reason: "setup-agent",
      tool: "neon",
      prompt: "lazurio tools prompt neon",
    });
    const text = await runToolsCommand([command, "gogcli"], context);
    expect(text.text).toContain("lazurio tools prompt gogcli");
    expect(
      (await runToolsCommand([command, "nope"], context)).result,
    ).toMatchObject({
      kind: "blocked",
      reason: "tool-unknown",
    });
  }
  const phone = await runToolsCommand(
    ["login", "gh", "--phone", "+420123456789"],
    context,
  );
  expect(phone.code).toBe(2);
  expect(phone.result).toMatchObject({ reason: "phone-wacli-only" });
  const ssh = await runToolsCommand(
    ["login", "composio", "--ssh-key", "--json"],
    context,
  );
  expect(ssh.code).toBe(2);
  expect(ssh.result).toEqual({
    kind: "blocked",
    reason: "ssh-key-gh-only",
    tool: "composio",
  });
  for (const args of [
    ["install", "gh", "--phone", "+420123456789"],
    ["install"],
    ["login", "gh", "wacli"],
    ["composio-org", "switch"],
    ["composio-org", "rename", "x"],
    ["logout", "gh", "--folder", "/tmp"],
    ["logout", "gh", "--ssh-key"],
    ["install", "gh", "--ssh-key"],
  ])
    await expect(runToolsCommand(args, context)).rejects.toThrow(
      ToolsUsageError,
    );
});

test.skipIf(!keygen)(
  "tools login --json prints one JSON object per state change and exits 0 when signed in with the SSH key linked",
  async () => {
    const opened = await home(["gh"]);
    try {
      const running = runToolsCommand(
        ["login", "gh", "--json"],
        opened.context(),
      );
      while (opened.lines.length === 0) await Bun.sleep(20);
      expect(JSON.parse(opened.lines[0] as string)).toMatchObject({
        kind: "pending",
        tool: "gh",
        challenge: {
          kind: "device-code",
          url: "https://github.com/login/device",
          code: fakeCodes.gh,
        },
      });
      await opened.approve();
      const output = await running;
      expect(output.code).toBe(0);
      expect(output.text).toBe("");
      const kinds = opened.lines.map((line) => JSON.parse(line).kind);
      expect(kinds[0]).toBe("pending");
      expect(kinds.at(-1)).toBe("signed-in");
      expect(JSON.parse(opened.lines.at(-1) as string)).toMatchObject({
        kind: "signed-in",
        tool: "gh",
        account: "octocat",
        ssh: {
          state: "linked",
          key: {
            path: join(opened.directory, ".ssh", "id_ed25519"),
            created: true,
          },
          registration: "added",
          knownHosts: "added",
        },
      });
      // The private key never reaches the output.
      const privateKey = await readFile(
        join(opened.directory, ".ssh", "id_ed25519"),
        "utf8",
      );
      const body = privateKey.split("\n")[1] as string;
      expect(opened.lines.join("\n")).not.toContain(body);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "tools login wacli draws the QR in the terminal, redraws it when it rotates and waits for the first sync",
  async () => {
    const opened = await home(["wacli"]);
    try {
      const running = runToolsCommand(["login", "wacli"], opened.context());
      while (!opened.lines.some((line) => line.includes("\u001b[30;107m")))
        await Bun.sleep(20);
      await writeFile(join(opened.directory, "rotate"), "");
      while (
        opened.lines.filter((line) => line.startsWith("Scan this QR code"))
          .length < 2
      )
        await Bun.sleep(20);
      await opened.approve();
      while (!opened.lines.some((line) => line.includes("signed in as")))
        await Bun.sleep(20);
      await writeFile(join(opened.directory, "synced"), "");
      const output = await running;
      expect(output.code).toBe(0);
      const text = opened.lines.join("\n");
      expect(text).toContain("Linked devices > Link a device");
      expect(text).toContain("lazurio tools login wacli --phone");
      expect(text).toContain("wacli: signed in as 420123456789.");
      expect(text).toContain("Finishing the first sync");
      // The QR payload itself is never printed as text.
      expect(text).not.toContain(fakeCodes.qrFirst);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "Ctrl-C of a running tools login cancels it and kills the tool's process group; nothing of the code reaches stderr or a file",
  async () => {
    const opened = await home(["gh"]);
    try {
      const child = spawn(
        process.execPath,
        [
          "run",
          join(import.meta.dir, "..", "src", "cli.ts"),
          "tools",
          "login",
          "gh",
        ],
        {
          env: {
            HOME: opened.directory,
            PATH: `${opened.path}:${join(process.execPath, "..")}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise<number | null>((resolve) =>
        child.once("close", (code) => resolve(code)),
      );
      const deadline = Date.now() + 15_000;
      while (!stdout.includes(fakeCodes.gh)) {
        if (Date.now() > deadline) throw new Error(`No challenge: ${stderr}`);
        await Bun.sleep(25);
      }
      expect(stdout).toContain("https://github.com/login/device");
      const helper = Number(
        await readFile(join(opened.directory, "gh.child"), "utf8"),
      );
      child.kill("SIGINT");
      expect(await exited).toBe(1);
      expect(stdout).toContain("was cancelled");
      const gone = Date.now() + 5_000;
      for (;;) {
        try {
          process.kill(helper, 0);
        } catch {
          break;
        }
        if (Date.now() > gone) throw new Error("The tool's helper survived");
        await Bun.sleep(25);
      }
      expect(stderr).not.toContain(fakeCodes.gh);
      for (const file of await allFiles(opened.directory))
        expect(await readFile(file, "utf8")).not.toContain(fakeCodes.gh);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "tools install, logout and composio-org run the same core",
  async () => {
    const opened = await home(["composio"]);
    try {
      // Install of a tool that works changes nothing and fetches nothing.
      const requests: string[] = [];
      const fetcher: InstallFetch = async (url) => {
        requests.push(url);
        return new Response("", { status: 404 });
      };
      const installed = await runToolsCommand(
        ["install", "composio", "--json"],
        opened.context({ install: { fetch: fetcher } }),
      );
      expect(installed.code).toBe(0);
      expect(installed.result).toMatchObject({
        kind: "already-installed",
        tool: "composio",
        version: "0.3.1",
      });
      expect(requests).toEqual([]);
      // wacli is missing: the release is fetched; here the source fails.
      const failed = await runToolsCommand(
        ["install", "wacli"],
        opened.context({
          install: { fetch: fetcher, platform: "linux", arch: "x64" },
        }),
      );
      expect(failed.code).toBe(1);
      expect(failed.text).toContain("lazurio tools prompt wacli");
      expect(requests).toEqual([
        "https://api.github.com/repos/openclaw/wacli/releases/latest",
      ]);
      // Signed in, the organizations and the switch.
      const login = runToolsCommand(["login", "composio"], opened.context());
      while (
        !opened.lines.some((line) => line.includes("dashboard.composio.dev"))
      )
        await Bun.sleep(20);
      await opened.approve();
      expect((await login).code).toBe(0);
      const listed = await runToolsCommand(["composio-org"], opened.context());
      expect(listed.code).toBe(0);
      expect(listed.text).toContain("* First  (org_1)");
      const switched = await runToolsCommand(
        ["composio-org", "switch", "org_2", "--json"],
        opened.context(),
      );
      expect(switched.result).toEqual({
        kind: "composio-organization-selected",
        id: "org_2",
        organization: "Second",
      });
      const out = await runToolsCommand(
        ["logout", "composio"],
        opened.context(),
      );
      expect(out.code).toBe(0);
      expect(out.text).toContain("signed out in this Environment");
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "tools install places a verified release binary",
  async () => {
    const opened = await home([]);
    try {
      const body = `#!/bin/sh\n[ "$1" = "--version" ] && echo "wacli 0.19.0"\n`;
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
            block("wacli", data.length),
            padded,
            new Uint8Array(1024),
          ]),
        ),
      );
      const digest = createHash("sha256").update(archive).digest("hex");
      const root =
        "https://github.com/openclaw/wacli/releases/download/v0.19.0";
      const files: Record<string, BodyInit> = {
        "https://api.github.com/repos/openclaw/wacli/releases/latest":
          '{"tag_name":"v0.19.0"}',
        [`${root}/checksums.txt`]: `${digest}  wacli_0.19.0_linux_amd64.tar.gz\n`,
        [`${root}/wacli_0.19.0_linux_amd64.tar.gz`]: archive,
      };
      const fetcher: InstallFetch = async (url) =>
        files[url] === undefined
          ? new Response("", { status: 404 })
          : new Response(files[url]);
      const result = await runToolsCommand(
        ["install", "wacli"],
        opened.context({
          install: { fetch: fetcher, platform: "linux", arch: "x64" },
        }),
      );
      expect(result.code).toBe(0);
      expect(result.text).toContain(
        `wacli 0.19.0 installed at ${join(opened.directory, ".local", "bin", "wacli")}`,
      );
      expect(result.text).toContain("Next: lazurio tools login wacli");
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!keygen)(
  "tools login gh says whether the SSH key is linked, exits 1 when it is not; --ssh-key links it; logout says what happened to the key",
  async () => {
    const opened = await home(["gh"]);
    try {
      // The proof fails: signed in, SSH not linked, exit 1, the way forward.
      await writeFile(join(opened.directory, "ssh.fail"), "");
      const running = runToolsCommand(["login", "gh"], opened.context());
      while (!opened.lines.some((line) => line.includes(fakeCodes.gh)))
        await Bun.sleep(20);
      await opened.approve();
      const failed = await running;
      expect(failed.code).toBe(1);
      const text = opened.lines.join("\n");
      expect(text).toContain("gh: signed in as octocat.");
      expect(text).toContain(
        "The SSH key is NOT linked: ssh -T git@github.com did not answer with GitHub's greeting.",
      );
      expect(text).toContain("lazurio tools login gh --ssh-key");
      expect(text).toContain("lazurio tools prompt gh");
      // Linking again, once the proof works: no new code, exit 0.
      await rm(join(opened.directory, "ssh.fail"));
      opened.lines.length = 0;
      const linked = await runToolsCommand(
        ["login", "gh", "--ssh-key"],
        opened.context(),
      );
      expect(linked.code).toBe(0);
      const done = opened.lines.join("\n");
      expect(done).not.toContain(fakeCodes.gh);
      expect(done).toContain("Linking the SSH key of this Environment");
      expect(done).toContain(
        `SSH key linked: ${join(opened.directory, ".ssh", "id_ed25519")} (SHA256:`,
      );
      expect(done).toContain("git clone git@github.com:… works as octocat.");
      const out = await runToolsCommand(["logout", "gh"], opened.context());
      expect(out.code).toBe(0);
      expect(out.text).toContain(
        "was removed from your GitHub account; the key files in ~/.ssh stay.",
      );
    } finally {
      await opened.close();
    }
  },
);
