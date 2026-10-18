import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import {
  type NewTabHost,
  newTabPageHeaders,
} from "../src/launchpad/new-tab-routes";
import { startLaunchpad } from "../src/launchpad/server";
import {
  binding,
  bindings,
  handoverEntry,
  organizationWithEntry,
  withBrowser,
} from "./fixtures/machine-bindings";
import organizationContext from "./fixtures/machine-context.json";
import { freePort } from "./fixtures/ports";

test.skipIf(process.platform === "win32")(
  "a Folder with a recorded entry serves on the gateway's loopback port behind the gateway's admission, with no fragment token",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-entry-")),
    );
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    const profile = presetProfile(preset, executionOs(process.platform));
    // The handover carries the entry; the Folder records it on the binding.
    const machine = organizationWithEntry(freePort());
    const entry = machine.entry;
    if (entry === undefined) throw new Error("The fixture has an entry");
    await initializeHandoverFolder(folder, { preset, machine, profile });
    const asked: string[] = [];
    const fetcher: AuthFetcher = async (url, init) => {
      expect(url).toBe(entry.authCheckUrl);
      const cookie = new Headers(init.headers).get("cookie") ?? "";
      asked.push(cookie);
      return cookie === "__Secure-lazurio-workspace=valid"
        ? new Response("ok")
        : new Response("no", { status: 401 });
    };
    const app = await startLaunchpad(folder, undefined, undefined, undefined, {
      fetcher,
    });
    try {
      expect(app.hosted).toBe(true);
      expect(app.url).toBe(`${entry.externalOrigin}/`);
      expect(app.server.port).toBe(entry.listenPort);
      const base = `http://127.0.0.1:${entry.listenPort}`;
      const host = "launchpad.workspace.example.lazurio.io";
      const valid = { host, cookie: "__Secure-lazurio-workspace=valid" };
      // The shell itself needs admission: no cookie, no page.
      const anonymous = await fetch(`${base}/`, { headers: { host } });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({
        error: "denied",
        reason: "cookie-missing",
      });
      // Admitted: the bundled page, through the loopback shell listener.
      const page = await fetch(`${base}/`, { headers: valid });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const shell = await page.text();
      expect(shell).toContain("<html");
      // A settings route is the same page through the same admission.
      expect(
        await (
          await fetch(`${base}/settings/tools`, { headers: valid })
        ).text(),
      ).toBe(shell);
      expect(
        (await fetch(`${base}/settings/tools`, { headers: { host } })).status,
      ).toBe(401);
      // So is a catalog route, and the catalog is read behind the same
      // admission as every other route.
      expect(
        await (await fetch(`${base}/o/alpha/web`, { headers: valid })).text(),
      ).toBe(shell);
      expect(
        (await fetch(`${base}/o/alpha/web`, { headers: { host } })).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${base}/api/catalog`, {
            method: "POST",
            headers: {
              host,
              "content-type": "application/json",
              origin: entry.externalOrigin,
            },
            body: "{}",
          })
        ).status,
      ).toBe(401);
      // Wrong Host is not this Machine's entry; forged identity is not evidence.
      expect(
        (
          await fetch(`${base}/`, {
            headers: { ...valid, host: "other.example" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${base}/`, {
            headers: {
              host,
              "x-forwarded-user": "admin",
              cookie: "__Secure-lazurio-workspace=forged",
            },
          })
        ).status,
      ).toBe(401);
      // The API: a state-changing request must be same-origin from the entry.
      const profileCall = (headers: Record<string, string>) =>
        fetch(`${base}/api/profile`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "{}",
        });
      expect((await profileCall(valid)).status).toBe(401);
      const admitted = await profileCall({
        ...valid,
        origin: entry.externalOrigin,
        "sec-fetch-site": "same-origin",
      });
      expect(admitted.status).toBe(200);
      const body = (await admitted.json()) as {
        revision: number;
        machine: { name: string };
      };
      expect(body.revision).toBe(1);
      expect(body.machine.name).toBe(bindings.organization.name);
      // Admitted, the catalog of the hosted Folder: its organizations/ is
      // empty here.
      const catalog = await fetch(`${base}/api/catalog`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...valid,
          origin: entry.externalOrigin,
          "sec-fetch-site": "same-origin",
        },
        body: "{}",
      });
      expect(catalog.status).toBe(200);
      expect(await catalog.json()).toEqual({
        kind: "catalog",
        organizations: [],
      });
      // No bearer token exists in hosted mode: a stray one changes nothing.
      expect(
        (
          await profileCall({
            ...valid,
            origin: entry.externalOrigin,
            "sec-fetch-site": "same-origin",
            authorization: "Bearer x",
          })
        ).status,
      ).toBe(200);
      // The endpoint was asked once per distinct cookie value; the positive answer is cached.
      expect(
        asked.filter((c) => c === "__Secure-lazurio-workspace=valid").length,
      ).toBe(1);
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

// Nová karta (decision F47 point 1): the page `/new-tab` is framed by the
// shell element in every app of the Environment, and only there. Behind the
// gateway it names exactly the entry's own app origins in `frame-ancestors`:
// the Launchpad (`'self'` and its external origin), T3 Code and MausBot as
// present, never the browser's view or anything else. No other page of the
// Launchpad changes its headers.
test("frame-ancestors of /new-tab: the entry's app origins as present, each once", () => {
  const headers = (mausbot?: string) =>
    newTabPageHeaders({
      externalOrigin: "https://launchpad.workspace.example.lazurio.io",
      t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
      ...(mausbot === undefined ? {} : { mausbotOrigin: mausbot }),
    });
  expect(headers()).toEqual({
    "Content-Security-Policy":
      "frame-ancestors 'self' https://launchpad.workspace.example.lazurio.io https://t3code.workspace.example.lazurio.io",
    "X-Content-Type-Options": "nosniff",
  });
  expect(
    headers("https://mausbot.workspace.example.lazurio.io")[
      "Content-Security-Policy"
    ],
  ).toBe(
    "frame-ancestors 'self' https://launchpad.workspace.example.lazurio.io https://t3code.workspace.example.lazurio.io https://mausbot.workspace.example.lazurio.io",
  );
});

test.skipIf(process.platform === "win32")(
  "hosted, /new-tab may be framed only by the Environment's own apps, and no other page changes its headers",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-new-tab-page-")),
    );
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    const host = "workspace.example.lazurio.io";
    const listenPort = freePort();
    const { team: _team, ...owner } = organizationContext.owner;
    // An entry with every app of decision F47 point 1 and the browser's
    // view, whose origin is no app's and must not frame Nová karta.
    const machine = binding({
      ...organizationContext,
      owner,
      entry: {
        ...withBrowser(handoverEntry(host, listenPort), host),
        mausbot: {
          external_origin: `https://mausbot.${host}`,
          listen_port: 4102,
        },
      },
    });
    await initializeHandoverFolder(folder, {
      preset,
      machine,
      profile: presetProfile(preset, executionOs(process.platform)),
    });
    const fetcher: AuthFetcher = async (_url, init) =>
      new Headers(init.headers).get("cookie") ===
      "__Secure-lazurio-workspace=valid"
        ? new Response("ok")
        : new Response("no", { status: 401 });
    // The holder file lives under this test's own runtime directory.
    const newTabHost: NewTabHost = {
      runtimeDirectory: join(parent, "run"),
      run: null,
      readFile: (path) => readFile(path, "utf8"),
      bootClock: async () => null,
      log: () => undefined,
    };
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      { fetcher },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      newTabHost,
    );
    try {
      const base = `http://127.0.0.1:${listenPort}`;
      const valid = {
        host: `launchpad.${host}`,
        cookie: "__Secure-lazurio-workspace=valid",
      };
      const page = await fetch(`${base}/new-tab`, { headers: valid });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toBe(
        `frame-ancestors 'self' https://launchpad.${host} https://t3code.${host} https://mausbot.${host}`,
      );
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("cache-control")).toBe("no-store");
      // Nová karta's own page, with the boot document a hosted Launchpad
      // writes into its pages.
      const html = await page.text();
      expect(html).toContain('<main class="nt" id="new-tab">');
      expect(html).toContain('id="lazurio-boot"');
      // Every other page as before: no frame-ancestors.
      for (const path of ["/", "/settings/tools", "/integrations"]) {
        const other = await fetch(`${base}${path}`, { headers: valid });
        expect([path, other.status]).toEqual([path, 200]);
        expect(other.headers.get("content-security-policy")).toBeNull();
        await other.text();
      }
      // Behind the same admission as every page.
      expect(
        (await fetch(`${base}/new-tab`, { headers: { host: valid.host } }))
          .status,
      ).toBe(401);
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

// Pablo (#30): the admitted shell is fetched from the inner listener by the
// Launchpad process itself, which inherits the Machine's environment. An
// ambient HTTP proxy must not be able to stand in for that inner listener.
// Bun resolves the proxy variables once per process, so the scenario runs in
// its own process with the hostile environment (tests/fixtures/hosted-shell-proxy.ts).
test.skipIf(process.platform === "win32")(
  "a hostile HTTP_PROXY in the Launchpad's environment cannot replace the admitted shell",
  async () => {
    const hostile = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("proxy replacement", { status: 418 }),
    });
    try {
      const proxy = `http://127.0.0.1:${hostile.port}`;
      // The child's environment: the proxy variables set, every exception unset.
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env))
        if (value !== undefined && !/^no_proxy$/i.test(key)) env[key] = value;
      env.HTTP_PROXY = proxy;
      env.http_proxy = proxy;
      env.ALL_PROXY = proxy;
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          join(import.meta.dir, "fixtures", "hosted-shell-proxy.ts"),
          String(freePort()),
        ],
        {
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
        status: number;
        html: boolean;
        replaced: boolean;
        proxied: number;
      };
      // The Launchpad answered the shell itself; the proxy never saw the request.
      expect(result).toEqual({
        status: 200,
        html: true,
        replaced: false,
        proxied: 0,
      });
    } finally {
      hostile.stop(true);
    }
  },
);
