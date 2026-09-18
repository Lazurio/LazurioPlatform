import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "independent owner processes cannot enter the same dependency scope concurrently",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "owner-process-test-")),
    );
    const module = new URL(
      "../src/modules/owner-operations.ts",
      import.meta.url,
    ).pathname;
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const spawn = () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        import { createOwnerOperations } from ${JSON.stringify(module)};
        const owner = createOwnerOperations();
        try {
          await owner.run(${JSON.stringify(root)}, async () => {
            console.log('entered');
            await Bun.stdin.stream().getReader().read();
          });
        } catch (error) {
          if (error.message !== 'Folder operation busy or requires recovery') throw error;
          console.log('busy');
        } finally { await owner.close(); }
      `,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      children.push(child);
      return child;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = spawn();
      const firstOutput = await first.stdout.getReader().read();
      expect(new TextDecoder().decode(firstOutput.value).trim()).toBe(
        "entered",
      );
      const second = spawn();
      const observation = await Promise.race([
        second.stdout
          .getReader()
          .read()
          .then((chunk) => new TextDecoder().decode(chunk.value).trim()),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("waiting"), 1000);
        }),
      ]);
      // Prove the expected refusal, not a crash, timeout or unrelated failure.
      // This test does not yet prove the running-app lifetime integration.
      expect(observation).toBe("busy");
    } finally {
      clearTimeout(timer);
      for (const child of children) {
        child.kill("SIGTERM");
        await child.exited;
      }
      await rm(root, { recursive: true });
    }
  },
  10000,
);
