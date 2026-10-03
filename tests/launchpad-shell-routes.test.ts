import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { parseCatalog } from "../src/launchpad/catalog-view";
import { privatePage, shellSource } from "../src/launchpad/page";
import { startLaunchpad } from "../src/launchpad/server";
import { checkBundledPage } from "../src/launchpad/start-check";
import { parseShell } from "../src/shell/contract";
import { shellFonts } from "../src/shell/fonts";
import { folderFixture, writeOrganization } from "./fixtures/catalog-folder";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// Decision F36: `/.lazurio/shell.js` and `/.lazurio/fonts/*` are static
// assets of this executable, served like the page's own (locally without the
// token, hosted only after the gateway's admission); `/.lazurio/shell.json`
// is data, behind the same admission as every read.

const posixTest = test.skipIf(process.platform === "win32");

test("the shell script defines the elements and nothing of a Folder", () => {
  expect(shellSource).toContain('customElements.define("lazurio-rail"');
  expect(shellSource).toContain("lazurio-column-head");
  expect(shellSource).toContain("/.lazurio/shell.json");
  // No `<lazurio-buddy>` yet: reserved in the contract, not defined.
  expect(shellSource).not.toContain('define("lazurio-buddy"');
});

posixTest(
  "locally: the script and fonts without the token, the document only with it",
  async () => {
    await folderFixture(async (folder) => {
      const app = await startLaunchpad(folder);
      const session = new URL(app.url);
      const token = session.hash.slice(1);
      try {
        const script = await fetch(new URL("/.lazurio/shell.js", session));
        expect(script.status).toBe(200);
        expect(script.headers.get("content-type")).toContain("javascript");
        expect(await script.text()).toBe(shellSource);
        const [font] = shellFonts;
        const served = await fetch(
          new URL(`/.lazurio/fonts/${font?.file}`, session),
        );
        expect(served.status).toBe(200);
        expect(served.headers.get("content-type")).toBe("font/woff2");
        expect(
          createHash("sha256")
            .update(Buffer.from(await served.arrayBuffer()))
            .digest("hex"),
        ).toBe(
          createHash("sha256")
            .update(
              await readFile(
                join(
                  import.meta.dir,
                  "..",
                  "src/shell/vendor/fonts",
                  font?.file ?? "",
                ),
              ),
            )
            .digest("hex"),
        );
        expect(
          (await fetch(new URL("/.lazurio/fonts/../shell.json", session)))
            .status,
        ).not.toBe(200);
        expect(
          (await fetch(new URL("/.lazurio/fonts/other.woff2", session))).status,
        ).toBe(404);
        // The document: refused without the token, with a foreign Origin or
        // Host, answered with it.
        const document = new URL("/.lazurio/shell.json", session);
        expect((await fetch(document)).status).toBe(403);
        expect(
          (
            await fetch(document, {
              headers: {
                Authorization: `Bearer ${token}`,
                Origin: "https://other.example.invalid",
              },
            })
          ).status,
        ).toBe(403);
        const answer = await fetch(document, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(answer.status).toBe(200);
        expect(answer.headers.get("cache-control")).toBe("no-store");
        const shell = parseShell(await answer.json());
        expect(shell?.environments.map((entry) => entry.kind)).toEqual([
          "workstation",
        ]);
        // Every readable Organization of the fixture, once per slug, no
        // template and no unreadable one.
        expect(shell?.organizations.map((entry) => entry.slug)).toEqual([
          "alpha",
          "beta",
          "delta",
        ]);
        expect(
          (
            await fetch(document, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Origin: session.origin,
              },
              body: "{}",
            })
          ).status,
        ).toBe(405);
      } finally {
        await app.close();
      }
    });
  },
  30_000,
);

posixTest(
  "hosted: the script, the fonts and the document only after the gateway's admission",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-shell-")),
    );
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port ?? 0;
    probe.stop(true);
    const preset = "hosted-organization-personal";
    const machine = organizationWithEntry(port);
    await initializeHandoverFolder(folder, {
      preset,
      machine,
      profile: presetProfile(preset, executionOs(process.platform), {
        locale: "cs",
      }),
    });
    const app = await startLaunchpad(folder, undefined, undefined, undefined, {
      fetcher: async (_url, init) =>
        new Headers(init.headers).get("cookie") ===
        "__Secure-lazurio-workspace=valid"
          ? new Response("ok")
          : new Response("no", { status: 401 }),
    });
    const base = `http://127.0.0.1:${port}`;
    const host = "launchpad.workspace.example.lazurio.io";
    const valid = { host, cookie: "__Secure-lazurio-workspace=valid" };
    try {
      for (const path of [
        "/.lazurio/shell.js",
        "/.lazurio/shell.json",
        `/.lazurio/fonts/${shellFonts[0].file}`,
      ]) {
        expect(
          (await fetch(`${base}${path}`, { headers: { host } })).status,
        ).toBe(401);
        expect(
          (
            await fetch(`${base}${path}`, {
              headers: { host, cookie: "__Secure-lazurio-workspace=forged" },
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await fetch(`${base}${path}`, {
              headers: { ...valid, host: "other.example" },
            })
          ).status,
        ).toBe(401);
      }
      const script = await fetch(`${base}/.lazurio/shell.js`, {
        headers: valid,
      });
      expect(script.status).toBe(200);
      expect(await script.text()).toBe(shellSource);
      const answer = await fetch(`${base}/.lazurio/shell.json`, {
        headers: valid,
      });
      expect(answer.status).toBe(200);
      const shell = parseShell(await answer.json());
      expect(shell?.locale).toBe("cs");
      expect(shell?.environments[0]).toEqual({
        id: machine.name,
        label: machine.name,
        kind: "work",
        organizations: [],
        apps: {
          apps: "https://launchpad.workspace.example.lazurio.io/",
          chat: "https://t3code.workspace.example.lazurio.io/",
          automate: null,
        },
      });
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);

posixTest(
  "valid but long declarations keep the shell document and the page's catalog readable",
  async () => {
    await folderFixture(async (folder) => {
      // A display name the manifest admits (nonblank, a tab inside, longer
      // than the shell's 128) and an app whose valid runtime declaration has
      // an id and a tag longer than the page's catalog bounds.
      await writeOrganization(folder, "longname_GEN3", {
        slug: "longname",
        state: "current",
        displayName: `Long\t${"N".repeat(129)}`,
        modules: [
          {
            id: "orders",
            runtime: {
              id: "o".repeat(140),
              title: "Orders v2",
              tags: ["a".repeat(129), "sales"],
            },
          },
        ],
      });
      // Characters outside the Basic Multilingual Plane: 65 of them are 130
      // UTF-16 units, past the contract's 128.
      await writeOrganization(folder, "wide_GEN3", {
        slug: "wide",
        state: "current",
        displayName: "\u{1F680}".repeat(65),
        modules: [{ id: "site" }],
      });
      const app = await startLaunchpad(folder);
      const session = new URL(app.url);
      const token = session.hash.slice(1);
      try {
        const answer = await fetch(new URL("/.lazurio/shell.json", session), {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(answer.status).toBe(200);
        const shell = parseShell(await answer.json());
        const name = shell?.organizations.find(
          (entry) => entry.slug === "longname",
        )?.name;
        expect(name).toBe(`Long ${"N".repeat(123)}`);
        expect(name?.length).toBe(128);
        // Cut between characters, never inside one: 64 whole ones.
        expect(
          shell?.organizations.find((entry) => entry.slug === "wide")?.name,
        ).toBe("\u{1F680}".repeat(64));
        const catalog = await fetch(new URL("/api/catalog", session), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: session.origin,
            Authorization: `Bearer ${token}`,
          },
          body: "{}",
        });
        expect(catalog.status).toBe(200);
        const parsed = parseCatalog(await catalog.json());
        expect(parsed).not.toBeNull();
        const display = parsed?.organizations
          .find((entry) => entry.organization === "longname")
          ?.modules.find((entry) => entry.module === "orders")?.display;
        expect(display?.title).toBe("Orders v2");
        expect(display?.id).toBe("o".repeat(128));
        expect(display?.tags).toEqual(["sales"]);
      } finally {
        await app.close();
      }
    });
  },
  30_000,
);

test("a bundle that does not serve the shell script does not start", async () => {
  // The page and the script serve from this executable's bundle.
  expect(await privatePage(checkBundledPage)).toBe(true);
  expect(
    await checkBundledPage(async (path) =>
      path === "/.lazurio/shell.js"
        ? new Response("not-found", { status: 404 })
        : new Response('<html><script src="/x.js"></script></html>', {
            headers: { "content-type": "text/html" },
          }),
    ),
  ).toBe(false);
});
