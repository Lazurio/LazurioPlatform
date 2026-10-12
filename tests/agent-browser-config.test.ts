import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentBrowserConfigPath,
  agentBrowserIdleTimeout,
  ensureAgentBrowserIdleTimeout,
} from "../src/browser/agent-browser-config";

// agent-browser's daemons attach to the Environment browser over DevTools, and
// agent-browser's own idle default skips a browser it did not launch, so the
// Platform writes an explicit timeout into its user config (decision F47
// point 5, #326).

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
  });

  test("a file with other settings keeps them all and gains the hour", async () => {
    const directory = await home();
    const path = configOf(directory);
    await ensureAgentBrowserIdleTimeout({ HOME: directory });
    await writeFile(path, JSON.stringify({ headed: false, session: "x" }));
    expect(await ensureAgentBrowserIdleTimeout({ HOME: directory })).toBe(
      "set",
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      headed: false,
      session: "x",
      idleTimeout: "1h",
    });
  });

  test("an idle timeout someone chose is kept, and the file is not touched", async () => {
    const directory = await home();
    const path = configOf(directory);
    await ensureAgentBrowserIdleTimeout({ HOME: directory });
    const chosen = `${JSON.stringify({ idleTimeout: "15m" })}\n`;
    await writeFile(path, chosen);
    expect(await ensureAgentBrowserIdleTimeout({ HOME: directory })).toBe(
      "kept",
    );
    expect(await readFile(path, "utf8")).toBe(chosen);
  });

  test("a file that is not a JSON object is never written over", async () => {
    const directory = await home();
    const path = configOf(directory);
    await ensureAgentBrowserIdleTimeout({ HOME: directory });
    for (const text of ["{ broken", "[]", "null", '"1h"']) {
      await writeFile(path, text);
      expect(await ensureAgentBrowserIdleTimeout({ HOME: directory })).toBe(
        "unreadable",
      );
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });

  test("a file that cannot be read is left alone; only a missing one is created", async () => {
    const writes: string[] = [];
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(
      await ensureAgentBrowserIdleTimeout(
        { HOME: "/home/person" },
        {
          readFile: async () => {
            throw denied;
          },
          write: async (path) => {
            writes.push(path);
          },
        },
      ),
    ).toBe("unreadable");
    expect(writes).toEqual([]);
  });

  test("without an absolute HOME nothing is written", async () => {
    expect(await ensureAgentBrowserIdleTimeout({})).toBe("no-home");
  });
});
