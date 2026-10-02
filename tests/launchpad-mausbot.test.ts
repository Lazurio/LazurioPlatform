import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { parseMachineBinding } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { publicEntry } from "../src/launchpad/chat";
import {
  mausbotHref,
  mausbotPairLink,
  parseEntryAnswer,
} from "../src/launchpad/chat-view";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import {
  issueMausbotLink,
  mausbotPairing,
  mausbotPairUrl,
} from "../src/launchpad/mausbot";
import { startLaunchpad } from "../src/launchpad/server";
import { machineBinding } from "../src/machine/binding";
import {
  type MachineContext,
  parseMachineContext,
} from "../src/machine/context";
import {
  binding,
  bindings,
  entries,
  handoverEntry,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// Lazurio MausBot from the Platform Launchpad (DEV-6632): the handover's
// optional `entry.mausbot`, its binding projection, the pairing call against
// OpenMausBot's `POST /api/auth/pairing` on loopback, the route and the page.

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

test("the pairing call: OpenMausBot's own API on loopback, and the code only in the fragment of /pair", async () => {
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
    const link = await issueMausbotLink(fake.entry);
    expect(link).toEqual({
      kind: "mausbot-link",
      url: `${mausbotOrigin}/pair#code=${code}`,
    });
    expect(mausbotPairUrl(mausbotOrigin, code)).toBe(
      `${mausbotOrigin}/pair#code=${code}`,
    );
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
      const link = await issueMausbotLink(fake.entry);
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
    expect(await issueMausbotLink(slow.entry, 100)).toEqual({
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
  expect(await issueMausbotLink(gone.entry)).toEqual({
    kind: "blocked",
    reason: "mausbot-unreachable",
  });
  expect(mausbotPairing.timeoutMs).toBeLessThanOrEqual(15_000);
  // No MausBot recorded: nothing is called.
  const without = bindings.organizationEntry.entry;
  if (without === undefined) throw new Error("The fixture has an entry");
  expect(await issueMausbotLink(without)).toEqual({
    kind: "blocked",
    reason: "mausbot-pairing-failed",
  });
});

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("The probe listens on a port");
  return port;
};

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
  return {
    entry: () => fetch(`${base}/api/entry`, { headers: valid }),
    pair: (headers: Record<string, string> = sameOrigin) =>
      fetch(`${base}/api/mausbot/pair`, {
        method: "POST",
        headers,
        body: "{}",
      }),
    valid,
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")(
  "hosted: /api/entry names MausBot's origin and POST /api/mausbot/pair answers a pairing link, behind the gateway's admission",
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
      expect(mausbotHref(parseEntryAnswer(entry))).toBe(mausbotOrigin);
      // A state-changing request needs the same-origin proof.
      expect((await hosted.pair(hosted.valid)).status).toBe(401);
      expect(paired).toBe(0);
      const answer = await hosted.pair();
      const body = await answer.json();
      expect([answer.status, body]).toEqual([
        200,
        { kind: "mausbot-link", url: `${mausbotOrigin}/pair#code=${code}` },
      ]);
      expect(mausbotPairLink(body, mausbotOrigin)).toBe(body.url);
      expect(paired).toBe(1);
      server.stop(true);
      const refused = await hosted.pair();
      expect([refused.status, await refused.json()]).toEqual([
        409,
        { kind: "blocked", reason: "mausbot-unreachable" },
      ]);
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
      const answer = await hosted.pair();
      expect([answer.status, await answer.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
    } finally {
      await hosted.close();
    }
  },
);

test("the page shows MausBot only for a recorded origin, and accepts a pairing link only on it", () => {
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

  const link = `${mausbotOrigin}/pair#code=${code}`;
  expect(
    mausbotPairLink({ kind: "mausbot-link", url: link }, mausbotOrigin),
  ).toBe(link);
  for (const url of [
    `https://mausbot.other.lazurio.io/pair#code=${code}`,
    `${mausbotOrigin}/pair?code=${code}`,
    `${mausbotOrigin}/pair?x=1#code=${code}`,
    `${mausbotOrigin}/other#code=${code}`,
    `${mausbotOrigin}/pair#token=${code}`,
    `${mausbotOrigin}/pair#code=abcd`,
    `${mausbotOrigin}/pair`,
    `https://user@mausbot.${host}/pair#code=${code}`,
  ])
    expect([
      url,
      mausbotPairLink({ kind: "mausbot-link", url }, mausbotOrigin),
    ]).toEqual([url, null]);
  // A Chat answer is not a MausBot answer.
  expect(
    mausbotPairLink({ kind: "chat-link", url: link }, mausbotOrigin),
  ).toBeNull();
  expect(
    mausbotPairLink(
      { kind: "blocked", reason: "mausbot-unreachable" },
      mausbotOrigin,
    ),
  ).toBeNull();
  // The server's projection: the origin only, never the loopback port.
  const recorded = binding(handover()).entry ?? null;
  expect(publicEntry(recorded)).toEqual(withMausbot);
  expect(publicEntry(bindings.organizationEntry.entry ?? null)).toEqual(entry);
});

test("the page's MausBot entry stands next to Chat, hidden and without a link in the markup", async () => {
  const html = await readFile(
    join(import.meta.dir, "..", "src", "launchpad", "index.html"),
    "utf8",
  );
  const menu =
    /<ul class="menu chat-menu" id="chat-menu" hidden>(.*?)<\/ul>/.exec(html);
  const items = menu?.[1] ?? "";
  expect(items).toContain('id="mausbot" rel="noreferrer" hidden');
  expect(items.indexOf('id="chat"')).toBeLessThan(
    items.indexOf('id="mausbot"'),
  );
  expect(items).not.toContain('href="http');
});
