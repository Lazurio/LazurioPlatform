import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { withFolderOperationLock } from "../src/folder/lock";
import { executionOs } from "../src/folder/platform";
import { resumeInitialization } from "../src/folder/resume-initialization";

// Compile for a source-free guest. This creates only isolated synthetic state.
// SIGKILL proves process-death exclusion, not power-loss durability.
const mode = process.argv[2];
const target = process.argv[3];
if (mode === "hold" && target) {
  await withFolderOperationLock(target, async () => {
    const consumer = Bun.spawn(["/bin/sleep", "30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    console.log(JSON.stringify({ held: true, consumer: consumer.pid }));
    await Bun.stdin.stream().getReader().read();
  });
} else if (mode === "initialize" && target) {
  await initializeFolder(
    target,
    {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    },
    async (step) => {
      if (step === process.argv[4]) process.exit(23);
    },
  );
} else {
  assert.equal(mode, undefined);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "owner-lock-smoke-")),
  );
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let consumer: number | undefined;
  const spawn = (...args: string[]) => {
    const argv = process.argv[1]?.endsWith(".ts")
      ? [process.execPath, process.argv[1], ...args]
      : [process.execPath, ...args];
    const child = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {},
    });
    children.push(child);
    return child;
  };
  const timeout = setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
  }, 20000);
  try {
    const held = spawn("hold", root);
    const first = await held.stdout.getReader().read();
    assert.equal(
      first.done,
      false,
      await new Response(first.done ? held.stderr : null).text(),
    );
    const observed = JSON.parse(new TextDecoder().decode(first.value));
    assert.equal(observed.held, true);
    assert.ok(Number.isSafeInteger(observed.consumer) && observed.consumer > 1);
    consumer = observed.consumer;
    await assert.rejects(
      withFolderOperationLock(root, async () => {}),
      /busy/,
    );
    held.kill("SIGKILL");
    await held.exited;
    process.kill(consumer as number, 0);
    await withFolderOperationLock(root, async () => {});
    assert.deepEqual(await readdir(join(root, ".operation-lock")), [
      "protocol",
    ]);
    for (const stop of [
      "journal",
      "instructions",
      "preferences",
      "manifest",
      "layout",
    ]) {
      const folder = join(root, stop);
      const child = spawn("initialize", folder, stop);
      assert.equal(
        await child.exited,
        23,
        await new Response(child.stderr).text(),
      );
      const before = await readFile(
        join(folder, ".lazurio/transaction/before.json"),
      );
      assert.deepEqual(await resumeInitialization(folder), {
        kind: "recovered",
        revision: 1,
      });
      assert.deepEqual(
        await readFile(
          join(folder, ".lazurio/history/initialization/before.json"),
        ),
        before,
      );
    }
    console.log(
      JSON.stringify({
        pass: true,
        platform: process.platform,
        arch: process.arch,
        kernelExclusion: true,
        sigkillRecovery: true,
        consumerDidNotInherit: true,
        initializationCheckpoints: 5,
      }),
    );
  } finally {
    clearTimeout(timeout);
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    if (consumer) {
      try {
        process.kill(consumer, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
}
