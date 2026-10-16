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
  parseVaultMembership,
  parseVaultPage,
  vaultPageView,
} from "../src/launchpad/vault-page-view";
import {
  parseVaultSettingUp,
  parseVaultStatus,
} from "../src/launchpad/vault-view";
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

// Settings → Vault on a personal Environment over HTTP (root decision 0203
// point 7, plan DEV-6631 task 775): the installed consumer, `startLaunchpad`
// behind a fake gateway auth endpoint, with the fake Bitwarden cloud and the
// fake bw. The person connects their own Bitwarden through the one form
// (`POST /api/vault/connect`, exact keys, at most 16 KiB, the same origin),
// the Environment creates its vault and invites them, they accept, they are
// confirmed, they disconnect; no value of the form ever comes back or
// reaches a log, the journal or bw's arguments.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

const cookieName = "__Secure-lazurio-workspace";
const agents = "agents.example+lazurio@example.com";
const person = "person.example@example.com";
const password = "Correct horse battery staple 7";

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
  "a personal Environment's person connects their own Bitwarden on the page: refused values say why, then the vault is created, they are invited, confirmed once they accept, and they disconnect",
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
        region: "eu",
        clientId: key.clientId,
        clientSecret: key.clientSecret,
        masterPassword: password,
        email: person,
      };
      // Waiting for its person: the page shows the form.
      const waiting = parseVaultPage(await s.page());
      expect(waiting).toEqual({
        status: { kind: "vault-status", state: "needs-connection" },
        setup: null,
        environment: "personal",
      });
      const cs = messages("cs");
      expect(vaultPageView(waiting, null, cs)).toMatchObject({
        connect: true,
        disconnect: false,
        row: null,
        actions: [],
      });

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
      const { email: _, ...missing } = form;
      for (const [body, status] of [
        [missing, 400],
        [{ ...form, extra: true }, 400],
        ["not json", 400],
        [{ ...form, region: "de" }, 400],
        [{ ...form, masterPassword: "two\nlines" }, 400],
      ] as const)
        expect([body, (await connect(body)).status]).toEqual([body, status]);
      expect((await connect({ ...form, region: "de" })).body).toEqual({
        kind: "blocked",
        reason: "region-invalid",
      });
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

      // Connected: the setup creates the vault and invites the person.
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
      // The person: invited by the cloud's e-mail, then confirmed once they
      // accepted it.
      expect(s.cloud.mails).toEqual([person]);
      const pending = await s.membership();
      answers.push(JSON.stringify(pending));
      expect(pending).toEqual({
        kind: "vault-member",
        state: "invitation-pending",
      });
      expect(
        vaultPageView(page, parseVaultMembership(pending), cs),
      ).toMatchObject({
        hint: cs.vaultPageInvitationPending,
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
          region: "eu",
          clientId: key.clientId,
          clientSecret: key.clientSecret,
          masterPassword: password,
          email: person,
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
