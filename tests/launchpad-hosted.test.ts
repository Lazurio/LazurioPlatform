import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  type AuthFetcher,
  parseHostedEntry,
} from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import { bindings } from "./fixtures/machine-bindings";

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  return port;
};

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
    const entry = parseHostedEntry({
      externalOrigin: "https://launchpad.workspace.example.lazurio.io",
      authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
      authCookieName: "__Secure-lazurio-workspace",
      listenPort: freePort(),
    });
    // The handover carries the entry; the Folder records it on the binding.
    await initializeHandoverFolder(folder, {
      preset,
      machine: { ...bindings.organization, entry },
      profile,
    });
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
      expect(await page.text()).toContain("<html");
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

// Pablo (#30): the admitted shell is fetched from the inner listener by the
// Launchpad process itself, which inherits the Machine's environment. An
// ambient HTTP proxy must not be able to stand in for that inner listener.
test.skipIf(process.platform === "win32")(
  "a hostile HTTP_PROXY in the Launchpad's environment cannot replace the admitted shell",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-entry-proxy-")),
    );
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    const profile = presetProfile(preset, executionOs(process.platform));
    const entry = parseHostedEntry({
      externalOrigin: "https://launchpad.workspace.example.lazurio.io",
      authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
      authCookieName: "__Secure-lazurio-workspace",
      listenPort: freePort(),
    });
    await initializeHandoverFolder(folder, {
      preset,
      machine: { ...bindings.organization, entry },
      profile,
    });
    // A proxy that answers everything with a replacement body.
    const hostile = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("proxy replacement", { status: 418 }),
    });
    const saved = { ...process.env };
    process.env.HTTP_PROXY = `http://127.0.0.1:${hostile.port}`;
    process.env.http_proxy = process.env.HTTP_PROXY;
    process.env.ALL_PROXY = process.env.HTTP_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    const fetcher: AuthFetcher = async () => new Response("ok");
    const app = await startLaunchpad(folder, undefined, undefined, undefined, {
      fetcher,
    });
    try {
      // The test's own request goes through node:http, which ignores proxy variables.
      const { request } = await import("node:http");
      const got = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = request(
            {
              host: "127.0.0.1",
              port: entry.listenPort,
              path: "/",
              method: "GET",
              headers: {
                host: "launchpad.workspace.example.lazurio.io",
                cookie: "__Secure-lazurio-workspace=valid",
              },
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                body += chunk;
              });
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, body }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
      expect(got.status).toBe(200);
      expect(got.body).toContain("<html");
      expect(got.body).not.toContain("proxy replacement");
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      hostile.stop(true);
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
