import { expect, test } from "bun:test";
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
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { inspectProfileChange } from "../src/folder/inspect-profile-change";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { startLaunchpad } from "../src/launchpad/server";
import { bindings } from "./fixtures/machine-bindings";

// A hosted Folder as folder-init adopts it, plus a Launchpad session on it.
async function hostedSession(
  preset: "hosted-personal" | "hosted-organization-personal",
  machine: (typeof bindings)[keyof typeof bindings],
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-hosted-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const profile = presetProfile(preset, executionOs(process.platform));
  await initializeHandoverFolder(folder, { preset, machine, profile });
  const app = await startLaunchpad(folder);
  const url = new URL(app.url);
  const call = (path: string, body: unknown) =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
      },
      body: JSON.stringify(body),
    });
  return {
    folder,
    profile,
    call,
    async close() {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

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
        preset: { name: "local", version: 1, selection: "derived" },
        allowedPresets: ["local"],
        machine: null,
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
      expect(html).toContain("This Machine");
      expect(html).not.toContain('name="access"');
      expect(html).not.toContain(url.hash.slice(1));
    } finally {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "Launchpad shows the immutable handover, changes preset and axes through the same flow, and refuses a disallowed preset",
  async () => {
    const session = await hostedSession(
      "hosted-organization-personal",
      bindings.organization,
    );
    try {
      const shown = await (await session.call("/api/profile", {})).json();
      expect(shown).toEqual({
        revision: 1,
        preset: {
          name: "hosted-organization-personal",
          version: 1,
          selection: "derived",
        },
        allowedPresets: [
          "hosted-organization-personal",
          "hosted-organization-team",
        ],
        machine: bindings.organization,
        profile: session.profile,
      });
      const change = {
        expectedRevision: 1,
        preset: "hosted-organization-team",
        profile: { ...session.profile, locale: "cs", detail: "technical" },
      };
      expect(await (await session.call("/api/preview", change)).json()).toEqual(
        await inspectProfileChange(session.folder, 1, {
          preset: change.preset,
          profile: change.profile,
        }),
      );
      const refused = await session.call("/api/update", {
        ...change,
        preset: "hosted-personal",
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        kind: "blocked",
        reason: "preset-not-allowed",
      });
      expect(
        (
          await session.call("/api/update", {
            ...change,
            machine: null,
          })
        ).status,
      ).toBe(400);
      expect(await (await session.call("/api/update", change)).json()).toEqual({
        kind: "updated",
        revision: 2,
      });
      const after = await (await session.call("/api/profile", {})).json();
      expect(after.preset).toEqual({
        name: "hosted-organization-team",
        version: 1,
        selection: "explicit",
      });
      expect(after.machine).toEqual(bindings.organization);
      expect(after.profile.locale).toBe("cs");
      expect(
        await readFile(join(session.folder, "AGENTS.md"), "utf8"),
      ).toContain("hosted-organization-team");
    } finally {
      await session.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the profile API shows assignment and relationships exactly as recorded",
  async () => {
    const session = await hostedSession(
      "hosted-organization-personal",
      bindings.related,
    );
    try {
      const shown = await (await session.call("/api/profile", {})).json();
      expect(shown.machine).toEqual(
        JSON.parse(JSON.stringify(bindings.related)),
      );
      expect(shown.machine.relationships.peers).toHaveLength(3);
    } finally {
      await session.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "an Organization preset is refused on a personal VM handover",
  async () => {
    const session = await hostedSession("hosted-personal", bindings.personal);
    try {
      const shown = await (await session.call("/api/profile", {})).json();
      expect(shown.allowedPresets).toEqual(["hosted-personal"]);
      expect(shown.machine.owner).toEqual(bindings.personal.owner);
      for (const preset of [
        "hosted-organization-personal",
        "hosted-organization-team",
        "local",
      ]) {
        const refused = await session.call("/api/update", {
          expectedRevision: 1,
          preset,
          profile: session.profile,
        });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({
          kind: "blocked",
          reason: "preset-not-allowed",
        });
      }
      expect(
        (
          await session.call("/api/update", {
            expectedRevision: 1,
            preset: "hosted-team",
            profile: session.profile,
          })
        ).status,
      ).toBe(400);
      expect(
        await (
          await session.call("/api/update", {
            expectedRevision: 1,
            profile: { ...session.profile, coordination: "coordinator" },
          })
        ).json(),
      ).toEqual({ kind: "updated", revision: 2 });
    } finally {
      await session.close();
    }
  },
);
