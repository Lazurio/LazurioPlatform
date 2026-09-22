import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resumeInitialization } from "../src/folder/resume-initialization";

for (const stop of [
  "journal",
  "instructions",
  "manual",
  "preferences",
  "manifest",
  "layout",
] as const) {
  test.skipIf(process.platform === "win32")(
    `abrupt process exit at initialization ${stop} resumes under kernel exclusion`,
    async () => {
      const parent = await realpath(
        await mkdtemp(join(tmpdir(), "init-process-death-")),
      );
      const folder = join(parent, "Lazurio");
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            "-e",
            `import { initializeFolder } from ${JSON.stringify(resolve("src/folder/initialize-folder.ts"))};
         await initializeFolder(${JSON.stringify(folder)}, {
           os: process.platform === "darwin" ? "macos" : "linux",
           access: "local", purpose: "human", locale: "en", detail: "concise", coordination: "direct"
         }, async (step) => { if (step === ${JSON.stringify(stop)}) process.exit(23); });`,
          ],
          { env: {}, stdout: "pipe", stderr: "pipe" },
        );
        const [status, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect(status, stderr).toBe(23);
        const state = join(folder, ".lazurio");
        const journal = join(state, "transaction");
        const entries = (await readdir(journal)).sort();
        const before = await Promise.all(
          entries.map((name) => readFile(join(journal, name))),
        );
        expect(entries).toContain("before.json");
        expect(await readdir(join(state, ".operation-lock"))).toEqual([
          "protocol",
        ]);
        expect(await resumeInitialization(folder)).toEqual({
          kind: "recovered",
          revision: 1,
        });
        const archived = join(state, "history", "initialization");
        for (const [index, name] of entries.entries()) {
          const retained = before[index];
          if (!retained) throw new Error("Missing journal snapshot");
          expect(await readFile(join(archived, name))).toEqual(retained);
        }
        expect(await readdir(join(state, ".operation-lock"))).toEqual([
          "protocol",
        ]);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
}
