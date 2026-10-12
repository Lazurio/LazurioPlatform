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
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import type { SshAccessHost, TailnetName } from "../src/ssh-access/host";
import { runTool } from "../src/tools/status";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// Settings → SSH from your devices over HTTP (decision F49): the three routes
// behind the admission of every route (locally the token and same origin,
// hosted the gateway's session and same origin for a write), JSON only, the
// exact fields, and the refusals of the core answered as 400 and 409. A
// temporary home and host key stand in for the account's; the real `~/.ssh`
// is never touched.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

const deviceKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDSQ6IIHQipQN9YXjjwhCNuecXaQZ6xS2/QbEsUFltVy";
const deviceFingerprint = "SHA256:o/4CeG0P+h9I7TE9MUuHkiJxKeDhAX4agiNUhz2gZsM";
// The Environment's host key: "ssh-ed25519" and 32 bytes, as wire strings.
const wire = (bytes: Buffer) =>
  Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
const hostKey = Buffer.concat([
  wire(Buffer.from("ssh-ed25519")),
  wire(Buffer.alloc(32, 7)),
]).toString("base64");

async function sshHost(parent: string): Promise<SshAccessHost> {
  const home = join(parent, "home");
  await mkdir(home, { mode: 0o700 });
  const hostKeyPath = join(parent, "ssh_host_ed25519_key.pub");
  await writeFile(hostKeyPath, `ssh-ed25519 ${hostKey} root@alex-work\n`);
  const tailnet: TailnetName = {
    state: "known",
    dnsName: "alex-work.example-org.ts.example",
  };
  return {
    platform: process.platform,
    home,
    uid: process.getuid?.(),
    user: "alex",
    today: () => "2026-10-12",
    hostKeyPath,
    tailnet: async () => tailnet,
  };
}

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

async function local() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-ssh-")),
  );
  const host = await sshHost(parent);
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {},
    {
      path: "/usr/bin:/bin",
      home: host.home,
      xdg: {},
      platform: process.platform,
      run: runTool,
    },
    {},
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
    host,
  );
  const url = new URL(app.url);
  const token = url.hash.slice(1);
  const send = (
    route: string,
    init: { method?: string; body?: string; headers?: Record<string, string> },
  ) =>
    fetch(new URL(route, url.origin), {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  const post = async (route: string, body: unknown) => {
    const response = await send(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url.origin },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const read = async () => {
    const response = await send("/api/ssh", {});
    return { status: response.status, body: (await response.json()) as Json };
  };
  return {
    host,
    url,
    send,
    post,
    read,
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test.skipIf(!posix)(
  "a device is added, read back with the settings for a computer, and removed",
  async () => {
    const s = await local();
    try {
      const computer = {
        state: "ready",
        alias: "alex-work",
        keyPath: "~/.ssh/alex-work-ed25519",
        config: [
          "Host alex-work",
          "  HostName alex-work.example-org.ts.example",
          "  User alex",
          "  IdentityFile ~/.ssh/alex-work-ed25519",
          "  IdentitiesOnly yes",
          "  HostKeyAlias alex-work",
          "  UserKnownHostsFile ~/.ssh/known_hosts_lazurio",
          "  StrictHostKeyChecking yes",
        ].join("\n"),
        knownHosts: `alex-work ssh-ed25519 ${hostKey}`,
      };
      expect(await s.read()).toEqual({
        status: 200,
        body: {
          kind: "ssh-access",
          supported: true,
          keys: [],
          problem: null,
          computer,
        },
      });
      const key = {
        origin: "launchpad",
        type: "ssh-ed25519",
        fingerprint: deviceFingerprint,
        device: "alex-laptop",
        addedBy: "alex",
        added: "2026-10-12",
      };
      expect(
        await s.post("/api/ssh/add", {
          device: "Alex Laptop",
          publicKey: `${deviceKey} alex@alex-laptop\n`,
          addedBy: "Alex",
        }),
      ).toEqual({
        status: 200,
        body: { kind: "ssh-key-added", outcome: "added", key, computer },
      });
      // Retried as an agent would: nothing more is written.
      expect(
        await s.post("/api/ssh/add", {
          device: "alex-laptop",
          publicKey: deviceKey,
        }),
      ).toMatchObject({
        status: 200,
        body: { outcome: "already-present", key },
      });
      expect(
        await readFile(join(s.host.home, ".ssh", "authorized_keys"), "utf8"),
      ).toBe(`${deviceKey} lazurio-device:alex-laptop:alex:2026-10-12\n`);
      expect((await s.read()).body.keys).toEqual([key]);
      expect(
        await s.post("/api/ssh/remove", { fingerprint: deviceFingerprint }),
      ).toEqual({
        status: 200,
        body: { kind: "ssh-key-removed", key, stillAllowed: false },
      });
      expect(
        await s.post("/api/ssh/remove", { fingerprint: deviceFingerprint }),
      ).toEqual({
        status: 404,
        body: { kind: "blocked", reason: "not-found" },
      });
      // Without an account login the page names, the key says `local`.
      expect(
        await s.post("/api/ssh/add", { device: "box", publicKey: deviceKey }),
      ).toMatchObject({ body: { key: { addedBy: "local" } } });
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "what was sent is refused as 400, the file and a foreign key as 409",
  async () => {
    const s = await local();
    try {
      const refused = async (body: unknown) =>
        await s.post("/api/ssh/add", body);
      expect(
        await refused({
          device: "alex-laptop",
          publicKey: "ssh-rsa AAAAB3Nza x",
        }),
      ).toEqual({
        status: 400,
        body: { kind: "blocked", reason: "unsupported-type" },
      });
      expect(
        await refused({
          device: "alex-laptop",
          publicKey: `command="true" ${deviceKey}`,
        }),
      ).toMatchObject({ status: 400, body: { reason: "options-not-allowed" } });
      expect(
        await refused({ device: "---", publicKey: deviceKey }),
      ).toMatchObject({ status: 400, body: { reason: "invalid-name" } });
      expect(
        await refused({
          device: "alex-laptop",
          publicKey: deviceKey,
          addedBy: "not a login",
        }),
      ).toMatchObject({ status: 400, body: { reason: "invalid-added-by" } });
      // Exactly the fields of the route.
      expect(
        await refused({ device: "a", publicKey: deviceKey, path: "/etc" }),
      ).toEqual({ status: 400, body: { error: "invalid-request" } });
      expect(await refused({ device: "a" })).toEqual({
        status: 400,
        body: { error: "invalid-request" },
      });
      expect(
        await s.post("/api/ssh/remove", { fingerprint: "SHA256:short" }),
      ).toEqual({ status: 400, body: { error: "invalid-fingerprint" } });
      // A key added outside Launchpad is never removed here.
      await mkdir(join(s.host.home, ".ssh"), { mode: 0o700 });
      await writeFile(
        join(s.host.home, ".ssh", "authorized_keys"),
        `${deviceKey} ops@provisioning\n`,
      );
      expect(
        await s.post("/api/ssh/remove", { fingerprint: deviceFingerprint }),
      ).toEqual({
        status: 409,
        body: { kind: "blocked", reason: "not-launchpad-key" },
      });
      expect((await s.read()).body.keys).toEqual([
        {
          origin: "outside",
          type: "ssh-ed25519",
          fingerprint: deviceFingerprint,
          comment: "ops@provisioning",
        },
      ]);
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "the routes take JSON from this page only: method, content type, origin and token",
  async () => {
    const s = await local();
    try {
      const body = JSON.stringify({ device: "a", publicKey: deviceKey });
      // No Origin on a write: the local admission refuses it.
      expect(
        (
          await s.send("/api/ssh/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await s.send("/api/ssh/add", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://evil.example",
            },
            body,
          })
        ).status,
      ).toBe(403);
      // A form post cannot add a key.
      expect(
        (
          await s.send("/api/ssh/add", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Origin: s.url.origin,
            },
            body: "device=a",
          })
        ).status,
      ).toBe(415);
      expect(
        (await s.send("/api/ssh/add", { headers: { Origin: s.url.origin } }))
          .status,
      ).toBe(405);
      expect(
        (
          await s.send("/api/ssh", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: s.url.origin,
            },
            body: "{}",
          })
        ).status,
      ).toBe(405);
      expect((await s.send("/api/ssh?x=1", {})).status).toBe(400);
      // Without the token nothing is read.
      expect((await fetch(new URL("/api/ssh", s.url.origin))).status).toBe(403);
    } finally {
      await s.close();
    }
  },
);

test.skipIf(!posix)(
  "behind the gateway a write must be same-origin from the entry and admitted",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-ssh-hosted-")),
    );
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    const profile = presetProfile(preset, executionOs(process.platform));
    const machine = organizationWithEntry(freePort());
    const entry = machine.entry;
    if (entry === undefined) throw new Error("The fixture has an entry");
    await initializeHandoverFolder(folder, { preset, machine, profile });
    const fetcher: AuthFetcher = async (_url, init) =>
      new Headers(init.headers).get("cookie") ===
      "__Secure-lazurio-workspace=valid"
        ? new Response("ok")
        : new Response("no", { status: 401 });
    const host = await sshHost(parent);
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
      undefined,
      host,
    );
    try {
      const base = `http://127.0.0.1:${entry.listenPort}`;
      const valid = {
        host: "launchpad.workspace.example.lazurio.io",
        cookie: "__Secure-lazurio-workspace=valid",
      };
      const add = (headers: Record<string, string>) =>
        fetch(`${base}/api/ssh/add`, {
          method: "POST",
          headers: { "content-type": "application/json", ...valid, ...headers },
          body: JSON.stringify({ device: "alex-laptop", publicKey: deviceKey }),
        });
      expect((await add({})).status).toBe(401);
      expect(
        (
          await add({
            origin: entry.externalOrigin,
            "sec-fetch-site": "cross-site",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${base}/api/ssh`, {
            headers: { host: valid.host },
          })
        ).status,
      ).toBe(401);
      const admitted = await add({
        origin: entry.externalOrigin,
        "sec-fetch-site": "same-origin",
      });
      expect(admitted.status).toBe(200);
      expect(await admitted.json()).toMatchObject({
        kind: "ssh-key-added",
        outcome: "added",
      });
      const read = await fetch(`${base}/api/ssh`, { headers: valid });
      expect(read.status).toBe(200);
      expect(((await read.json()) as Json).keys).toHaveLength(1);
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
