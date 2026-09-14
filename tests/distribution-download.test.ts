import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shared download passes signed repository success and refusal scenarios", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pilot-download-test-"));
  try {
    const payload = join(fixture, "candidate");
    await writeFile(payload, "Synthetic candidate bytes, never executed.");
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../scripts/smoke-tuf.ts", import.meta.url).pathname,
        payload,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("PASS: shared verified download");
  } finally {
    await rm(fixture, { recursive: true });
  }
}, 35_000);
