import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import { startLaunchpad } from "../src/launchpad/server";
import {
  bitwardenGuide,
  parseVaultMembership,
  parseVaultPage,
  vaultPageView,
} from "../src/launchpad/vault-page-view";
import {
  parseVaultSettingUp,
  parseVaultStatus,
} from "../src/launchpad/vault-view";
import { acquireFileLock } from "../src/platform/flock";
import { runTool } from "../src/tools/status";
import type { VaultJournalEntry, VaultStatus } from "../src/vault/flow";
import { readAccount, readSession, vaultPaths } from "../src/vault/store";
import {
  cloudHost,
  startFakeBitwardenCloud,
} from "./fixtures/fake-bitwarden-cloud";
import {
  fakeBw,
  fakePin,
  fakeRelease,
  stateDirectory,
  zipOf,
} from "./fixtures/fake-vault";
import { personalWithEntry } from "./fixtures/machine-bindings";
import { freePort } from "./fixtures/ports";

// Settings → Vault on a personal Environment over HTTP (root decision 0203
// point 7, plan DEV-6631 task 775; F53's amendment of 2026-10-16, (2)): the
// installed consumer, `startLaunchpad` behind a fake gateway auth endpoint,
// with the fake Bitwarden cloud and the fake bw. The person connects their
// own Bitwarden with the agents' API key and master password alone (`POST
// /api/vault/connect`, exact keys, at most 16 KiB, the same origin), the
// Environment creates its vault, the person asks to be invited (`POST
// /api/vault/invitee`, the same rules), accepts, is confirmed, and
// disconnects; no value of the form or the address ever comes back or
// reaches a log, the journal or bw's arguments.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

const cookieName = "__Secure-lazurio-workspace";
const agents = "agents.example+lazurio@example.com";
const person = "person.example@example.com";
const password = "Correct horse battery staple 7";

/** A hosted personal Environment whose handover names no vault, behind a
 * fake gateway that admits the session `owner`. */
async function personal() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-vault-connect-")),
  );
  const home = join(parent, "home");
  const cloud = await startFakeBitwardenCloud(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const journal: VaultJournalEntry[] = [];
  const host = cloudHost({
    home,
    cloud,
    pin,
    download: fakeRelease(pin, zip).fetch,
    journal,
  });
  const port = freePort();
  const folder = join(parent, `Lazurio-${port}`);
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const machine = personalWithEntry(port);
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset: "hosted-personal",
    machine,
    profile: presetProfile("hosted-personal", executionOs(process.platform)),
  });
  const admitted = new Set<string>(["owner"]);
  const fetcher: AuthFetcher = async (_url, init) => {
    const cookie = new Headers(init.headers).get("cookie") ?? "";
    const who = cookie.startsWith(`${cookieName}=`)
      ? cookie.slice(cookieName.length + 1)
      : "";
    if (!admitted.has(who)) return new Response("no", { status: 401 });
    return new Response(null, {
      status: 202,
      headers: {
        "x-auth-request-user": randomUUID(),
        "x-auth-request-preferred-username": "example",
      },
    });
  };
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    {
      path: "/usr/bin:/bin",
      home,
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
    { ...host, enableForAgents: async () => undefined },
  );
  const origin = entry.externalOrigin;
  const send = async (
    method: "GET" | "POST",
    route: string,
    options: Readonly<{
      body?: string;
      who?: string;
      headers?: Record<string, string>;
    }> = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        host: new URL(origin).host,
        cookie: `${cookieName}=${options.who ?? "owner"}`,
        ...(method === "POST"
          ? {
              "content-type": "application/json",
              origin,
              "sec-fetch-site": "same-origin",
            }
          : {}),
        ...options.headers,
      },
      ...(method === "POST" ? { body: options.body ?? "{}" } : {}),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Json };
  };
  return {
    home,
    cloud,
    journal,
    send,
    connection: host.connection,
    paths: vaultPaths(stateDirectory(home, "vault.bitwarden.eu", agents)),
    page: async () => (await send("GET", "/api/vault")).body,
    membership: async () => (await send("POST", "/api/vault/membership")).body,
    async close() {
      await app.close();
      cloud.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** The setup a connection answered, followed by its job as the page does,
 * to the status it ends in. */
async function ended(
  s: Awaited<ReturnType<typeof personal>>,
  answer: Json,
): Promise<VaultStatus | null> {
  let value: unknown = answer;
  for (let turn = 0; turn < 400; turn += 1) {
    const running = parseVaultSettingUp(value);
    if (running === null) return parseVaultStatus(value);
    await Bun.sleep(50);
    value = (
      await s.send("POST", "/api/tools/bitwarden/setup", {
        body: JSON.stringify({ job: running.job }),
      })
    ).body;
  }
  throw new Error("The setup did not end");
}

test.skipIf(!posix)(
  "a personal Environment's person connects their own Bitwarden on the page: refused values say why, then the vault is created, they ask to be invited, are confirmed once they accept, and they disconnect",
  async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation(
      (...values: unknown[]) => {
        lines.push(values.map(String).join(" "));
      },
    );
    const s = await personal();
    const answers: string[] = [];
    try {
      const key = await s.cloud.account(agents, password, {
        type: 1,
        iterations: 2,
        memory: 16,
        parallelism: 1,
      });
      const form = {
        clientId: key.clientId,
        clientSecret: key.clientSecret,
        masterPassword: password,
      };
      // Waiting for its person: the page shows the section, with the name
      // the vault gets.
      const waiting = parseVaultPage(await s.page());
      expect(waiting).toEqual({
        status: { kind: "vault-status", state: "needs-connection" },
        setup: null,
        environment: "personal",
        name: "Osobní example",
      });
      const cs = messages("cs");
      expect(vaultPageView(waiting, null, cs)).toMatchObject({
        connect: { vault: "Osobní example" },
        invite: false,
        disconnect: false,
        row: null,
        actions: [],
      });
      // Nobody to invite yet.
      const early = await s.send("POST", "/api/vault/invitee", {
        body: JSON.stringify({ email: person }),
      });
      expect([early.status, early.body]).toEqual([
        409,
        { kind: "blocked", reason: "not-connected" },
      ]);

      // The form's body: exactly its keys, JSON, small, the same origin.
      const connect = async (
        body: unknown,
        headers?: Record<string, string>,
      ) => {
        const answer = await s.send("POST", "/api/vault/connect", {
          body: typeof body === "string" ? body : JSON.stringify(body),
          ...(headers === undefined ? {} : { headers }),
        });
        answers.push(answer.text);
        return answer;
      };
      const { masterPassword: _, ...missing } = form;
      for (const [body, status] of [
        [missing, 400],
        [{ ...form, extra: true }, 400],
        ["not json", 400],
        // No region and no person: the server finds the region, and the
        // person is invited only when they ask.
        [{ ...form, region: "eu" }, 400],
        [{ ...form, email: person }, 400],
        [{ ...form, masterPassword: "two\nlines" }, 400],
      ] as const)
        expect([body, (await connect(body)).status]).toEqual([body, status]);
      expect((await connect({ ...form, region: "eu" })).body).toEqual({
        error: "invalid-request",
      });
      expect(
        (await connect({ ...form, clientId: "organization.example" })).body,
      ).toEqual({ kind: "blocked", reason: "client-id-invalid" });
      expect(
        (await connect(form, { "content-type": "text/plain" })).status,
      ).toBe(415);
      expect(
        (await connect({ ...form, masterPassword: "x".repeat(17 * 1024) }))
          .status,
      ).toBe(413);
      expect(
        (await connect(form, { origin: "https://elsewhere.example" })).status,
      ).toBe(401);
      expect(
        (
          await s.send("POST", "/api/vault/connect", {
            body: JSON.stringify(form),
            who: "stranger",
          })
        ).status,
      ).toBe(401);
      expect((await s.send("GET", "/api/vault/connect")).status).toBe(405);
      // The cloud's refusal: said as a fixed reason, nothing kept.
      const wrong = await connect({ ...form, masterPassword: `${password}!` });
      expect([wrong.status, wrong.body]).toEqual([
        409,
        { kind: "blocked", reason: "wrong-password" },
      ]);
      expect(await readAccount(s.paths)).toBeNull();

      // Connected: the setup creates the vault.
      const connected = await connect(form);
      expect([200, 202]).toContain(connected.status);
      const status = await ended(s, connected.body);
      expect(status).toMatchObject({
        state: "connected",
        region: "eu",
        account: agents,
        name: "Osobní example",
        vault: "https://vault.bitwarden.eu",
      });
      const page = parseVaultPage(await s.page());
      expect(page?.status).toMatchObject({ state: "connected", region: "eu" });
      // Connecting again is refused: it is connected.
      expect((await connect(form)).body).toEqual({
        kind: "blocked",
        reason: "connected",
      });
      // Nobody is invited until the person asks: the page says it is
      // connected and offers the invitation. The answers are exact: they
      // never carry an address of a Lazurio account (F53's addendum of
      // 2026-10-16), although the gateway names a username, since the person
      // signs in with their own Bitwarden account.
      expect(s.cloud.mails).toEqual([]);
      const notInvited = await s.membership();
      answers.push(JSON.stringify(notInvited));
      expect(notInvited).toEqual({
        kind: "vault-member",
        state: "not-invited",
      });
      expect(
        vaultPageView(page, parseVaultMembership(notInvited), cs),
      ).toMatchObject({
        hint: "Váš Bitwarden je připojený.",
        invite: true,
        actions: [],
        disconnect: true,
      });
      // The invitation's body: exactly its one key, JSON, small, the same
      // origin, behind the same admission as the connection.
      const invite = async (
        body: unknown,
        headers?: Record<string, string>,
        route = "/api/vault/invitee",
      ) => {
        const answer = await s.send("POST", route, {
          body: typeof body === "string" ? body : JSON.stringify(body),
          ...(headers === undefined ? {} : { headers }),
        });
        answers.push(answer.text);
        return answer;
      };
      for (const [body, status] of [
        [{}, 400],
        [{ email: person, extra: true }, 400],
        ["not json", 400],
        [{ email: "not an address" }, 400],
        [{ email: agents.toUpperCase() }, 409],
      ] as const)
        expect([body, (await invite(body)).status]).toEqual([body, status]);
      expect((await invite({ email: "not an address" })).body).toEqual({
        kind: "blocked",
        reason: "email-invalid",
      });
      expect((await invite({ email: agents.toUpperCase() })).body).toEqual({
        kind: "blocked",
        reason: "same-account",
      });
      expect(
        (await invite({ email: person }, { "content-type": "text/plain" }))
          .status,
      ).toBe(415);
      expect((await invite({ email: "x".repeat(17 * 1024) })).status).toBe(413);
      expect(
        (
          await invite(
            { email: person },
            { origin: "https://elsewhere.example" },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await s.send("POST", "/api/vault/invitee", {
            body: JSON.stringify({ email: person }),
            who: "stranger",
          })
        ).status,
      ).toBe(401);
      expect(
        (await invite({ email: person }, undefined, "/api/vault/invitee?x=1"))
          .status,
      ).toBe(400);
      expect((await s.send("GET", "/api/vault/invitee")).status).toBe(405);
      // Another request holds the connection's lock: busy, nothing kept.
      const lock = await acquireFileLock(join(s.connection, "lock"), {
        timeoutMs: 1_000,
      });
      try {
        const busy = await invite({ email: person });
        expect([busy.status, busy.body]).toEqual([
          503,
          { kind: "blocked", reason: "busy" },
        ]);
      } finally {
        await lock.release();
      }
      expect(s.cloud.mails).toEqual([]);
      // Asked for: kept and invited at once, by the cloud's e-mail; the
      // answer is where the person stands, never their address.
      const pending = await invite({ email: ` ${person.toUpperCase()} ` });
      expect([pending.status, pending.body]).toEqual([
        200,
        { kind: "vault-member", state: "invitation-pending" },
      ]);
      expect(s.cloud.mails).toEqual([person]);
      expect(
        (await invite({ email: "someone.else@example.com" })).body,
      ).toEqual({ kind: "blocked", reason: "invited" });
      expect(await s.membership()).toEqual({
        kind: "vault-member",
        state: "invitation-pending",
      });
      expect(
        vaultPageView(page, parseVaultMembership(pending.body), cs),
      ).toMatchObject({
        hint: cs.vaultPageInvitationPending,
        invite: false,
        actions: [],
        disconnect: true,
      });
      expect(await s.cloud.accept(person)).toBe("accepted");
      const member = await s.membership();
      expect(member).toEqual({ kind: "vault-member", state: "member" });
      const [organization] = await s.cloud.organizationsOf(agents);
      expect(
        vaultPageView(page, parseVaultMembership(member), cs).actions.map(
          (action) => [action.label, action.href],
        ),
      ).toEqual([
        [
          "Přidat položku",
          `https://vault.bitwarden.eu/#/vault?organizationId=${organization?.id}&collectionId=${organization?.collections[0]?.id}`,
        ],
        [
          "Otevřít trezor",
          `https://vault.bitwarden.eu/#/vault?organizationId=${organization?.id}`,
        ],
      ]);

      // Disconnected: the account forgotten here, the organization kept.
      const recorded = await readAccount(s.paths);
      const session = (await readSession(s.paths)) ?? "?";
      const disconnected = await s.send("POST", "/api/vault/disconnect");
      answers.push(disconnected.text);
      expect([disconnected.status, disconnected.body]).toEqual([
        200,
        { kind: "vault-status", state: "needs-connection" },
      ]);
      expect(await readAccount(s.paths)).toBeNull();
      expect(await s.cloud.organizationsOf(agents)).toHaveLength(1);
      expect((await s.send("POST", "/api/vault/disconnect")).body).toEqual({
        kind: "blocked",
        reason: "not-connected",
      });
      expect((await invite({ email: person })).body).toEqual({
        kind: "blocked",
        reason: "not-connected",
      });
      expect(
        (
          await s.send("POST", "/api/vault/disconnect", {
            body: JSON.stringify({ all: true }),
          })
        ).status,
      ).toBe(400);

      // No value of the form, the session or the person's address in an
      // answer, a log line, the journal or bw's arguments. The agents'
      // account is the vault's own account, which its status names, as it
      // names the technical account of a Lazurio Vaultwarden; it reaches
      // nothing else.
      const argv = (await readFile(join(s.home, "bw.calls"), "utf8"))
        .split("\n")
        .map((line) => line.split("|session=")[0] ?? "")
        .join("\n");
      for (const secret of [
        password,
        `${password}!`,
        key.clientId,
        key.clientSecret,
        recorded?.clientSecret ?? "?",
        session,
        person,
      ]) {
        expect(answers.join("\n")).not.toContain(secret);
        expect(JSON.stringify(s.journal)).not.toContain(secret);
        expect(lines.join("\n")).not.toContain(secret);
        expect(argv).not.toContain(secret);
      }
      expect(JSON.stringify(s.journal)).not.toContain(agents);
      expect(lines.join("\n")).not.toContain(agents);
      expect(s.journal).toContainEqual({
        operation: "connect",
        outcome: "refused",
        reason: "wrong-password",
      });
      expect(s.journal).toContainEqual({
        operation: "connect",
        outcome: "connected",
      });
      expect(s.journal).toContainEqual({
        operation: "disconnect",
        outcome: "disconnected",
      });
    } finally {
      log.mockRestore();
      await s.close();
    }
  },
  120_000,
);

test.skipIf(!posix)(
  "an agents' account that owns another organization is refused on the page before anything is kept, and the Tools row only waits for the person",
  async () => {
    const s = await personal();
    try {
      const key = await s.cloud.account(agents, password);
      await s.cloud.ownsFreeOrganization(agents);
      const answer = await s.send("POST", "/api/vault/connect", {
        body: JSON.stringify({
          clientId: key.clientId,
          clientSecret: key.clientSecret,
          masterPassword: password,
        }),
      });
      expect([answer.status, answer.body]).toEqual([
        409,
        { kind: "blocked", reason: "owns-organization" },
      ]);
      expect(await readAccount(s.paths)).toBeNull();
      expect(parseVaultPage(await s.page())?.status).toEqual({
        kind: "vault-status",
        state: "needs-connection",
      });
      // The Tools row's status, refresh and setup: the same waiting state,
      // and nothing runs.
      for (const route of ["status", "refresh", "setup"])
        expect(
          (await s.send("POST", `/api/tools/bitwarden/${route}`)).body,
        ).toEqual({ kind: "vault-status", state: "needs-connection" });
      expect(
        await readFile(join(s.home, "bw.calls"), "utf8").catch(() => ""),
      ).toBe("");
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a personal Environment's own Bitwarden never offers a Lazurio address: waiting for its person, the membership answer has none although the gateway names a username",
  async () => {
    const s = await personal();
    try {
      expect(await s.membership()).toEqual({
        kind: "vault-member-unknown",
        reason: "not-connected",
      });
      const cs = messages("cs");
      const page = parseVaultPage(await s.page());
      expect(page?.status.state).toBe("needs-connection");
      expect(
        bitwardenGuide(page, parseVaultMembership(await s.membership()), cs),
      ).toBeNull();
    } finally {
      await s.close();
    }
  },
  60_000,
);
