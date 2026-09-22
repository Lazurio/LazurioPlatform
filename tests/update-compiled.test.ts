import { afterAll, expect, test } from "bun:test";
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
  createFixtureSigstore,
  writeFixtureRelease,
} from "../scripts/update-fixture";
import { createFixtureOrigin } from "../scripts/update-fixture-server";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { resolveInstallBase } from "../src/update/base";
import { identityDefines, nativeTarget } from "../src/update/identity";

// The REAL executable, compiled the way a release is (`identityDefines`), goes
// through install -> check -> update -> rollback -> retry against the signed
// loopback origin. Its origin and trust root are the FIXTURE define; a release
// build has neither. HOME is a temporary directory: the person's real install
// base is never touched.
const target = nativeTarget(process.platform, process.arch);
const commit = "0123456789abcdef0123456789abcdef01234567";
let root: string | undefined;
afterAll(async () => root && rm(root, { recursive: true, force: true }));

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a compiled product installs itself, updates to an attested release, rolls back and retries",
  async () => {
    // The installed Launchpad answers on a Unix socket under the base, and a
    // socket path is short on macOS: /tmp, not the long per-user tmpdir.
    const home = await realpath(
      await mkdtemp(
        join(process.platform === "darwin" ? "/tmp" : tmpdir(), "upd-c-"),
      ),
    );
    root = home;
    const tree = join(home, "tree");
    await mkdir(tree);
    const sigstore = await createFixtureSigstore();
    const origin = createFixtureOrigin({ tree });
    const trustedRoot = join(home, "FIXTURE-trusted-root.json");
    await writeFile(trustedRoot, sigstore.trustedRoot);
    const compile = async (version: string) => {
      const outfile = join(home, `lazurio-${version}`);
      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          new URL("../src/cli.ts", import.meta.url).pathname,
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          ...identityDefines(
            { version, commit, target },
            { baseUrl: origin.baseUrl, trustedRoot },
          ),
          "--outfile",
          outfile,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(build.exitCode).toBe(0);
      return outfile;
    };
    const env = { HOME: home, XDG_DATA_HOME: join(home, "data") };
    // Asynchronous: the origin is served by this very process.
    const run = async (binary: string, ...args: string[]) => {
      const child = Bun.spawn([binary, ...args], {
        cwd: home,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return {
        code: await child.exited,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    };
    try {
      const [first, second] = [await compile("1.0.0"), await compile("1.1.0")];
      await writeFixtureRelease(tree, sigstore, {
        version: "1.1.0",
        commit,
        artifacts: { [target]: await readFile(second) },
      });
      expect(await run(first, "--version")).toEqual({
        code: 0,
        stdout: `lazurio 1.0.0 (commit ${commit}, target ${target}) FIXTURE BUILD: not a release`,
        stderr: "",
      });
      expect(
        JSON.parse((await run(first, "--version", "--json")).stdout),
      ).toEqual({
        version: "1.0.0",
        commit,
        target,
        fixture: true,
      });
      // Nothing installed yet.
      expect(await run(first, "update", "--json")).toMatchObject({ code: 1 });
      expect(
        JSON.parse((await run(first, "update", "--json")).stdout).code,
      ).toBe("not-installed");

      const base = resolveInstallBase({
        platform: process.platform,
        env,
        homedir: home,
      }) as string;
      expect(base.startsWith(home)).toBe(true);
      expect(
        JSON.parse((await run(first, "install", "--json")).stdout),
      ).toEqual({
        kind: "installed",
        active: "1.0.0",
        path: join(base, "bin"),
        serviceInstalled: false,
      });
      const lazurio = join(base, "bin", "lazurio");
      expect(await run(lazurio, "update", "--check")).toMatchObject({
        code: 10,
      });
      expect(
        JSON.parse((await run(lazurio, "update", "--json")).stdout),
      ).toEqual({
        kind: "updated",
        from: "1.0.0",
        to: "1.1.0",
        restartRequired: true,
      });
      // The selector now runs the new bytes, whose self-check the old ran.
      expect((await run(lazurio, "--version")).stdout).toContain(
        "lazurio 1.1.0 ",
      );
      expect(
        JSON.parse((await run(lazurio, "update", "status", "--json")).stdout),
      ).toMatchObject({
        running: "1.1.0",
        active: "1.1.0",
        previous: "1.0.0",
        highWater: "1.1.0",
        updateAvailable: false,
      });
      expect(await run(lazurio, "update")).toEqual({
        code: 0,
        stdout: "Lazurio 1.1.0 is up to date.",
        stderr: "",
      });
      expect((await run(lazurio, "update", "rollback")).stdout).toBe(
        "Rolled back from 1.1.0 to 1.0.0.",
      );
      expect((await run(lazurio, "--version")).stdout).toContain(
        "lazurio 1.0.0 ",
      );
      // Another command ends with the one-line notice, on stderr.
      const help = await run(lazurio, "--help");
      expect(help.code).toBe(0);
      expect(help.stderr).toBe(
        "Lazurio 1.1.0 is available (running 1.0.0). Run `lazurio update`. https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.0",
      );
      // The retry after a rollback: equal to the mark, not active.
      expect((await run(lazurio, "update", "--version", "v1.1.0")).code).toBe(
        0,
      );
      expect((await run(lazurio, "--version")).stdout).toContain(
        "lazurio 1.1.0 ",
      );

      // The installed Launchpad, started the way the service unit starts it,
      // serves the pill from the same install base: what the last check
      // verified, and a click for anything else is refused.
      const folder = join(home, "Lazurio");
      await initializeFolder(folder, {
        os: executionOs(process.platform),
        access: "local",
        purpose: "human",
        locale: "en",
        detail: "concise",
        coordination: "direct",
      });
      const launchpad = Bun.spawn(
        [lazurio, "launchpad", "--folder", folder, "--base", base],
        { cwd: home, env, stdout: "pipe", stderr: "pipe" },
      );
      try {
        const reader = launchpad.stdout.getReader();
        let text = "";
        while (!text.includes("\n")) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
        reader.releaseLock();
        const session = new URL(JSON.parse(text.split("\n")[0] ?? "").url);
        const auth = { Authorization: `Bearer ${session.hash.slice(1)}` };
        const status = await (
          await fetch(new URL("/api/update/status", session), { headers: auth })
        ).json();
        expect(status).toMatchObject({
          kind: "update-pill",
          state: "idle",
          running: "1.1.0",
          active: "1.1.0",
          latest: "1.1.0",
          action: null,
          supervised: false,
        });
        const refused = await fetch(new URL("/api/update/apply", session), {
          method: "POST",
          headers: {
            ...auth,
            "Content-Type": "application/json",
            Origin: session.origin,
          },
          body: JSON.stringify({ version: "1.0.0" }),
        });
        expect([refused.status, (await refused.json()).kind]).toEqual([
          409,
          "stale",
        ]);
      } finally {
        launchpad.kill("SIGTERM");
        await launchpad.exited;
      }
    } finally {
      await origin.close();
      await sigstore.close();
    }
  },
  180_000,
);
