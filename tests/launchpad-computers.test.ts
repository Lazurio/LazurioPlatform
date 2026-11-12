import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputersHost } from "../src/computers/computers";
import {
  computerDetail,
  parseComputers,
} from "../src/launchpad/computers-panel";
import {
  computerCallback,
  createComputersRoutes,
} from "../src/launchpad/computers-routes";
import type { AdmittedPerson } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";

// People's computers for agents in the Launchpad (decision F73): the
// pairing page Lazurio Agent Desktop opens, its form and JSON answers, the
// callback only on 127.0.0.1, the list of Settings → Connections and the
// removal. A temporary home, host key and installed entry stand in for the
// account's; Executor is absent, so the pairing reports it.

const posix = process.platform !== "win32";
const wire = (bytes: Buffer) =>
  Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
const keyOf = (seed: number) =>
  `ssh-ed25519 ${Buffer.concat([wire(Buffer.from("ssh-ed25519")), wire(Buffer.alloc(32, seed))]).toString("base64")}`;
const hostKey = keyOf(7).split(" ")[1] as string;
const person: AdmittedPerson = { subject: null, username: "alex" };
const callback = "http://127.0.0.1:53111/cb";
const state = "s7d2Kq9xWm4Lr8Tp";

async function withRoutes(
  allowed: boolean,
  run: (
    routes: ReturnType<typeof createComputersRoutes>,
    home: string,
  ) => Promise<void>,
) {
  const parent = await mkdtemp(join(tmpdir(), "lazurio-computers-"));
  const home = join(parent, "home");
  await mkdir(join(home, ".local", "bin"), { recursive: true, mode: 0o700 });
  const entry = join(home, ".local", "bin", "lazurio");
  await writeFile(entry, "#!/bin/sh\n");
  await chmod(entry, 0o700);
  const hostKeyPath = join(parent, "ssh_host_ed25519_key.pub");
  await writeFile(hostKeyPath, `ssh-ed25519 ${hostKey} root@host\n`);
  const host: ComputersHost = {
    platform: "linux",
    home,
    uid: process.getuid?.(),
    user: "alex",
    today: () => "2026-11-12",
    hostKeyPath,
    tailnet: async () => ({
      state: "known",
      dnsName: "alex-work.example.ts.example",
    }),
    entry: async () => entry,
    executor: null,
    allowed: async () => allowed,
    locale: async () => "cs",
    version: "test",
  };
  const routes = createComputersRoutes({
    host: () => host,
    page: async () => ({ locale: "cs", kind: null }),
    headers: { "Cache-Control": "no-store" },
  });
  try {
    await run(routes, home);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const pageUrl = (overrides: Record<string, string> = {}) => {
  const url = new URL("https://launchpad.example/connect/computer");
  for (const [name, value] of Object.entries({
    name: "Alex <MacBook>",
    os: "macos",
    pubkey: keyOf(1),
    callback,
    state,
    ...overrides,
  }))
    url.searchParams.set(name, value);
  return url;
};

test("the callback is exactly http://127.0.0.1:<port>/<path>", () => {
  expect(computerCallback(callback)?.href).toBe(callback);
  for (const refused of [
    "https://127.0.0.1:53111/cb",
    "http://localhost:53111/cb",
    "http://127.0.0.1/cb",
    "http://127.0.0.1:80/cb",
    "http://127.0.0.1:53111/cb?x=1",
    "http://127.0.0.1:53111/cb#x",
    "http://user@127.0.0.1:53111/cb",
    "http://127.0.0.1.example:53111/cb",
    "http://[::1]:53111/cb",
    "javascript:alert(1)",
  ])
    expect(computerCallback(refused)).toBeNull();
});

test.skipIf(!posix)(
  "the page names the computer, its key and the promise",
  () =>
    withRoutes(true, async (routes) => {
      const url = pageUrl();
      const page = await routes.page(new Request(url), url);
      expect(page.status).toBe(200);
      expect(page.headers.get("Content-Security-Policy")).toContain(
        "form-action 'self' http://127.0.0.1:53111",
      );
      expect(page.headers.get("Content-Security-Policy")).toContain(
        "default-src 'none'",
      );
      const html = await page.text();
      expect(html).toContain("Alex &lt;MacBook&gt;");
      expect(html).not.toContain("<MacBook>");
      expect(html).toContain("macOS");
      expect(html).toContain("SHA256:");
      expect(html).toContain("Povolit agentům tento počítač");
      expect(html).toContain('action="/api/computers"');
      expect(html).not.toContain("<script");
    }),
);

test.skipIf(!posix)(
  "an invalid request or a Team Environment shows no form",
  async () => {
    await withRoutes(true, async (routes) => {
      for (const overrides of [
        { callback: "http://evil.example:53111/cb" },
        { state: "short" },
        { os: "linux" },
        { pubkey: "ssh-rsa AAAA" },
        { name: "" },
      ]) {
        const url = pageUrl(overrides);
        const page = await routes.page(new Request(url), url);
        expect(page.status).toBe(400);
        expect(await page.text()).not.toContain("<form");
      }
    });
    await withRoutes(false, async (routes) => {
      const url = pageUrl();
      const page = await routes.page(new Request(url), url);
      expect(page.status).toBe(409);
      expect(await page.text()).toContain("ne z Týmového Prostředí");
    });
  },
);

test.skipIf(!posix)(
  "the form pairs the computer and returns to the application",
  () =>
    withRoutes(true, async (routes, home) => {
      const body = new URLSearchParams({
        name: "Alex MacBook",
        os: "macos",
        publicKey: keyOf(1),
        callback,
        state,
      }).toString();
      const answer = await routes.handle(
        new Request("https://launchpad.example/api/computers", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
        new URL("https://launchpad.example/api/computers"),
        person,
      );
      expect(answer.status).toBe(303);
      const location = new URL(answer.headers.get("Location") as string);
      expect(location.origin).toBe("http://127.0.0.1:53111");
      expect(location.pathname).toBe("/cb");
      expect(location.searchParams.get("state")).toBe(state);
      const result = JSON.parse(
        Buffer.from(
          location.searchParams.get("result") as string,
          "base64url",
        ).toString(),
      );
      expect(result).toEqual({
        deviceId: "alex-macbook",
        ssh: {
          host: "alex-work.example.ts.example",
          user: "alex",
          knownHosts: `alex-work.example.ts.example ssh-ed25519 ${hostKey}`,
        },
      });
      const keys = await readFile(
        join(home, ".ssh", "authorized_keys"),
        "utf8",
      );
      expect(keys).toBe(
        `restrict,command="${home}/.local/bin/lazurio computer attach --device alex-macbook" ${keyOf(1)} lazurio-computer:alex-macbook:alex:2026-11-12\n`,
      );

      // The same key again (the application retries): the same computer.
      const again = await routes.handle(
        new Request("https://launchpad.example/api/computers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Alex MacBook",
            os: "macos",
            publicKey: keyOf(1),
          }),
        }),
        new URL("https://launchpad.example/api/computers"),
        person,
      );
      expect(await again.json()).toMatchObject({
        kind: "computer-paired",
        outcome: "already-present",
        deviceId: "alex-macbook",
        agents: "executor-unavailable",
      });

      // Another computer of the same name gets its own id.
      const second = await routes.handle(
        new Request("https://launchpad.example/api/computers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Alex MacBook",
            os: "windows",
            publicKey: keyOf(2),
          }),
        }),
        new URL("https://launchpad.example/api/computers"),
        person,
      );
      expect(await second.json()).toMatchObject({ deviceId: "alex-macbook-2" });

      const list = await routes.handle(
        new Request("https://launchpad.example/api/computers"),
        new URL("https://launchpad.example/api/computers"),
        person,
      );
      const overview = parseComputers(await list.json());
      expect(
        overview?.computers?.map((item) => [
          item.deviceId,
          item.os,
          item.connected,
        ]),
      ).toEqual([
        ["alex-macbook", "macos", false],
        ["alex-macbook-2", "windows", false],
      ]);

      const removed = await routes.handle(
        new Request("https://launchpad.example/api/computers/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId: "alex-macbook" }),
        }),
        new URL("https://launchpad.example/api/computers/remove"),
        person,
      );
      expect(await removed.json()).toEqual({
        kind: "computer-removed",
        deviceId: "alex-macbook",
        agents: "none",
      });
      expect(
        await readFile(join(home, ".ssh", "authorized_keys"), "utf8"),
      ).not.toContain("--device alex-macbook ");
    }),
);

test.skipIf(!posix)("a form with a foreign callback pairs nothing", () =>
  withRoutes(true, async (routes, home) => {
    const answer = await routes.handle(
      new Request("https://launchpad.example/api/computers", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          name: "Alex MacBook",
          os: "macos",
          publicKey: keyOf(1),
          callback: "https://evil.example/cb",
          state,
        }).toString(),
      }),
      new URL("https://launchpad.example/api/computers"),
      person,
    );
    expect(answer.status).toBe(400);
    expect(answer.headers.get("Location")).toBeNull();
    expect(
      await readFile(join(home, ".ssh", "authorized_keys"), "utf8").catch(
        () => "",
      ),
    ).toBe("");
  }),
);

test("the list's line says what the person needs", () => {
  const copy = messages("cs");
  expect(
    computerDetail(
      copy,
      {
        deviceId: "alex-macbook",
        name: "Alex MacBook",
        os: "macos",
        connected: true,
        lastActivity: "2026-11-12T10:05:00.000Z",
        agents: "executor",
      },
      () => "12. 11. 2026 11:05",
    ),
  ).toBe("macOS · Připojený · Poslední činnost 12. 11. 2026 11:05");
  expect(
    parseComputers({ kind: "computers", supported: false, reason: "not-here" }),
  ).toEqual({
    computers: null,
  });
  expect(parseComputers({ kind: "other" })).toBeNull();
});
