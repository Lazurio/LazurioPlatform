import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { inspectProfileChange } from "../src/folder/inspect-profile-change";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";

test.skipIf(process.platform === "win32")(
  "Launchpad profile API shares core and denies cross-origin or uncredentialed changes",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-api-")),
    );
    const folder = join(parent, "Lazurio");
    const profile = {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    };
    await initializeFolder(folder, profile);
    const app = await startLaunchpad(folder);
    const url = new URL(app.url);
    const headers = {
      "Content-Type": "application/json",
      Origin: url.origin,
      Authorization: `Bearer ${url.hash.slice(1)}`,
    };
    const call = (path: string, body: unknown, override = {}) =>
      fetch(new URL(path, url), {
        method: "POST",
        headers: { ...headers, ...override },
        body: JSON.stringify(body),
      });
    try {
      const before = await readFile(join(folder, "AGENTS.md"));
      expect(
        (await call("/api/profile", {}, { Authorization: "" })).status,
      ).toBe(403);
      expect(
        (await call("/api/update", {}, { Origin: "https://untrusted.example" }))
          .status,
      ).toBe(403);
      expect(
        (await call("/api/update", {}, { Host: "untrusted.example" })).status,
      ).toBe(403);
      expect(await readFile(join(folder, "AGENTS.md"))).toEqual(before);
      expect(await (await call("/api/profile", {})).json()).toEqual({
        revision: 1,
        profile,
      });
      const candidate = {
        expectedRevision: 1,
        profile: { ...profile, locale: "cs" },
      };
      expect(await (await call("/api/preview", candidate)).json()).toEqual(
        await inspectProfileChange(folder, 1, { profile: candidate.profile }),
      );
      expect(await readFile(join(folder, "AGENTS.md"))).toEqual(before);
      expect(
        (await call("/api/update", { ...candidate, folder: parent })).status,
      ).toBe(400);
      expect(await (await call("/api/update", candidate)).json()).toEqual({
        kind: "updated",
        revision: 2,
      });
      expect((await call("/api/update", candidate)).status).toBe(409);
      await writeFile(join(folder, "AGENTS.md"), "manual work");
      expect(
        (await call("/api/update", { expectedRevision: 2, profile })).status,
      ).toBe(409);
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
        "manual work",
      );
      const html = await (await fetch(url.origin)).text();
      expect(html).toContain("Lazurio — Profile");
      expect(html).not.toContain(url.hash.slice(1));
    } finally {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
    }
  },
);
