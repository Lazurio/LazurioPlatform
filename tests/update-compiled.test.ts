import { afterAll, expect, test } from "bun:test";
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
  createFixtureSigstore,
  writeFixtureRelease,
} from "../scripts/update-fixture";
import { createFixtureOrigin } from "../scripts/update-fixture-server";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { resolveInstallBase } from "../src/update/base";
import { identityDefines, nativeTarget } from "../src/update/identity";

// The REAL executable, compiled the way a release is (`identityDefines`), goes
// through install -> check -> update against the signed loopback origin, runs
// its Launchpad probe, and serves Recovery mode instead of exiting. Its origin and trust root are the FIXTURE define; a release
// build has neither. HOME is a temporary directory: the person's real install
// base is never touched.
const target = nativeTarget(process.platform, process.arch);
const commit = "0123456789abcdef0123456789abcdef01234567";
let root: string | undefined;
afterAll(async () => root && rm(root, { recursive: true, force: true }));

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a compiled product installs itself, updates to an attested release with no way back, probes its Launchpad and serves Recovery mode",
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
      ).toMatchObject({
        kind: "installed",
        active: "1.0.0",
        path: join(home, ".local", "bin"),
        serviceInstalled: false,
        entry: { state: "created", target: join(base, "bin", "lazurio") },
      });
      // The standard entry runs the active version.
      expect(
        (await run(join(home, ".local", "bin", "lazurio"), "--version")).stdout,
      ).toContain("lazurio 1.0.0 ");
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
        // No Folder is known to this installation.
        folderRefresh: null,
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
        highWater: "1.1.0",
        legacyRollbackState: false,
        updateAvailable: false,
      });
      // Only the active version is kept, and nothing names another.
      expect(await readdir(join(base, "versions"))).toEqual(["1.1.0"]);
      expect((await readdir(base)).sort()).toEqual([
        "bin",
        "update",
        "versions",
      ]);
      expect(await run(lazurio, "update")).toEqual({
        code: 0,
        stdout: "Lazurio 1.1.0 is up to date.",
        stderr: "",
      });
      // There is no way back: not as a command, not below the floor by name.
      expect((await run(lazurio, "update", "rollback")).code).toBe(2);
      expect(
        JSON.parse(
          (await run(lazurio, "update", "--version", "v1.0.0", "--json"))
            .stdout,
        ),
      ).toMatchObject({
        code: "release-invalid",
        context: { reason: "below-floor" },
      });
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
      // The Launchpad probe of the compiled bytes: the start sequence against
      // the real Folder and its embedded page, read-only, on a private socket.
      const state = join(folder, ".lazurio");
      const stateBefore = (await readdir(state)).sort();
      const probe = await run(
        lazurio,
        "self-check",
        "--json",
        "--base",
        base,
        "--folder",
        folder,
        "--launchpad",
      );
      expect(probe.code).toBe(0);
      expect(JSON.parse(probe.stdout)).toMatchObject({
        identity: { version: "1.1.0" },
        launchpad: { probe: "ok" },
      });
      expect((await readdir(state)).sort()).toEqual(stateBefore);
      const firstLine = async (child: Bun.Subprocess<"ignore", "pipe">) => {
        const reader = child.stdout.getReader();
        let text = "";
        while (!text.includes("\n")) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
        reader.releaseLock();
        return JSON.parse(text.split("\n")[0] ?? "");
      };
      const launchpad = Bun.spawn(
        [lazurio, "launchpad", "--folder", folder, "--base", base],
        { cwd: home, env, stdout: "pipe", stderr: "pipe" },
      );
      try {
        const session = new URL((await firstLine(launchpad)).url);
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

      // An interrupted Folder change: the probe refuses by name, and the
      // Launchpad does not exit — it serves Recovery mode and answers the
      // health socket with 503, until it is stopped.
      await mkdir(join(state, "transaction"));
      const refused = await run(
        lazurio,
        "self-check",
        "--json",
        "--base",
        base,
        "--folder",
        folder,
        "--launchpad",
      );
      expect([refused.code, JSON.parse(refused.stdout)]).toEqual([
        1,
        { launchpadRefused: "folder-transaction-pending" },
      ]);
      const recovering = Bun.spawn(
        [lazurio, "launchpad", "--folder", folder, "--base", base],
        { cwd: home, env, stdout: "pipe", stderr: "pipe" },
      );
      try {
        const started = await firstLine(recovering);
        expect(started).toMatchObject({
          scope: "recovery-mode",
          check: "start-refused",
          reason: "folder-transaction-pending",
        });
        // The Recovery page from the compiled bundle, and its evidence:
        // `lazurio recover --json` for this Folder, with the link's credential.
        const page = await fetch(started.url);
        expect(page.status).toBe(503);
        expect(await page.text()).toContain('id="section-recovery"');
        const evidence = await fetch(new URL("/api/recovery", started.url), {
          headers: {
            authorization: `Bearer ${new URL(started.url).hash.slice(1)}`,
          },
        });
        expect(evidence.status).toBe(200);
        expect(await evidence.json()).toMatchObject({
          kind: "recovery",
          verdict: "broken",
          evidence: { check: "folder-state", code: "folder-state-pending" },
        });
        const health = await fetch("http://launchpad/health", {
          unix: join(base, "update", "launchpad.sock"),
        });
        expect(health.status).toBe(503);
        expect(recovering.exitCode).toBeNull();
      } finally {
        recovering.kill("SIGTERM");
        expect(await recovering.exited).toBe(0);
      }
    } finally {
      await origin.close();
      await sigstore.close();
    }
  },
  180_000,
);
