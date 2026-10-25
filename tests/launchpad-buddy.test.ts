import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { buddyRoutePaths } from "../src/launchpad/buddy-routes";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import { codexDevicePage } from "../src/tools/ai";
import type { ToolRunner } from "../src/tools/status";
import {
  type FakeHermesGateway,
  fakeHermesGateway,
  recorded,
} from "./fixtures/fake-hermes-gateway";
import {
  organizationWithEntry,
  personalWithEntry,
} from "./fixtures/machine-bindings";
import { freePort } from "./fixtures/ports";

// Decision F63 in the Launchpad: `GET /api/buddy` and the sign-in routes on a
// hosted Osobní Prostředí whose entry names Buddy, through the stand-in for
// his Hermes gateway in the account's `~/.hermes`. Every POST, the poll
// included, passes only the hosted same-origin rule; elsewhere every route is
// absent. The journal and the answers carry no ticket and no Hermes session,
// and the code only to the holder.

const posix = test.skipIf(process.platform === "win32");
type Json = Record<string, unknown>;

async function hosted(
  kind: "buddy" | "personal" | "organization" = "buddy",
  options: Parameters<typeof fakeHermesGateway>[0] = {},
) {
  const fake = await fakeHermesGateway(options);
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-buddy-")),
  );
  const bin = join(fake.userHome, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const port = freePort();
  const preset =
    kind === "organization"
      ? "hosted-organization-personal"
      : "hosted-personal";
  const machine =
    kind === "organization"
      ? organizationWithEntry(port)
      : personalWithEntry(port, false, false, kind === "buddy");
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const run: ToolRunner = async () => ({ exitCode: 1, stdout: "", stderr: "" });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    { path: bin, home: fake.userHome, platform: process.platform, run },
  );
  const base = `http://127.0.0.1:${entry.listenPort}`;
  const host = new URL(entry.externalOrigin).host;
  const valid = { host, cookie: "__Secure-lazurio-workspace=valid" };
  const sameOrigin = {
    ...valid,
    origin: entry.externalOrigin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const send = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ) =>
    fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: init.headers ?? valid,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  const answer = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as Json,
  });
  return {
    fake,
    entry,
    valid,
    sameOrigin,
    send,
    get: async (path: string) => answer(await send(path, {})),
    post: async (path: string, body: unknown = {}) =>
      answer(
        await send(path, {
          method: "POST",
          headers: sameOrigin,
          body: JSON.stringify(body),
        }),
      ),
    async close() {
      await app.close();
      await fake.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** The journal lines of Buddy's sign-in this process wrote. */
function journal() {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation(
    (...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    },
  );
  return {
    lines,
    buddy: () =>
      lines
        .filter((line) => line.includes('"buddy-sign-in"'))
        .map((line) => JSON.parse(line) as Json),
    restore: () => spy.mockRestore(),
  };
}

const hermesIds = (fake: FakeHermesGateway) =>
  [...Array(20).keys()]
    .map((index) => `Fixture_Session_${String(index + 1).padStart(6, "0")}`)
    .concat([...fake.sessions.keys()]);

posix(
  "GET /api/buddy: works, waits or not running, from Hermes's own card, in the Folder's locale",
  async () => {
    const app = await hosted();
    try {
      expect(await app.get(buddyRoutePaths.read)).toEqual({
        status: 200,
        body: {
          kind: "buddy",
          state: "waits",
          signIn: { state: "none" },
          locale: "cs",
        },
      });
      app.fake.state.signedIn = true;
      expect((await app.get(buddyRoutePaths.read)).body).toEqual({
        kind: "buddy",
        state: "works",
        signIn: { state: "connected" },
        locale: "cs",
      });
      // Nothing of Hermes's card beyond whether he is signed in.
      const read = JSON.stringify((await app.get(buddyRoutePaths.read)).body);
      for (const member of ["token_preview", "last_refresh", "source", "pool"])
        expect(read).not.toContain(member);
      await app.fake.stop();
      expect((await app.get(buddyRoutePaths.read)).body).toEqual({
        kind: "buddy",
        state: "unknown",
        reason: "not-running",
        signIn: { state: "unknown" },
        locale: "cs",
      });
    } finally {
      await app.close();
    }
  },
);

posix(
  "the sign-in over HTTP: start, poll, signed in once Hermes saved it; cancel; sign-out; journal and answers without a secret",
  async () => {
    const lines = journal();
    const app = await hosted();
    try {
      const started = await app.post(buddyRoutePaths.start);
      expect(started).toEqual({
        status: 200,
        body: {
          kind: "pending",
          session: expect.stringMatching(/^[0-9a-f]{32}$/),
          code: recorded.http.start.body.user_code,
          url: codexDevicePage,
          expiresAt: expect.any(String),
          pollMs: 2000,
        },
      });
      const handle = started.body.session as string;
      expect(await app.post(buddyRoutePaths.poll, { session: handle })).toEqual(
        started,
      );
      app.fake.approve("Fixture_Session_000001");
      expect(await app.post(buddyRoutePaths.poll, { session: handle })).toEqual(
        {
          status: 200,
          body: { kind: "signed-in" },
        },
      );
      expect((await app.get(buddyRoutePaths.read)).body.state).toBe("works");

      const again = await app.post(buddyRoutePaths.start);
      const cancelled = await app.post(buddyRoutePaths.cancel, {
        session: again.body.session,
      });
      expect(cancelled).toEqual({ status: 200, body: { kind: "cancelled" } });
      expect(app.fake.sessions.size).toBe(1); // the approved one, kept by Hermes
      expect(
        await app.post(buddyRoutePaths.cancel, { session: again.body.session }),
      ).toEqual({ status: 200, body: { kind: "none" } });

      expect(await app.post(buddyRoutePaths.signOut)).toEqual({
        status: 200,
        body: { kind: "signed-out" },
      });
      expect((await app.get(buddyRoutePaths.read)).body.state).toBe("waits");

      // The journal: the operation, the outcome and the reason, only.
      expect(lines.buddy()).toEqual([
        { scope: "buddy-sign-in", operation: "start", outcome: "pending" },
        { scope: "buddy-sign-in", operation: "poll", outcome: "signed-in" },
        { scope: "buddy-sign-in", operation: "start", outcome: "pending" },
        { scope: "buddy-sign-in", operation: "cancel", outcome: "cancelled" },
        {
          scope: "buddy-sign-in",
          operation: "sign-out",
          outcome: "signed-out",
        },
      ]);
      const everything = lines.lines.join("\n");
      for (const secret of [
        recorded.http.start.body.user_code,
        handle,
        again.body.session as string,
        ...app.fake.spent,
        ...hermesIds(app.fake),
      ])
        expect(everything).not.toContain(secret);
      // No answer ever carried a ticket or Hermes's session.
      const answers = JSON.stringify([started, again, cancelled]);
      for (const secret of [...app.fake.spent, ...hermesIds(app.fake)])
        expect(answers).not.toContain(secret);
    } finally {
      lines.restore();
      await app.close();
    }
  },
);

posix(
  "Hermes's refusal reaches the page as a closed reason; without Buddy's gateway the start is 503 buddy-unavailable",
  async () => {
    const lines = journal();
    const app = await hosted();
    try {
      app.fake.state.http = (request) =>
        request.path.endsWith("/start")
          ? Response.json(recorded.derived.startRefused.body, { status: 500 })
          : undefined;
      const refused = await app.post(buddyRoutePaths.start);
      expect(refused).toEqual({
        status: 200,
        body: { kind: "failed", reason: "refused" },
      });
      app.fake.state.http = undefined;
      await app.fake.stop();
      expect(await app.post(buddyRoutePaths.start)).toEqual({
        status: 503,
        body: { error: "buddy-unavailable", reason: "no-socket" },
      });
      expect(await app.post(buddyRoutePaths.signOut)).toEqual({
        status: 503,
        body: { error: "buddy-unavailable", reason: "no-socket" },
      });
      const everything = `${lines.lines.join("\n")}${JSON.stringify(refused)}`;
      expect(everything).not.toContain("OpenAI rejected");
      expect(everything).not.toContain("device-code authorization");
    } finally {
      lines.restore();
      await app.close();
    }
  },
);

posix(
  "a start, a cancel and a sign-out that need a running sign-in to end answer 409 blocked until Hermes confirms it, and change nothing",
  async () => {
    const lines = journal();
    const app = await hosted("buddy", { signedIn: true });
    try {
      const started = await app.post(buddyRoutePaths.start);
      const handle = started.body.session as string;
      app.fake.state.http = (request) =>
        request.method === "DELETE" &&
        request.path.startsWith("/api/providers/oauth/sessions/")
          ? Response.json({ detail: "Internal Server Error" }, { status: 500 })
          : undefined;
      const blocked = {
        status: 409,
        body: { kind: "blocked", reason: "sign-in-running" },
      };
      expect(await app.post(buddyRoutePaths.start)).toEqual(blocked);
      expect(
        await app.post(buddyRoutePaths.cancel, { session: handle }),
      ).toEqual(blocked);
      expect(await app.post(buddyRoutePaths.signOut)).toEqual(blocked);
      expect(app.fake.state.signedIn).toBe(true);
      expect(app.fake.sessions.size).toBe(1);
      expect(await app.post(buddyRoutePaths.poll, { session: handle })).toEqual(
        started,
      );
      app.fake.state.http = undefined;
      expect(
        await app.post(buddyRoutePaths.cancel, { session: handle }),
      ).toEqual({
        status: 200,
        body: { kind: "cancelled" },
      });
      expect(lines.buddy()).toEqual([
        { scope: "buddy-sign-in", operation: "start", outcome: "pending" },
        {
          scope: "buddy-sign-in",
          operation: "start",
          outcome: "blocked",
          reason: "sign-in-running",
        },
        {
          scope: "buddy-sign-in",
          operation: "cancel",
          outcome: "blocked",
          reason: "sign-in-running",
        },
        {
          scope: "buddy-sign-in",
          operation: "sign-out",
          outcome: "blocked",
          reason: "sign-in-running",
        },
        { scope: "buddy-sign-in", operation: "cancel", outcome: "cancelled" },
      ]);
      const everything = lines.lines.join("\n");
      for (const secret of [
        recorded.http.start.body.user_code,
        handle,
        ...app.fake.spent,
        ...hermesIds(app.fake),
      ])
        expect(everything).not.toContain(secret);
    } finally {
      lines.restore();
      await app.close();
    }
  },
);

posix(
  "admission: every POST, the poll included, only same-origin from the Launchpad's own origin; Buddy's frame and other sites are refused before Hermes is asked",
  async () => {
    const app = await hosted();
    try {
      const started = await app.post(buddyRoutePaths.start);
      const handle = started.body.session as string;
      const asked = app.fake.requests.length;
      const bodies: Record<string, unknown> = {
        [buddyRoutePaths.start]: {},
        [buddyRoutePaths.poll]: { session: handle },
        [buddyRoutePaths.cancel]: { session: handle },
        [buddyRoutePaths.signOut]: {},
      };
      const { origin: _origin, ...withoutOrigin } = app.sameOrigin;
      const { "sec-fetch-site": _site, ...withoutSite } = app.sameOrigin;
      for (const [path, body] of Object.entries(bodies))
        for (const headers of [
          withoutOrigin,
          withoutSite,
          { ...app.sameOrigin, "sec-fetch-site": "cross-site" },
          { ...app.sameOrigin, "sec-fetch-site": "same-site" },
          { ...app.sameOrigin, origin: "https://buddy.example.lazurio.io" },
          { ...app.sameOrigin, origin: "https://evil.example" },
          { ...app.sameOrigin, cookie: "__Secure-lazurio-workspace=forged" },
        ]) {
          const response = await app.send(path, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          expect(response.status).toBe(401);
          await response.body?.cancel();
        }
      // A read needs the session too.
      const { cookie: _cookie, ...anonymous } = app.valid;
      const unadmitted = await app.send(buddyRoutePaths.read, {
        headers: anonymous,
      });
      expect(unadmitted.status).toBe(401);
      await unadmitted.body?.cancel();
      expect(app.fake.requests.length).toBe(asked);
      // The sign-in survived every refused attempt.
      expect(await app.post(buddyRoutePaths.poll, { session: handle })).toEqual(
        started,
      );
    } finally {
      await app.close();
    }
  },
);

posix(
  "each route takes its method, JSON of its exact fields and no query: poll is a POST",
  async () => {
    const app = await hosted();
    try {
      const status = async (
        path: string,
        init: {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        },
      ) => {
        const response = await app.send(path, init);
        return { status: response.status, body: await response.json() };
      };
      expect(await status(buddyRoutePaths.poll, {})).toEqual({
        status: 405,
        body: { error: "method-not-allowed" },
      });
      expect(await status(buddyRoutePaths.start, {})).toEqual({
        status: 405,
        body: { error: "method-not-allowed" },
      });
      expect(
        await status(buddyRoutePaths.read, {
          method: "POST",
          headers: app.sameOrigin,
          body: "{}",
        }),
      ).toEqual({ status: 405, body: { error: "method-not-allowed" } });
      expect(
        await status(buddyRoutePaths.start, {
          method: "POST",
          headers: { ...app.sameOrigin, "content-type": "text/plain" },
          body: "{}",
        }),
      ).toEqual({ status: 415, body: { error: "invalid-content-type" } });
      expect(
        await status(buddyRoutePaths.start, {
          method: "POST",
          headers: app.sameOrigin,
          body: JSON.stringify({ padding: "x".repeat(20 * 1024) }),
        }),
      ).toEqual({ status: 413, body: { error: "body-too-large" } });
      for (const [path, body] of [
        [buddyRoutePaths.start, { tool: "codex" }],
        [buddyRoutePaths.signOut, { now: true }],
        [buddyRoutePaths.poll, {}],
        [buddyRoutePaths.cancel, { session: "a".repeat(32), extra: 1 }],
        [buddyRoutePaths.poll, []],
      ] as const)
        expect(
          await status(path, {
            method: "POST",
            headers: app.sameOrigin,
            body: JSON.stringify(body),
          }),
        ).toEqual({ status: 400, body: { error: "invalid-request" } });
      for (const session of ["A".repeat(32), "a".repeat(31), 7, "../x"])
        expect(await app.post(buddyRoutePaths.poll, { session })).toEqual({
          status: 400,
          body: { error: "invalid-session" },
        });
      expect(await status(`${buddyRoutePaths.read}?fresh=1`, {})).toEqual({
        status: 400,
        body: { error: "invalid-query" },
      });
      expect(app.fake.requests).toHaveLength(0);
    } finally {
      await app.close();
    }
  },
);

posix(
  "without Buddy's recorded origin every route answers 404 buddy-absent and his gateway is never asked",
  async () => {
    for (const kind of ["personal", "organization"] as const) {
      const app = await hosted(kind);
      try {
        expect(await app.get(buddyRoutePaths.read)).toEqual({
          status: 404,
          body: { error: "buddy-absent" },
        });
        for (const path of [
          buddyRoutePaths.start,
          buddyRoutePaths.poll,
          buddyRoutePaths.cancel,
          buddyRoutePaths.signOut,
        ])
          expect(await app.post(path, { session: "a".repeat(32) })).toEqual({
            status: 404,
            body: { error: "buddy-absent" },
          });
        expect(app.fake.control).toHaveLength(0);
        expect(app.fake.requests).toHaveLength(0);
      } finally {
        await app.close();
      }
    }
  },
);

posix(
  "a workstation has no recorded entry: every Buddy route is absent there",
  async () => {
    const fake = await fakeHermesGateway();
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-buddy-local-")),
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
        path: "/usr/bin:/bin",
        home: fake.userHome,
        xdg: {},
        platform: process.platform,
        run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
      },
    );
    try {
      const url = new URL(app.url);
      const token = url.hash.slice(1);
      const read = await fetch(new URL(buddyRoutePaths.read, url.origin), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(read.status).toBe(404);
      expect(await read.json()).toEqual({ error: "buddy-absent" });
      const start = await fetch(new URL(buddyRoutePaths.start, url.origin), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: url.origin,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(start.status).toBe(404);
      expect(await start.json()).toEqual({ error: "buddy-absent" });
      expect(fake.control).toHaveLength(0);
    } finally {
      await app.close();
      await fake.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);
