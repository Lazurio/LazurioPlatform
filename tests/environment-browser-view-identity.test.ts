import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readViewIdentity } from "../src/browser/people/serve";
import { pageIdentitySource } from "../src/browser/people/service";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { shellDocumentPath, startLaunchpad } from "../src/launchpad/server";
import { parseShell } from "../src/shell/contract";
import { shellMessages } from "../src/shell/messages";
import {
  type EnvironmentIdentity,
  environmentIdentity,
} from "../src/shell/view";
import {
  assignments,
  binding,
  handoverEntry,
  withBrowser,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";

// F39's addendum of 2026-10-12: unframed (a bare tab, the panel's pop-out, a
// phone), the Environment browser's view names its Environment by the
// identity its own server reads, the same producer and the same
// `environmentIdentity` as the switcher of the Environment's apps, so the
// two say the same; a framed view then takes the app's answer, which adds
// only a name the Dashboard gave. The page never waits long for it.

const posixTest = test.skipIf(process.platform === "win32");

const identity = (name: string): EnvironmentIdentity => ({
  id: "vm-01.example",
  name,
  who: "@example",
  glyph: { kind: "icon", icon: "user" },
});

const later = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("the page's identity is read for each page, never awaited long", () => {
  test("a quick read is the page's identity", async () => {
    const source = pageIdentitySource(async () => identity("Pracovní"), 50);
    expect(await source()).toEqual(identity("Pracovní"));
  });

  test("a slow read gives the last one, none before the first, and is kept for the next page", async () => {
    let name = "Pracovní";
    let delay = 200;
    const source = pageIdentitySource(async () => {
      const read = identity(name);
      await later(delay);
      return read;
    }, 20);
    expect(await source()).toBeNull();
    await later(250);
    name = "Prodej";
    expect(await source()).toEqual(identity("Pracovní"));
    delay = 0;
    await later(250);
    expect(await source()).toEqual(identity("Prodej"));
  });

  test("a failed read keeps the last one; positively none is none", async () => {
    let answer: "identity" | "fail" | "none" = "identity";
    const source = pageIdentitySource(async () => {
      if (answer === "fail") throw new Error("the Folder cannot be read");
      return answer === "none" ? null : identity("Pracovní");
    }, 50);
    expect(await source()).toEqual(identity("Pracovní"));
    answer = "fail";
    expect(await source()).toEqual(identity("Pracovní"));
    answer = "none";
    expect(await source()).toBeNull();
  });
});

// A work Environment of `example`, assigned to the person `example`, whose
// gateway routes the view (root decision 0191).
const { team: _team, ...owner } = organization.owner;
const assigned = (listenPort: number, host: string) =>
  binding({
    ...organization,
    owner: { ...owner, assignment: assignments.operator },
    entry: withBrowser(handoverEntry(host, listenPort), host),
  });

posixTest(
  "the view's own identity is what the Launchpad's /.lazurio/shell.json names, read from the same Folder",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "view-identity-")),
    );
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port ?? 0;
    probe.stop(true);
    const preset = "hosted-organization-personal";
    const host = "workspace.example.lazurio.io";
    await initializeHandoverFolder(folder, {
      preset,
      machine: assigned(port, host),
      profile: presetProfile(preset, executionOs(process.platform), {
        locale: "cs",
      }),
    });
    const ownerKey = async () => "Example";
    const app = await startLaunchpad(folder, undefined, undefined, undefined, {
      fetcher: async (_url, init) =>
        new Headers(init.headers).get("cookie") ===
        "__Secure-lazurio-workspace=valid"
          ? new Response("ok")
          : new Response("no", { status: 401 }),
      ownerKey,
    });
    try {
      const answer = await fetch(
        `http://127.0.0.1:${port}${shellDocumentPath}`,
        {
          headers: {
            host: `launchpad.${host}`,
            cookie: "__Secure-lazurio-workspace=valid",
          },
        },
      );
      const shell = parseShell(await answer.json());
      if (shell === null || shell.current === null)
        throw new Error("The Launchpad names its Environment");
      const switcher = environmentIdentity(
        shell,
        shell.current,
        shellMessages(shell.locale),
      );
      expect(switcher).toMatchObject({
        id: "workspace.example",
        name: "Pracovní",
        who: "",
        glyph: {
          kind: "avatar",
          organization: "Example",
          avatar: "https://github.com/example.png?size=96",
        },
      });
      expect(await readViewIdentity(async () => folder, ownerKey)).toEqual(
        switcher,
      );
      // Without a hosted Folder there is no identity; an unreadable one
      // rejects, and the page keeps its last.
      expect(await readViewIdentity(async () => undefined)).toBeNull();
      await expect(
        readViewIdentity(async () => join(parent, "missing"), ownerKey),
      ).rejects.toThrow();
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);
