import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import type { InstallFetch } from "../src/tools/install";
import { runTool } from "../src/tools/status";
import {
  fakeCodes,
  fakeLoginTools,
  realSshKeygen,
} from "./fixtures/fake-login-tools";

const posix = process.platform !== "win32";
const keygen = posix && realSshKeygen !== null;

type Json = Record<string, unknown>;

// A Folder, a private home with fake gh, composio and wacli, and a Launchpad
// on them. The process environment is never the source of a fact here.
async function session(
  tools: Parameters<typeof fakeLoginTools>[1] = ["gh", "composio", "wacli"],
  fetcher?: InstallFetch,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-curated-")),
  );
  const home = join(parent, "home");
  const path = await fakeLoginTools(home, tools);
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
    { path, home, xdg: {}, platform: process.platform, run: runTool },
    {
      ...(fetcher ? { fetch: fetcher } : {}),
      arch: "x64",
      login: { firstChallengeMs: 5_000, probeIntervalMs: 50, machine: "vm-01" },
    },
  );
  const url = new URL(app.url);
  const call = (route: string, body: unknown, override = {}) =>
    fetch(new URL(route, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
        ...override,
      },
      body: JSON.stringify(body),
    });
  const json = async (route: string, body: unknown) => {
    const response = await call(route, body);
    return {
      status: response.status,
      body: (await response.json()) as Json,
      response,
    };
  };
  return {
    parent,
    home,
    folder,
    app,
    call,
    json,
    approve: () => writeFile(join(home, "approve"), ""),
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function until(
  read: () => Promise<Json>,
  done: (value: Json) => boolean,
  ms = 10_000,
): Promise<Json> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Not reached: ${JSON.stringify(value)}`);
    await Bun.sleep(50);
  }
}

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if ([".composio", ".wacli", "bin"].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await walk(directory);
  return found;
}

const routes = [
  "/api/tools/install",
  "/api/tools/login/start",
  "/api/tools/login/poll",
  "/api/tools/login/cancel",
  "/api/tools/logout",
  "/api/tools/composio/organizations",
  "/api/tools/composio/organization",
];

test.skipIf(!posix)(
  "the curated routes share the admission of every route and refuse what they do not take",
  async () => {
    const opened = await session();
    try {
      for (const route of routes) {
        expect(
          (await opened.call(route, {}, { Authorization: "" })).status,
        ).toBe(403);
        expect(
          (
            await opened.call(
              route,
              {},
              { Origin: "https://untrusted.example" },
            )
          ).status,
        ).toBe(403);
        expect(
          (await opened.call(route, {}, { "Content-Type": "text/plain" }))
            .status,
        ).toBe(415);
        expect(
          (
            await fetch(new URL(route, new URL(opened.app.url)), {
              headers: {
                Authorization: `Bearer ${new URL(opened.app.url).hash.slice(1)}`,
              },
            })
          ).status,
        ).toBe(405);
      }
      // No field beyond the named ones: not a path, not a command.
      for (const [route, body] of [
        ["/api/tools/install", { tool: "gh", path: "/usr/bin" }],
        ["/api/tools/login/start", { tool: "gh", command: ["sh"] }],
        ["/api/tools/logout", {}],
        ["/api/tools/composio/organizations", { tool: "composio" }],
      ] as const)
        expect((await opened.call(route, body)).status).toBe(400);
      expect(
        (await opened.json("/api/tools/install", { tool: 3 })).status,
      ).toBe(400);
      expect(
        await opened.json("/api/tools/install", { tool: "neon" }),
      ).toMatchObject({
        status: 409,
        body: { kind: "blocked", reason: "setup-agent", tool: "neon" },
      });
      expect(
        await opened.json("/api/tools/login/start", { tool: "codex" }),
      ).toMatchObject({
        status: 409,
        body: { kind: "blocked", reason: "tool-unknown" },
      });
      expect(
        (
          await opened.json("/api/tools/login/start", {
            tool: "gh",
            phone: "+420123456789",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await opened.json("/api/tools/login/poll", {
            tool: "gh",
            session: "../x",
          })
        ).status,
      ).toBe(400);
      // "Link SSH key" is gh's only, and only as `true`.
      for (const body of [
        { tool: "gh", sshKey: false },
        { tool: "gh", sshKey: "yes" },
        { tool: "wacli", sshKey: true },
        { tool: "wacli", sshKey: true, phone: "+420123456789" },
      ])
        expect((await opened.json("/api/tools/login/start", body)).status).toBe(
          400,
        );
      expect(
        (await opened.json("/api/tools/composio/organization", { id: "a b" }))
          .status,
      ).toBe(400);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!keygen)(
  "gh: start returns the device code uncached to its holder only; poll reports signed in with the SSH key once",
  async () => {
    const opened = await session(["gh"]);
    try {
      const started = await opened.json("/api/tools/login/start", {
        tool: "gh",
      });
      expect(started.status).toBe(200);
      expect(started.response.headers.get("cache-control")).toBe("no-store");
      expect(started.body).toMatchObject({
        kind: "pending",
        tool: "gh",
        challenge: {
          kind: "device-code",
          url: "https://github.com/login/device",
          code: fakeCodes.gh,
        },
      });
      const handle = started.body.session as string;
      expect(handle).toMatch(/^[0-9a-f]{32}$/);
      expect(
        (
          await opened.json("/api/tools/login/poll", {
            tool: "gh",
            session: "0".repeat(32),
          })
        ).body,
      ).toEqual({ kind: "none", tool: "gh" });
      await opened.approve();
      const done = await until(
        async () =>
          (
            await opened.json("/api/tools/login/poll", {
              tool: "gh",
              session: handle,
            })
          ).body,
        (value) => value.kind !== "pending",
      );
      const key = join(opened.home, ".ssh", "id_ed25519");
      expect(done).toMatchObject({
        kind: "signed-in",
        tool: "gh",
        account: "octocat",
        ssh: {
          state: "linked",
          key: { path: key, created: true },
          registration: "added",
          knownHosts: "added",
        },
      });
      const fingerprint = ((done.ssh as Json).key as Json).fingerprint;
      // The card reads the new sign-in with the probe: SSH linked too.
      const status = (await opened.json("/api/tools/status", { signIn: true }))
        .body;
      expect((status.tools as Json[])[0]?.signIn).toEqual({
        state: "signed-in",
        account: "octocat",
        ssh: { state: "linked", fingerprint },
        identity: "person",
      });
      // "Link SSH key" of a signed-in gh: no code, the same key.
      const link = await opened.json("/api/tools/login/start", {
        tool: "gh",
        sshKey: true,
      });
      expect(link.status).toBe(200);
      const linked = await until(
        async () =>
          (
            await opened.json("/api/tools/login/poll", {
              tool: "gh",
              session: link.body.session ?? "0".repeat(32),
            })
          ).body,
        (value) => value.kind !== "pending",
      );
      expect(linked).toMatchObject({
        kind: "signed-in",
        ssh: {
          state: "linked",
          key: { created: false },
          registration: "already-registered",
        },
      });
      const logout = (await opened.json("/api/tools/logout", { tool: "gh" }))
        .body;
      expect(logout).toEqual({
        kind: "logged-out",
        tool: "gh",
        revocation: "local-only",
        sshKey: { state: "removed", fingerprint },
      });
      // No response carried the private key or the public key's blob.
      const privateKey = await readFile(key, "utf8");
      const blob = (await readFile(`${key}.pub`, "utf8")).split(
        " ",
      )[1] as string;
      for (const answer of [started.body, done, status, linked, logout]) {
        const text = JSON.stringify(answer);
        expect(text).not.toContain(blob);
        for (const line of privateKey.split("\n"))
          if (line.length > 20 && !line.startsWith("-----"))
            expect(text).not.toContain(line);
      }
      for (const file of [
        ...(await files(opened.home)),
        ...(await files(opened.folder)),
      ])
        expect(await readFile(file, "utf8")).not.toContain(fakeCodes.gh);
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "wacli: the QR is drawn server-side as SVG and replaced when it rotates; cancel and shutdown kill the tool",
  async () => {
    const opened = await session(["wacli"]);
    try {
      const started = await opened.json("/api/tools/login/start", {
        tool: "wacli",
      });
      expect(started.body).toMatchObject({
        kind: "pending",
        challenge: { kind: "qr", payload: fakeCodes.qrFirst, sequence: 1 },
      });
      const first = started.body.qrSvg as string;
      expect(first).toMatch(
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/,
      );
      expect(first).not.toContain(fakeCodes.qrFirst);
      const handle = started.body.session as string;
      await writeFile(join(opened.home, "rotate"), "");
      const rotated = await until(
        async () =>
          (
            await opened.json("/api/tools/login/poll", {
              tool: "wacli",
              session: handle,
            })
          ).body,
        (value) => (value.challenge as Json | undefined)?.sequence === 2,
      );
      expect(rotated.qrSvg).not.toBe(first);
      const helper = Number(
        await readFile(join(opened.home, "wacli.child"), "utf8"),
      );
      expect(
        (
          await opened.json("/api/tools/login/cancel", {
            tool: "wacli",
            session: handle,
          })
        ).body,
      ).toEqual({ kind: "cancelled", tool: "wacli" });
      const dead = async () => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          try {
            process.kill(helper, 0);
          } catch {
            return;
          }
          if (Date.now() > deadline) throw new Error("The tool survived");
          await Bun.sleep(25);
        }
      };
      await dead();
      // A phone pairing, then the Launchpad shuts down while it runs.
      const phone = await opened.json("/api/tools/login/start", {
        tool: "wacli",
        phone: "+420 123 456 789",
      });
      expect(phone.body).toMatchObject({
        kind: "pending",
        challenge: {
          kind: "pair-code",
          phone: "+420123456789",
          code: fakeCodes.pair,
        },
      });
      expect(phone.body.qrSvg).toBeUndefined();
      const second = Number(
        await readFile(join(opened.home, "wacli.child"), "utf8"),
      );
      await opened.app.close();
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          process.kill(second, 0);
        } catch {
          break;
        }
        if (Date.now() > deadline)
          throw new Error("The tool survived the shutdown");
        await Bun.sleep(25);
      }
    } finally {
      await rm(opened.parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posix)(
  "composio: link, signed in, organizations with the current one, and the switch",
  async () => {
    const opened = await session(["composio"]);
    try {
      const started = await opened.json("/api/tools/login/start", {
        tool: "composio",
      });
      expect(started.body).toMatchObject({
        kind: "pending",
        challenge: {
          kind: "url",
          url: `https://dashboard.composio.dev/?cliKey=${fakeCodes.composioKey}`,
        },
      });
      await opened.approve();
      expect(
        await until(
          async () =>
            (
              await opened.json("/api/tools/login/poll", {
                tool: "composio",
                session: started.body.session,
              })
            ).body,
          (value) => value.kind !== "pending",
        ),
      ).toEqual({
        kind: "signed-in",
        tool: "composio",
        account: "op@example.com",
        organization: "First",
      });
      expect(
        (await opened.json("/api/tools/composio/organizations", {})).body,
      ).toEqual({
        kind: "composio-organizations",
        organizations: [
          { id: "org_1", name: "First", current: true },
          { id: "org_2", name: "Second", current: false },
        ],
      });
      expect(
        (await opened.json("/api/tools/composio/organization", { id: "org_2" }))
          .body,
      ).toEqual({
        kind: "composio-organization-selected",
        id: "org_2",
        organization: "Second",
      });
    } finally {
      await opened.close();
    }
  },
);

test.skipIf(!posix)(
  "install: a working tool is already installed; a missing one comes from the verified release",
  async () => {
    const body = '#!/bin/sh\n[ "$1" = "--version" ] && echo "wacli 0.19.0"\n';
    const header = new Uint8Array(512);
    const put = (value: string, at: number) =>
      header.set(new TextEncoder().encode(value), at);
    put("wacli", 0);
    put("0000755\0", 100);
    put(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    put("0", 156);
    put("ustar\0", 257);
    const data = new Uint8Array(512);
    data.set(new TextEncoder().encode(body));
    const archive = new Uint8Array(
      gzipSync(Buffer.concat([header, data, new Uint8Array(1024)])),
    );
    const root = "https://github.com/openclaw/wacli/releases/download/v0.19.0";
    const asset = `wacli_0.19.0_${process.platform === "darwin" ? "darwin" : "linux"}_amd64.tar.gz`;
    const release: Record<string, BodyInit> = {
      "https://api.github.com/repos/openclaw/wacli/releases/latest":
        '{"tag_name":"v0.19.0"}',
      [`${root}/checksums.txt`]: `${createHash("sha256").update(archive).digest("hex")}  ${asset}\n`,
      [`${root}/${asset}`]: archive,
    };
    const fetcher: InstallFetch = async (url) =>
      release[url] === undefined
        ? new Response("", { status: 404 })
        : new Response(release[url]);
    const opened = await session(["gh"], fetcher);
    try {
      expect(
        (await opened.json("/api/tools/install", { tool: "gh" })).body,
      ).toMatchObject({
        kind: "already-installed",
        tool: "gh",
      });
      const installed = await opened.json("/api/tools/install", {
        tool: "wacli",
      });
      expect(installed.body).toMatchObject({
        kind: "installed",
        tool: "wacli",
        version: "0.19.0",
        path: join(opened.home, ".local", "bin", "wacli"),
        onPath: true,
      });
    } finally {
      await opened.close();
    }
  },
);
