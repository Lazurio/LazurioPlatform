import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buddyIdle } from "../src/brain/host";
import type { ActiveWork } from "../src/buddy/gateway-refresh";
import { buddyT3Unit } from "../src/buddy/t3-runtime";
import type { ProcessRunner } from "../src/update/self-check";

// Whether Buddy is idle, so the brain's server may stop for a moment (a move,
// a vault's rebuild, search by meaning switched on). Fail closed: only a
// confirmed answer is idle. Fictional homes; no gateway or user manager.

async function home(
  options: Readonly<{ hermes?: boolean; t3?: boolean }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "brain-idle-"));
  if (options.hermes) await mkdir(join(root, ".hermes"), { recursive: true });
  if (options.t3) {
    await mkdir(join(root, ".config", "systemd", "user"), { recursive: true });
    await writeFile(
      join(root, ".config", "systemd", "user", buddyT3Unit),
      "[Service]\n",
    );
  }
  return root;
}

const systemd =
  (state: string | "timeout"): ProcessRunner =>
  async () => {
    if (state === "timeout") throw new Error("timeout");
    return {
      exitCode: state === "active" ? 0 : 3,
      stdout: `${state}\n`,
      stderr: "",
    };
  };
const work = (answer: ActiveWork) => async () => answer;

describe("is Buddy idle", () => {
  test("no Buddy at all: idle", async () => {
    expect(
      await buddyIdle({
        home: await home(),
        service: systemd("active"),
        activeWork: work("unknown"),
      }),
    ).toBe(true);
  });

  test("Buddy of Hermes: only his gateway's idle counts", async () => {
    const at = await home({ hermes: true });
    for (const [answer, idle] of [
      ["idle", true],
      ["busy", false],
      ["unknown", false],
    ] as const)
      expect(
        await buddyIdle({
          home: at,
          service: systemd("inactive"),
          activeWork: work(answer),
        }),
      ).toBe(idle);
  });

  test("Buddy GEN4 in T3 Code: busy while T3 Code runs or systemd does not answer, idle only when it is stopped", async () => {
    const at = await home({ t3: true });
    for (const [state, idle] of [
      ["active", false],
      ["activating", false],
      ["timeout", false],
      ["inactive", true],
      ["failed", true],
    ] as const)
      expect(
        await buddyIdle({
          home: at,
          service: systemd(state),
          activeWork: work("idle"),
        }),
      ).toBe(idle);
  });

  test("a home that cannot be read is never taken for no Buddy", async () => {
    if (process.getuid?.() === 0) return;
    const at = await home();
    await mkdir(join(at, ".config"));
    await chmod(join(at, ".config"), 0o000);
    const hidden = await home();
    await chmod(hidden, 0o000);
    try {
      for (const where of [at, hidden])
        expect(
          await buddyIdle({
            home: where,
            service: systemd("inactive"),
            activeWork: work("idle"),
          }),
        ).toBe(false);
    } finally {
      await chmod(join(at, ".config"), 0o755);
      await chmod(hidden, 0o755);
    }
  });
});
