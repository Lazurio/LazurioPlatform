import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentBrowserConfigPath,
  agentBrowserIdleTimeout,
  defaultAgentBrowserConfigSeams,
  ensureAgentBrowserIdleTimeout,
} from "../src/browser/agent-browser-config";

// agent-browser's daemons attach to the Environment browser over DevTools, and
// agent-browser's own idle default skips a browser it did not launch, so the
// Platform writes an explicit timeout into its user config (decision F47
// point 5, #326), losing nothing of the person's (Pablo's review of #333).

const homes: string[] = [];
async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-config-"));
  homes.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of homes.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const configOf = (directory: string) =>
  join(directory, ".agent-browser", "config.json");

async function withConfig(text: string): Promise<string> {
  const directory = await home();
  await mkdir(join(directory, ".agent-browser"), { mode: 0o700 });
  await writeFile(configOf(directory), text);
  return directory;
}

/** Nothing staged is left behind beside the config. */
async function noStagedFiles(directory: string) {
  expect(
    (await readdir(join(directory, ".agent-browser"))).filter((name) =>
      name.endsWith(".tmp"),
    ),
  ).toEqual([]);
}

describe("agent-browser's idle timeout in its user config", () => {
  test("the config path is ~/.agent-browser/config.json, and none without an absolute HOME", () => {
    expect(agentBrowserConfigPath({ HOME: "/home/person" })).toBe(
      "/home/person/.agent-browser/config.json",
    );
    expect(agentBrowserConfigPath({})).toBeUndefined();
    expect(agentBrowserConfigPath({ HOME: "relative" })).toBeUndefined();
  });

  test("a missing file is created with only the hour, owner-only", async () => {
    const directory = await home();
    expect(await ensureAgentBrowserIdleTimeout({ HOME: directory })).toBe(
      "set",
    );
    const path = configOf(directory);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      idleTimeout: agentBrowserIdleTimeout,
    });
    expect(agentBrowserIdleTimeout).toBe("1h");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, ".agent-browser"))).mode & 0o777).toBe(
      0o700,
    );
    await noStagedFiles(directory);
  });

  test("a file with other settings keeps them all and gains the hour", async () => {
    const directory = await withConfig(
      JSON.stringify({ headed: false, session: "x" }),
    );
    expect(await ensureAgentBrowserIdleTimeout({ HOME: directory })).toBe(
      "set",
    );
    expect(JSON.parse(await readFile(configOf(directory), "utf8"))).toEqual({
      headed: false,
      session: "x",
      idleTimeout: "1h",
    });
    await noStagedFiles(directory);
  });

  test("an idle timeout someone chose is kept, and the file is not touched", async () => {
    const chosen = `${JSON.stringify({ idleTimeout: "15m" })}\n`;
    const directory = await withConfig(chosen);
    expect(await ensureAgentBrowserIdleTimeout({ HOME: directory })).toBe(
      "kept",
    );
    expect(await readFile(configOf(directory), "utf8")).toBe(chosen);
  });

  test("a file that is not a JSON object is never written over", async () => {
    for (const text of ["{ broken", "[]", "null", '"1h"']) {
      const directory = await withConfig(text);
      expect(await ensureAgentBrowserIdleTimeout({ HOME: directory })).toBe(
        "unreadable",
      );
      expect(await readFile(configOf(directory), "utf8")).toBe(text);
    }
  });

  test("a config that links into the person's own file stays a link, and that file is not touched", async () => {
    const directory = await home();
    const own = join(directory, "dotfiles-agent-browser.json");
    const text = JSON.stringify({ headed: true });
    await writeFile(own, text);
    await mkdir(join(directory, ".agent-browser"), { mode: 0o700 });
    await symlink(own, configOf(directory));
    expect(await ensureAgentBrowserIdleTimeout({ HOME: directory })).toBe(
      "not-a-file",
    );
    expect((await lstat(configOf(directory))).isSymbolicLink()).toBe(true);
    expect(await readFile(own, "utf8")).toBe(text);
    await noStagedFiles(directory);
  });

  test("a link to nothing is left as it is, never taken for a missing file", async () => {
    const directory = await home();
    const target = join(directory, "not-there.json");
    await mkdir(join(directory, ".agent-browser"), { mode: 0o700 });
    await symlink(target, configOf(directory));
    expect(await ensureAgentBrowserIdleTimeout({ HOME: directory })).toBe(
      "not-a-file",
    );
    expect((await lstat(configOf(directory))).isSymbolicLink()).toBe(true);
    await expect(stat(target)).rejects.toThrow();
  });

  test("a file the person creates while this creates one is kept, not replaced", async () => {
    const directory = await home();
    const theirs = `${JSON.stringify({ idleTimeout: "15m" })}\n`;
    expect(
      await ensureAgentBrowserIdleTimeout(
        { HOME: directory },
        {
          ...defaultAgentBrowserConfigSeams,
          stage: async (path, text) => {
            const staged = await defaultAgentBrowserConfigSeams.stage(
              path,
              text,
            );
            await writeFile(path, theirs);
            return staged;
          },
        },
      ),
    ).toBe("changed");
    expect(await readFile(configOf(directory), "utf8")).toBe(theirs);
    await noStagedFiles(directory);
  });

  test("a change the person makes after the read is kept, not replaced", async () => {
    const directory = await withConfig(JSON.stringify({ headed: false }));
    const theirs = JSON.stringify({ headed: false, idleTimeout: "15m" });
    expect(
      await ensureAgentBrowserIdleTimeout(
        { HOME: directory },
        {
          ...defaultAgentBrowserConfigSeams,
          stage: async (path, text) => {
            const staged = await defaultAgentBrowserConfigSeams.stage(
              path,
              text,
            );
            await writeFile(path, theirs);
            return staged;
          },
        },
      ),
    ).toBe("changed");
    expect(await readFile(configOf(directory), "utf8")).toBe(theirs);
    await noStagedFiles(directory);
  });

  test("a path that cannot be examined or read is left alone", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const staged: string[] = [];
    const seams = {
      ...defaultAgentBrowserConfigSeams,
      stage: async (path: string) => {
        staged.push(path);
        return `${path}.tmp`;
      },
    };
    expect(
      await ensureAgentBrowserIdleTimeout(
        { HOME: "/home/person" },
        {
          ...seams,
          state: async () => {
            throw denied;
          },
        },
      ),
    ).toBe("unreadable");
    expect(
      await ensureAgentBrowserIdleTimeout(
        { HOME: "/home/person" },
        {
          ...seams,
          state: async () => ({ kind: "file" }),
          readFile: async () => {
            throw denied;
          },
        },
      ),
    ).toBe("unreadable");
    expect(staged).toEqual([]);
  });

  test("without an absolute HOME nothing is written", async () => {
    expect(await ensureAgentBrowserIdleTimeout({})).toBe("no-home");
  });
});
