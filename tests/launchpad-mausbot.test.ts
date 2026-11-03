import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { parseMachineBinding } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { publicEntry } from "../src/launchpad/chat";
import { mausbotHref, parseEntryAnswer } from "../src/launchpad/chat-view";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import {
  mausbotPairing,
  mausbotPairingPath,
  mintMausbotPairing,
} from "../src/launchpad/mausbot";
import { startLaunchpad } from "../src/launchpad/server";
import { shellDocument } from "../src/launchpad/shell-document";
import { machineBinding } from "../src/machine/binding";
import {
  type MachineContext,
  parseMachineContext,
} from "../src/machine/context";
import { shellMessages } from "../src/shell/messages";
import { switchTabs } from "../src/shell/view";
import {
  binding,
  bindings,
  entries,
  handoverEntry,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";
import { freePort } from "./fixtures/ports";

// Lazurio MausBot from the Platform Launchpad (DEV-6632): the handover's
// optional `entry.mausbot`, its binding projection, the pairing call against
// OpenMausBot's `POST /api/auth/pairing` on loopback, MausBot's self-pairing
// route and the page. Since the addendum of 2026-10-31 to the decision of
// 2026-10-17 the Launchpad's click mints nothing and follows the plain
// origin.

const host = "workspace.example.lazurio.io";
const mausbotOrigin = `https://mausbot.${host}`;
const code = "ABCD-EFGH-JK23";
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const { team: _, ...withoutTeam } = organization.owner;
const handover = (listenPort = 20000, mausbotPort = 4102) => ({
  ...organization,
  owner: withoutTeam,
  entry: {
    ...handoverEntry(host, listenPort),
    mausbot: { external_origin: mausbotOrigin, listen_port: mausbotPort },
  },
});

test("the handover's optional entry.mausbot is read as written on both branches, and refused when invalid", () => {
  for (const base of [organization, personal]) {
    const input = {
      ...base,
      entry: {
        ...entries.organization,
        mausbot: { external_origin: mausbotOrigin, listen_port: 4102 },
      },
    };
    expect(JSON.stringify(parseMachineContext(bytes(input)))).toBe(
      JSON.stringify(input),
    );
    for (const mausbot of [
      { external_origin: `http://mausbot.${host}`, listen_port: 4102 },
      { external_origin: `${mausbotOrigin}/`, listen_port: 4102 },
      { external_origin: `${mausbotOrigin}:8443`, listen_port: 4102 },
      { external_origin: mausbotOrigin, listen_port: 0 },
      { external_origin: mausbotOrigin, listen_port: 443 },
      { external_origin: mausbotOrigin, listen_port: 65536 },
      { external_origin: mausbotOrigin, listen_port: "4102" },
      { external_origin: mausbotOrigin },
      { listen_port: 4102 },
      { external_origin: mausbotOrigin, listen_port: 4102, token: "x" },
      null,
    ])
      expect(() =>
        parseMachineContext(
          bytes({ ...base, entry: { ...entries.organization, mausbot } }),
        ),
      ).toThrow("machine-context-invalid");
  }
});

test("the binding records MausBot's origin and port only when the handover carries them; an older entry stays byte-identical", () => {
  const recorded = binding(handover());
  expect(recorded.entry).toEqual({
    ...(bindings.organizationEntry.entry ?? {}),
    mausbotOrigin,
    mausbotListenPort: 4102,
  } as typeof recorded.entry);
  expect(parseMachineBinding(JSON.parse(JSON.stringify(recorded)))).toEqual(
    recorded,
  );
  // Without `entry.mausbot`: the same bytes as before the member existed.
  expect(JSON.stringify(bindings.organizationEntry.entry)).toBe(
    JSON.stringify({
      externalOrigin: `https://launchpad.${host}`,
      authCheckUrl: `https://${host}/oauth2/auth`,
      authCookieName: "__Secure-lazurio-workspace",
      listenPort: 20000,
      t3codeOrigin: `https://t3code.${host}`,
      moduleOriginTemplate: `https://{module}.${host}`,
    }),
  );
  const entry = recorded.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  const { mausbotOrigin: _o, mausbotListenPort: _p, ...older } = entry;
  for (const bad of [
    { ...older, mausbotOrigin },
    { ...older, mausbotListenPort: 4102 },
    { ...entry, mausbotOrigin: `http://mausbot.${host}` },
    { ...entry, mausbotOrigin: `${mausbotOrigin}/` },
    { ...entry, mausbotListenPort: 0 },
    { ...entry, mausbotListenPort: 1023 },
    { ...entry, mausbotListenPort: 65536 },
    { ...entry, mausbotListenPort: "4102" },
  ])
    expect(() =>
      parseMachineBinding({ ...bindings.organization, entry: bad }),
    ).toThrow();
  // A projection that would not read back refuses the handover.
  const context = {
    ...handover(),
    entry: {
      ...handover().entry,
      mausbot: { external_origin: mausbotOrigin, listen_port: 80 },
    },
  } as unknown as MachineContext;
  expect(() => machineBinding(context, "a".repeat(64))).toThrow(
    "machine-context-invalid",
  );
});

// A fake OpenMausBot on loopback: it records each request and answers as told.
function fakeMausbot(
  answer: (request: Request) => Response | Promise<Response>,
) {
  const seen: {
    method: string;
    path: string;
    headers: Headers;
    body: string;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.clone().text(),
      });
      return answer(request);
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("The fake listens on a port");
  return {
    seen,
    entry: binding(handover(20000, port)).entry ?? (undefined as never),
    stop: () => server.stop(true),
  };
}

test("the pairing call: OpenMausBot's own API on loopback, and the code alone", async () => {
  const fake = fakeMausbot(() =>
    Response.json({
      id: "p1",
      code,
      credential: "omb_secret_credential",
      expiresAt: Date.now() + 300_000,
      url: null,
    }),
  );
  try {
    const link = await mintMausbotPairing(fake.entry);
    expect(link).toEqual({ kind: "mausbot-pairing", code });
    expect(fake.seen).toHaveLength(1);
    const [request] = fake.seen;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/api/auth/pairing");
    expect(JSON.parse(request?.body ?? "")).toEqual({ label: "launchpad" });
    expect(request?.headers.get("content-type")).toBe("application/json");
    // A loopback owner: loopback Host, no Origin, nothing forwarded.
    expect(request?.headers.get("host")).toBe(
      `127.0.0.1:${fake.entry.mausbotListenPort}`,
    );
    for (const name of [
      "origin",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
    ])
      expect(request?.headers.get(name)).toBeNull();
    // The other credential of the answer is never passed on.
    expect(JSON.stringify(link)).not.toContain("omb_secret_credential");
  } finally {
    fake.stop();
  }
});

test("a refused, malformed or slow pairing answers one reason, never the code", async () => {
  const failures: Record<string, () => Response | Promise<Response>> = {
    "a 403 holding a code": () => Response.json({ code }, { status: 403 }),
    "a 500": () => new Response(`no ${code}`, { status: 500 }),
    "a redirect": () =>
      new Response(null, {
        status: 302,
        headers: { location: `${mausbotOrigin}/pair#code=${code}` },
      }),
    "not JSON": () => new Response(`code ${code}`),
    "JSON null": () => Response.json(null),
    "no code": () => Response.json({ url: `${mausbotOrigin}/pair` }),
    "a code of another shape": () => Response.json({ code: "abcd-efgh" }),
    "a code that would leave the fragment": () =>
      Response.json({ code: "ABCD-EFGH-JK23?x=1" }),
  };
  for (const [name, answer] of Object.entries(failures)) {
    const fake = fakeMausbot(answer);
    try {
      const link = await mintMausbotPairing(fake.entry);
      expect([name, link]).toEqual([
        name,
        { kind: "blocked", reason: "mausbot-pairing-failed" },
      ]);
      expect(JSON.stringify(link)).not.toContain(code);
    } finally {
      fake.stop();
    }
  }
  // An answer that does not come in time: unreachable, bounded.
  const slow = fakeMausbot(
    () =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(Response.json({ code })), 2_000),
      ),
  );
  try {
    const started = Date.now();
    expect(await mintMausbotPairing(slow.entry, 100)).toEqual({
      kind: "blocked",
      reason: "mausbot-unreachable",
    });
    expect(Date.now() - started).toBeLessThan(1_500);
  } finally {
    slow.stop();
  }
  // Nothing listens on the port.
  const gone = fakeMausbot(() => new Response(""));
  gone.stop();
  expect(await mintMausbotPairing(gone.entry)).toEqual({
    kind: "blocked",
    reason: "mausbot-unreachable",
  });
  expect(mausbotPairing.timeoutMs).toBeLessThanOrEqual(15_000);
  // No MausBot recorded: nothing is called.
  const without = bindings.organizationEntry.entry;
  if (without === undefined) throw new Error("The fixture has an entry");
  expect(await mintMausbotPairing(without)).toEqual({
    kind: "blocked",
    reason: "mausbot-pairing-failed",
  });
});

async function hostedLaunchpad(mausbotPort: number | null) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-mausbot-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = "hosted-organization-personal";
  const listenPort = freePort();
  const document = handover(listenPort, mausbotPort ?? 4102);
  const machine = binding(
    mausbotPort === null
      ? { ...document, entry: handoverEntry(host, listenPort) }
      : document,
  );
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
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    {
      path: parent,
      home: parent,
      platform: process.platform,
      run: async () => "timeout",
    },
  );
  const base = `http://127.0.0.1:${listenPort}`;
  const valid = {
    host: new URL(`https://launchpad.${host}`).host,
    cookie: "__Secure-lazurio-workspace=valid",
  };
  const sameOrigin = {
    ...valid,
    origin: `https://launchpad.${host}`,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  // MausBot's web client asking on its own origin, as the gateway forwards
  // it here (Machines `ingress.ts` `shellRoute`): the Launchpad's Host, the
  // session cookie alone and the browser's own Fetch Metadata of a script's
  // fetch.
  const ownFetch = {
    ...valid,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
  return {
    entry: () => fetch(`${base}/api/entry`, { headers: valid }),
    // A POST the page's own way, to `path`: the click's former pairing
    // route, or any other.
    post: (path: string, headers: Record<string, string> = sameOrigin) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: "{}",
      }),
    selfPair: (
      headers: Record<string, string> = ownFetch,
      init: RequestInit = {},
      path = mausbotPairingPath,
    ) => fetch(`${base}${path}`, { headers, ...init }),
    base,
    valid,
    ownFetch,
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")(
  "hosted: /api/entry names MausBot's origin, and the Launchpad's click mints nothing: POST /api/mausbot/pair answers as any unknown route does",
  async () => {
    let paired = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        paired += 1;
        return Response.json({ code, expiresAt: Date.now() + 300_000 });
      },
    });
    const port = server.port;
    if (port === undefined) throw new Error("The fake listens on a port");
    const hosted = await hostedLaunchpad(port);
    try {
      const entry = await (await hosted.entry()).json();
      expect(entry.entry.mausbotOrigin).toBe(mausbotOrigin);
      // The loopback port stays on the server.
      expect(JSON.stringify(entry)).not.toContain(String(port));
      // The Automate entry: the recorded origin as it is.
      expect(mausbotHref(parseEntryAnswer(entry))).toBe(mausbotOrigin);
      // The click's former route is gone, with or without the same-origin
      // proof: what any unknown route answers, and MausBot is never asked.
      for (const headers of [undefined, hosted.valid]) {
        const removed = await hosted.post("/api/mausbot/pair", headers);
        const unknown = await hosted.post("/api/mausbot/unknown", headers);
        const removedText = await removed.text();
        expect([removed.status, removedText]).toEqual([
          unknown.status,
          await unknown.text(),
        ]);
        expect(removedText).not.toContain(code);
      }
      const removed = await hosted.post("/api/mausbot/pair");
      expect([removed.status, await removed.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
      expect(paired).toBe(0);
    } finally {
      server.stop(true);
      await hosted.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted without MausBot: no origin in /api/entry and no pairing route",
  async () => {
    const hosted = await hostedLaunchpad(null);
    try {
      const entry = await (await hosted.entry()).json();
      expect(Object.keys(entry.entry)).not.toContain("mausbotOrigin");
      expect(mausbotHref(parseEntryAnswer(entry))).toBeNull();
      const answer = await hosted.post("/api/mausbot/pair");
      expect([answer.status, await answer.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
      // Nor MausBot's self-pairing.
      const self = await hosted.selfPair();
      expect([self.status, await self.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
    } finally {
      await hosted.close();
    }
  },
);

test("the page shows MausBot only for a recorded origin, and its Automate entry is that origin as it is", () => {
  const entry = {
    launchpadOrigin: `https://launchpad.${host}`,
    t3codeOrigin: `https://t3code.${host}`,
    moduleOriginTemplate: `https://{module}.${host}`,
  };
  expect(mausbotHref(parseEntryAnswer({ kind: "entry", entry }))).toBeNull();
  const withMausbot = { ...entry, mausbotOrigin };
  expect(parseEntryAnswer({ kind: "entry", entry: withMausbot })).toEqual(
    withMausbot,
  );
  expect(
    mausbotHref(parseEntryAnswer({ kind: "entry", entry: withMausbot })),
  ).toBe(mausbotOrigin);
  for (const bad of [`http://mausbot.${host}`, `${mausbotOrigin}/`, 4102, null])
    expect(
      parseEntryAnswer({
        kind: "entry",
        entry: { ...entry, mausbotOrigin: bad },
      }),
    ).toBeNull();
  expect(mausbotHref(null)).toBeNull();

  // The server's projection: the origin only, never the loopback port.
  const recorded = binding(handover()).entry ?? null;
  expect(publicEntry(recorded)).toEqual(withMausbot);
  expect(publicEntry(bindings.organizationEntry.entry ?? null)).toEqual(entry);
});

test("the page's MausBot entry is Automate in the switch next to Chat (decision F36), with no link in the markup", async () => {
  const html = await readFile(
    join(import.meta.dir, "..", "src", "launchpad", "index.html"),
    "utf8",
  );
  expect(html).toContain(
    '<lazurio-column-head id="column-head" active="apps" settings="/settings/general">',
  );
  expect(html).not.toContain('id="mausbot"');
  expect(html).not.toContain('href="http');
  const shell = shellDocument({
    preset: "hosted-organization-personal",
    machine: binding(handover()),
    locale: "en",
    catalog: { kind: "catalog", organizations: [] },
  });
  expect(
    switchTabs(shell, shellMessages("en"), "apps").map((tab) => [
      tab.app,
      tab.href,
    ]),
  ).toEqual([
    ["chat", `https://t3code.${host}/`],
    ["apps", `https://launchpad.${host}/`],
    ["automate", `${mausbotOrigin}/`],
  ]);
});

// A fake OpenMausBot for the hosted routes: it counts the pairings it mints
// and answers as `mode` says.
function countingMausbot() {
  const state = { minted: 0, mode: "ok" as "ok" | "refuse" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== mausbotPairing.path ||
        JSON.parse(await request.text()).label !== mausbotPairing.label
      )
        return new Response("unexpected", { status: 400 });
      state.minted += 1;
      return state.mode === "ok"
        ? Response.json({ code, credential: "omb_secret_credential" })
        : Response.json({ code }, { status: 500 });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("The fake listens on a port");
  return { state, port, stop: () => server.stop(true) };
}

test("the self-pairing mints through one call: the code alone, or the reason", async () => {
  const fake = countingMausbot();
  try {
    const entry =
      binding(handover(20000, fake.port)).entry ?? (undefined as never);
    expect(await mintMausbotPairing(entry)).toEqual({
      kind: "mausbot-pairing",
      code,
    });
    expect(fake.state.minted).toBe(1);
    fake.state.mode = "refuse";
    const refused = await mintMausbotPairing(entry);
    expect(refused).toEqual({
      kind: "blocked",
      reason: "mausbot-pairing-failed",
    });
    expect(JSON.stringify(refused)).not.toContain(code);
  } finally {
    fake.stop();
  }
  const without = bindings.organizationEntry.entry;
  if (without === undefined) throw new Error("The fixture has an entry");
  expect(await mintMausbotPairing(without)).toEqual({
    kind: "blocked",
    reason: "mausbot-pairing-failed",
  });
});

test.skipIf(process.platform === "win32")(
  "hosted: MausBot's own fetch gets its pairing, exactly the JSON and no-store, and the Launchpad's click no longer mints one",
  async () => {
    const fake = countingMausbot();
    const hosted = await hostedLaunchpad(fake.port);
    try {
      const answer = await hosted.selfPair();
      expect([answer.status, answer.redirected]).toEqual([200, false]);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(answer.headers.get("content-type")).toStartWith(
        "application/json",
      );
      // Byte for byte: nothing else of MausBot's answer is passed on.
      expect(await answer.text()).toBe(
        `{"kind":"mausbot-pairing","code":"${code}"}`,
      );
      expect(fake.state.minted).toBe(1);
      // The Launchpad's click no longer mints: its former route is gone,
      // and MausBot is not asked again.
      const clicked = await hosted.post("/api/mausbot/pair");
      expect([clicked.status, await clicked.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
      expect(fake.state.minted).toBe(1);
      // A refused pairing: the reason, never the code.
      fake.state.mode = "refuse";
      const failed = await hosted.selfPair();
      const failedText = await failed.text();
      expect([failed.status, JSON.parse(failedText)]).toEqual([
        409,
        { kind: "blocked", reason: "mausbot-pairing-failed" },
      ]);
      expect(failedText).not.toContain(code);
      // Nothing listening on the loopback port.
      fake.stop();
      const gone = await hosted.selfPair();
      expect([gone.status, await gone.json()]).toEqual([
        409,
        { kind: "blocked", reason: "mausbot-unreachable" },
      ]);
    } finally {
      fake.stop();
      await hosted.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted: the MausBot self-pairing answers only an admitted page's own fetch: every other request mints nothing",
  async () => {
    const fake = countingMausbot();
    const hosted = await hostedLaunchpad(fake.port);
    try {
      const { valid, ownFetch, selfPair } = hosted;
      // Unadmitted: no session, a session the gateway refuses, or MausBot's
      // own Host (the gateway must send the Launchpad's).
      const { cookie: _, ...withoutCookie } = ownFetch;
      for (const [headers, reason] of [
        [withoutCookie, "cookie-missing"],
        [
          { ...ownFetch, cookie: "__Secure-lazurio-workspace=expired" },
          "auth-denied",
        ],
        [{ ...ownFetch, host: new URL(mausbotOrigin).host }, "host-mismatch"],
      ] as const) {
        const denied = await selfPair(headers);
        const text = await denied.text();
        expect([reason, denied.status, JSON.parse(text)]).toEqual([
          reason,
          401,
          { error: "denied", reason },
        ]);
        expect(text).not.toContain(code);
      }
      // Admitted, but not a page's own fetch: no Fetch Metadata at all,
      // another site, a sibling of the Environment, a typed address, a
      // navigation on MausBot's own origin (a link, a bookmark), a
      // subresource and speculative loads.
      for (const headers of [
        valid,
        { ...ownFetch, "sec-fetch-site": "cross-site" },
        { ...ownFetch, "sec-fetch-site": "same-site" },
        {
          ...valid,
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
        {
          ...valid,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
        { ...ownFetch, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
        { ...ownFetch, "sec-purpose": "prefetch" },
        { ...ownFetch, purpose: "prefetch" },
        {
          ...valid,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-purpose": "prefetch;prerender",
        },
      ]) {
        const refused = await selfPair(headers);
        const text = await refused.text();
        expect([headers, refused.status, JSON.parse(text)]).toEqual([
          headers,
          403,
          { error: "not-allowed" },
        ]);
        expect(text).not.toContain(code);
      }
      // A query, a HEAD and any other method: not the request either.
      const query = await selfPair(ownFetch, {}, `${mausbotPairingPath}?x=1`);
      expect([query.status, await query.json()]).toEqual([
        400,
        { error: "invalid-request" },
      ]);
      const head = await selfPair(ownFetch, { method: "HEAD" });
      expect(head.status).toBe(405);
      const posted = await selfPair(
        {
          ...ownFetch,
          origin: `https://launchpad.${host}`,
          "content-type": "application/json",
        },
        { method: "POST", body: "{}" },
      );
      expect([posted.status, await posted.json()]).toEqual([
        405,
        { error: "method-not-allowed" },
      ]);
      expect(fake.state.minted).toBe(0);
      // Any other path beside it is no pairing: the page's static listener
      // answers it.
      const neighbour = await fetch(`${hosted.base}/.lazurio/mausbot/other`, {
        headers: valid,
      });
      expect(neighbour.status).toBe(404);
      expect(fake.state.minted).toBe(0);
    } finally {
      fake.stop();
      await hosted.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "workstation: no entry, so no MausBot self-pairing: refused without the token, absent with it",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-mausbot-local-")),
    );
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
        path: parent,
        home: parent,
        platform: process.platform,
        run: async () => "timeout",
      },
    );
    try {
      const url = new URL(app.url);
      const token = url.hash.slice(1);
      const ownFetch = {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
      };
      const unadmitted = await fetch(new URL(mausbotPairingPath, url), {
        headers: ownFetch,
      });
      expect(unadmitted.status).toBe(403);
      const self = await fetch(new URL(mausbotPairingPath, url), {
        headers: { ...ownFetch, Authorization: `Bearer ${token}` },
      });
      expect([self.status, await self.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
    } finally {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
