import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  type AuthFetcher,
  isAccountSubject,
  isLazurioUsername,
} from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import { startLaunchpad } from "../src/launchpad/server";
import {
  bitwardenGuide,
  offersBitwarden,
  parseVaultMembership,
  parseVaultPage,
  vaultPageLinks,
  vaultPageView,
} from "../src/launchpad/vault-page-view";
import type { MachineContext } from "../src/machine/context";
import { runTool } from "../src/tools/status";
import type { VaultEnvironmentKind } from "../src/vault/context";
import {
  type VaultHost,
  type VaultJournalEntry,
  vaultSetup,
} from "../src/vault/flow";
import { personAddress, vaultMembership } from "../src/vault/members";
import { readAccount, readSession, vaultPaths } from "../src/vault/store";
import {
  type FakeVault,
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownAccount,
  ownContext,
  personalHandover,
  startFakeVault,
  stateDirectory,
  vaultMember,
  vaultName,
  vaultOrigin,
  workAccount,
  workHandover,
  zipOf,
} from "./fixtures/fake-vault";
import {
  assignments,
  binding,
  handoverEntry,
  organizationWithEntry,
  personalWithEntry,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import { freePort } from "./fixtures/ports";

// Settings → Vault, Nastavení → Trezor, over HTTP (root decision 0198 points
// 2, 3 and 5; DEV-6631 tasks 648, 638b and 774; decision F53's addendum and
// F11's amendment of 2026-10-14, both amended on 2026-10-16 by root decision
// 0203): the installed consumer, `startLaunchpad` behind a fake gateway auth
// endpoint, with the fake Vaultwarden and the fake bw. The person is whom
// the gateway's own answer names, by the subject and the Lazurio username,
// and nothing else; their address is `<username>@account.lazurio.ai`. A
// personal or work Environment adds them, a work Environment's Správci leave
// when it is reassigned, a Team Environment does neither, a person named
// without a username is added nowhere; the page carries the vault's exact
// ids and nothing secret.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

/** Polls until `read` answers something, for at most `ms`. */
async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(25);
  }
}

const cookieName = "__Secure-lazurio-workspace";
const workHost = "workspace.example.lazurio.io";
const workName = "Example Pracovní workspace";
const reassigned = Object.freeze({
  kind: "operator",
  github_login: "another-example",
  github_id: 67890,
});

/** Whom the fake gateway's answer names for a session: the subject in
 * `X-Auth-Request-User`, the Lazurio username in
 * `X-Auth-Request-Preferred-Username`, each left out when null. */
type Named = Readonly<{ subject: string | null; username: string | null }>;
/** A person with a Lazurio account and its username, both invented. */
type Person = Readonly<{ subject: string; username: string }>;
const somebody = (): Person => {
  const subject = randomUUID();
  return { subject, username: `person-${subject.slice(0, 8)}` };
};

/** A hosted Environment of `kind` with its own vault set up, behind a fake
 * gateway that admits the cookies `__Secure-lazurio-workspace=<who>` it
 * knows: `people[who]` is whom its answer names, `null` a session it admits
 * without naming anyone. */
async function hosted(
  options: Readonly<{
    kind: Exclude<VaultEnvironmentKind, "automated">;
    /** Present: the installed hosted Launchpad, which looks at the
     * audience after its start. */
    vaultAtStart?: boolean;
    /** Runs once the vault is set up, before the Launchpad starts. */
    prepare?: (
      setUp: Readonly<{
        host: VaultHost;
        vault: FakeVault;
        state: { handover: MachineContext };
        organizationId: string;
      }>,
    ) => Promise<void>;
  }>,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-vault-page-")),
  );
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const account = options.kind === "personal" ? ownAccount : workAccount;
  vault.allow(account);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const journal: VaultJournalEntry[] = [];
  const state: { handover: MachineContext } = {
    handover:
      options.kind === "personal"
        ? personalHandover
        : workHandover(
            vaultMember(workAccount, workName),
            options.kind === "team" ? assignments.team : assignments.operator,
          ),
  };
  const host = fakeHost({
    home,
    vault,
    pin,
    download: fakeRelease(pin, zip).fetch,
    journal,
    context: async () => ownContext(state.handover, options.kind),
  });
  const setUp = await vaultSetup(host);
  if (setUp.state !== "connected") throw new Error("The vault is not set up");
  await options.prepare?.({
    host,
    vault,
    state,
    organizationId: setUp.organizationId,
  });
  const port = freePort();
  const folder = join(parent, `Lazurio-${port}`);
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset =
    options.kind === "personal"
      ? "hosted-personal"
      : options.kind === "work"
        ? "hosted-organization-personal"
        : "hosted-organization-team";
  const machine =
    options.kind === "personal"
      ? personalWithEntry(port)
      : options.kind === "work"
        ? organizationWithEntry(port)
        : binding({ ...organization, entry: handoverEntry(workHost, port) });
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  const people = new Map<string, Named | null>();
  const fetcher: AuthFetcher = async (_url, init) => {
    const cookie = new Headers(init.headers).get("cookie") ?? "";
    const who = cookie.startsWith(`${cookieName}=`)
      ? cookie.slice(cookieName.length + 1)
      : "";
    if (!people.has(who)) return new Response("no", { status: 401 });
    const named = people.get(who);
    const headers: Record<string, string> = {};
    if (typeof named?.subject === "string")
      headers["x-auth-request-user"] = named.subject;
    if (typeof named?.username === "string")
      headers["x-auth-request-preferred-username"] = named.username;
    return new Response(null, { status: 202, headers });
  };
  const base = join(parent, `b-${port}`);
  await mkdir(join(base, "update"), { recursive: true });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    options.vaultAtStart === true
      ? { base, version: "1.0.0", vaultAtStart: async () => true }
      : undefined,
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
    who: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        host: new URL(origin).host,
        cookie: `${cookieName}=${who}`,
        ...(method === "POST"
          ? {
              "content-type": "application/json",
              origin,
              "sec-fetch-site": "same-origin",
            }
          : {}),
        ...headers,
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const membershipOf = async (
    who: string,
    headers?: Record<string, string>,
  ) => {
    const answer = await send("POST", "/api/vault/membership", who, headers);
    const named = people.get(who) ?? null;
    const { address, ...body } = answer.body;
    expect([who, address]).toEqual([
      who,
      answer.status === 200 &&
      isAccountSubject(named?.subject) &&
      isLazurioUsername(named?.username)
        ? personAddress(named?.username ?? "")
        : undefined,
    ]);
    return { status: answer.status, body, full: answer.body };
  };
  const organizationId = async () => {
    const [own] = vault.organizationsOf(account);
    if (own === undefined) throw new Error("No vault");
    return own.id;
  };
  return {
    parent,
    home,
    vault,
    account,
    journal,
    state,
    paths: vaultPaths(
      stateDirectory(home, "vaultwarden.example.lazurio.io", account),
    ),
    /** A session the gateway admits, and whom its answer names (or
     * nobody). */
    admit(who: string, named: Named | null) {
      people.set(who, named);
    },
    page: (who: string, headers?: Record<string, string>) =>
      send("GET", "/api/vault", who, headers),
    /** The membership's answer, which carries the admitted person's own
     * address exactly where the gateway's answer named them with a Lazurio
     * username (F53's addendum of 2026-10-16), never one a header of the
     * request names (`membershipOf` checks it on every call); the rest,
     * which the cases compare. */
    async membership(who: string, headers?: Record<string, string>) {
      const { status, body } = await membershipOf(who, headers);
      return { status, body };
    },
    /** The membership's whole answer, its address included. */
    answer: async (who: string, headers?: Record<string, string>) =>
      (await membershipOf(who, headers)).full,
    send,
    organizationId,
    members: async () => vault.members(await organizationId()),
    /** The invitations the vault was asked for. */
    invitations: async () =>
      vault.of(`/api/organizations/${await organizationId()}/users/invite`),
    async close() {
      await app.close();
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const memberOf = (
  members: readonly { email: string; type: number; status: number }[],
  person: Person,
) => members.find((member) => member.email === personAddress(person.username));

test.skipIf(!posix)(
  "the vault page says the vault and its state, and its links carry the exact organization and collection ids",
  async () => {
    const s = await hosted({ kind: "personal" });
    try {
      s.admit("owner", somebody());
      const page = await s.page("owner");
      expect(page.status).toBe(200);
      const model = parseVaultPage(page.body);
      expect(model).toMatchObject({
        setup: null,
        environment: "personal",
        status: { state: "connected", origin: "own", name: vaultName },
      });
      const [own] = s.vault.organizationsOf(ownAccount);
      const agentiId = own?.collections[0]?.id;
      expect(vaultPageLinks(model?.status ?? null)).toEqual({
        add: `${vaultOrigin}/#/vault?organizationId=${own?.id}&collectionId=${agentiId}`,
        open: `${vaultOrigin}/#/vault?organizationId=${own?.id}`,
        account: `${vaultOrigin}/#/login`,
      });
      // The page names nothing secret: no account file value, no session.
      const recorded = await readAccount(s.paths);
      const session = (await readSession(s.paths)) ?? "?";
      for (const secret of [
        recorded?.masterPassword ?? "?",
        recorded?.clientSecret ?? "?",
        session,
      ])
        expect(JSON.stringify(page.body)).not.toContain(secret);
      // Only GET, without a query; a refused session is the gateway's.
      expect((await s.send("POST", "/api/vault", "owner")).status).toBe(405);
      expect((await s.page("stranger")).status).toBe(401);
      expect((await s.send("GET", "/api/vault?x=1", "owner")).status).toBe(400);
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "no identity means no membership action, and forged identity headers are ignored",
  async () => {
    const s = await hosted({ kind: "work" });
    try {
      const named = somebody();
      const other = somebody();
      s.vault.person(personAddress(named.username), true);
      s.vault.person(personAddress(other.username), true);
      const forged = {
        "x-auth-request-user": other.subject,
        "x-auth-request-preferred-username": other.username,
        "x-auth-request-email": personAddress(other.username),
        "x-forwarded-user": other.subject,
        "x-forwarded-email": personAddress(other.username),
      };
      // A session the gateway admits without naming anyone: nothing is
      // asked of the vault, whatever the request claims.
      s.admit("anonymous", null);
      const before = await s.vault.calls();
      expect(await s.membership("anonymous", forged)).toEqual({
        status: 200,
        body: { kind: "vault-member-unknown", reason: "no-identity" },
      });
      // The audience was recorded once, with nobody's membership touched.
      expect(await s.invitations()).toHaveLength(0);
      const calls = (await s.vault.calls()).slice(before.length);
      expect(calls).not.toContain("confirm");
      expect(memberOf(await s.members(), other)).toBeUndefined();
      // A named session: the gateway's person is the one added, at the
      // address of the gateway's username, never the one the request's
      // headers name.
      s.admit("named", named);
      expect(await s.membership("named", forged)).toEqual({
        status: 200,
        body: { kind: "vault-member", state: "member" },
      });
      expect(memberOf(await s.members(), named)).toMatchObject({
        type: 1,
        status: 2,
      });
      expect(memberOf(await s.members(), other)).toBeUndefined();
      // A write needs the gateway's session and the same origin.
      expect(
        (
          await s.membership("named", {
            origin: "https://elsewhere.example",
          })
        ).status,
      ).toBe(401);
      expect((await s.membership("stranger")).status).toBe(401);
      expect(
        (
          await s.send("POST", "/api/vault/membership", "named", {
            "content-type": "text/plain",
          })
        ).status,
      ).toBe(415);
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a person the gateway names without a Lazurio username is invited nowhere and asked to sign in again; once a sign-in carries it, the invitation names <username>@account.lazurio.ai",
  async () => {
    const s = await hosted({ kind: "work" });
    try {
      const petr: Person = { subject: randomUUID(), username: "petr" };
      // Accounts wait at the username's address and at the one an older
      // session's id would make: a lax reading would find either.
      s.vault.person(personAddress(petr.username), true);
      s.vault.person(personAddress(petr.subject), true);
      // Named without a username, or with the account's id, which a
      // session from before the username change carries; a username the
      // request claims changes nothing.
      s.admit("unnamed", { subject: petr.subject, username: null });
      s.admit("older", { subject: petr.subject, username: petr.subject });
      const before = await s.vault.calls();
      for (const who of ["unnamed", "older"])
        expect(
          await s.membership(who, {
            "x-auth-request-preferred-username": petr.username,
          }),
        ).toEqual({
          status: 200,
          body: { kind: "vault-member-unknown", reason: "no-username" },
        });
      // Nobody is invited or confirmed, and no person's address reaches
      // the vault at all, not even in the gate's question.
      expect(await s.invitations()).toHaveLength(0);
      expect((await s.vault.calls()).slice(before.length)).not.toContain(
        "confirm",
      );
      expect(JSON.stringify(s.vault.requests)).not.toContain(
        "@account.lazurio.ai",
      );
      expect(memberOf(await s.members(), petr)).toBeUndefined();
      // The page: the vault opens, and one line says why the person is not
      // added and asks them to sign in again.
      const view = vaultPageView(
        parseVaultPage((await s.page("older")).body),
        parseVaultMembership((await s.membership("older")).body),
        messages("cs"),
      );
      expect(view.actions.map((action) => action.label)).toEqual([
        "Otevřít trezor",
      ]);
      expect(view.hint).toBe(
        "Vaše přihlášení zatím neobsahuje uživatelské jméno v Lazuriu, proto vás toto Prostředí nemůže přidat do svého trezoru. Přihlaste se prosím znovu.",
      );
      // A sign-in that carries the username: the person is added at its
      // address, and only there.
      s.admit("again", petr);
      expect(await s.membership("again")).toEqual({
        status: 200,
        body: { kind: "vault-member", state: "member" },
      });
      expect(
        (await s.invitations()).map(
          (invitation) => (invitation.body as { emails?: unknown }).emails,
        ),
      ).toEqual([["petr@account.lazurio.ai"]]);
      expect(memberOf(await s.members(), petr)).toMatchObject({
        type: 1,
        status: 2,
      });
      expect(
        (await s.members()).some(
          (member) => member.email === personAddress(petr.subject),
        ),
      ).toBe(false);
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a person without an account is asked to create one; the vault is left without an invitation",
  async () => {
    const s = await hosted({ kind: "personal" });
    try {
      const person = somebody();
      s.admit("owner", person);
      expect(await s.membership("owner")).toEqual({
        status: 200,
        body: { kind: "vault-member", state: "no-account", signIn: true },
      });
      expect(memberOf(await s.members(), person)).toBeUndefined();
      expect(s.vault.registerable(personAddress(person.username))).toBe(false);
      expect(s.journal).toContainEqual({
        operation: "members",
        outcome: "no-account",
      });
      // The page's one action: "Vytvořit účet v trezoru", which starts the
      // vault's Lazurio sign-in with the person's own address from their
      // answer (F53's addendum of 2026-10-22); an answer without the address
      // leads to the vault's sign-in page, which asks for it first.
      const model = parseVaultPage((await s.page("owner")).body);
      const actions = (answer: Json) =>
        vaultPageView(
          model,
          parseVaultMembership(answer),
          messages("cs"),
        ).actions.map((action) => [action.label, action.href]);
      expect(actions(await s.answer("owner"))).toEqual([
        [
          "Vytvořit účet v trezoru",
          `${vaultOrigin}/#/sso?email=${person.username}%40account.lazurio.ai`,
        ],
      ]);
      expect(actions((await s.membership("owner")).body)).toEqual([
        ["Vytvořit účet v trezoru", `${vaultOrigin}/#/login`],
      ]);
      // Where the network's vault does not take the Lazurio sign-in, no
      // account button at all.
      const late = await hosted({ kind: "personal" });
      try {
        late.vault.flags.sso = false;
        late.admit("owner", person);
        const answer = await late.membership("owner");
        // Without SSO a password could be set on the address: nobody is
        // invited at all.
        expect(answer.body).toEqual({
          kind: "vault-member-unknown",
          reason: "sign-in-not-required",
        });
        expect(
          vaultPageView(
            parseVaultPage((await late.page("owner")).body),
            parseVaultMembership(answer.body),
            messages("cs"),
          ).actions,
        ).toEqual([]);
      } finally {
        await late.close();
      }
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "where the vault requires the Lazurio sign-in, an account without a master password stays invited, unregistrable, and is confirmed once the password is set",
  async () => {
    const s = await hosted({ kind: "work" });
    try {
      const person = somebody();
      const address = personAddress(person.username);
      s.vault.person(address, false);
      s.admit("person", person);
      expect(await s.membership("person")).toEqual({
        status: 200,
        body: {
          kind: "vault-member",
          state: "awaiting-password",
          signIn: true,
        },
      });
      // Invited, kept Invited, and nobody can register the address: the
      // vault refuses every password path of it.
      expect(await s.invitations()).toHaveLength(1);
      expect(memberOf(await s.members(), person)).toMatchObject({
        type: 1,
        status: 0,
      });
      expect(s.vault.registerable(address)).toBe(false);
      // Asked again before the password: nothing changes, nothing is sent.
      expect((await s.membership("person")).body).toMatchObject({
        state: "awaiting-password",
      });
      expect(await s.invitations()).toHaveLength(1);
      // The person sets the master password, the vault accepts the
      // invitation by itself, and the next look confirms.
      await s.vault.setPassword(address);
      expect(await s.membership("person")).toEqual({
        status: 200,
        body: { kind: "vault-member", state: "member" },
      });
      expect(memberOf(await s.members(), person)).toMatchObject({
        type: 1,
        status: 2,
      });
      expect(s.journal.map((entry) => entry.outcome)).toEqual(
        expect.arrayContaining(["invited", "confirmed"]),
      );
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "where a password could still be set on a person's address, nobody is invited or confirmed: SSO declared alone, or no SSO",
  async () => {
    for (const sso of [true, false]) {
      const s = await hosted({ kind: "work" });
      try {
        const stub = somebody();
        const accepted = somebody();
        const first = somebody();
        s.vault.person(personAddress(stub.username), false);
        s.vault.person(personAddress(accepted.username), true);
        s.vault.person(personAddress(first.username), true);
        // A first Správce while the vault required the Lazurio sign-in,
        // which records the assignment.
        s.admit("first", first);
        expect((await s.membership("first")).body).toMatchObject({
          state: "member",
        });
        s.vault.flags.sso = sso;
        s.vault.flags.ssoOnly = false;
        // An accepted member from before (e.g. SSO_ONLY turned off since):
        // never confirmed while a password could be set on its address.
        await s.vault.addMember(await s.organizationId(), {
          email: personAddress(accepted.username),
          type: 1,
          status: 1,
        });
        s.admit("stub", stub);
        s.admit("accepted", accepted);
        const before = await s.vault.calls();
        for (const who of ["stub", "accepted"])
          expect((await s.membership(who)).body).toEqual({
            kind: "vault-member-unknown",
            reason: "sign-in-not-required",
          });
        expect(await s.invitations()).toHaveLength(1);
        expect((await s.vault.calls()).slice(before.length)).not.toContain(
          "confirm",
        );
        expect(memberOf(await s.members(), stub)).toBeUndefined();
        expect(memberOf(await s.members(), accepted)).toMatchObject({
          status: 1,
        });
        expect(s.vault.registerable(personAddress(stub.username))).toBe(false);
        // The page: only the agents use the vault here for now.
        const view = vaultPageView(
          parseVaultPage((await s.page("stub")).body),
          parseVaultMembership((await s.membership("stub")).body),
          messages("cs"),
        );
        expect(view.actions).toEqual([]);
        expect(view.hint).toBe(
          "Trezor tohoto Prostředí používají jen jeho agenti.",
        );
      } finally {
        await s.close();
      }
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a failed or interrupted invitation leaves nothing registrable, and the next look goes on from what the vault holds",
  async () => {
    const s = await hosted({ kind: "work" });
    try {
      const lost = somebody();
      const refused = somebody();
      for (const person of [lost, refused])
        s.vault.person(personAddress(person.username), false);
      s.admit("lost", lost);
      s.admit("refused", refused);
      // The invitation is made, its answer lost.
      s.vault.flags.inviteFails = "after";
      expect((await s.membership("lost")).body).toEqual({
        kind: "vault-member-unknown",
        reason: "unreachable",
      });
      expect(memberOf(await s.members(), lost)).toMatchObject({ status: 0 });
      expect(s.vault.registerable(personAddress(lost.username))).toBe(false);
      // The next look finds it, makes no second one.
      expect((await s.membership("lost")).body).toMatchObject({
        state: "awaiting-password",
      });
      expect(await s.invitations()).toHaveLength(1);
      // The invitation is refused before it is made: nothing is there.
      s.vault.flags.inviteFails = "before";
      expect((await s.membership("refused")).body).toEqual({
        kind: "vault-member-unknown",
        reason: "unreachable",
      });
      expect(memberOf(await s.members(), refused)).toBeUndefined();
      expect(s.vault.registerable(personAddress(refused.username))).toBe(false);
      expect(s.journal).toContainEqual({
        operation: "members",
        outcome: "failed",
        reason: "unreachable",
      });
      // Then the person's password: accepted by the vault, confirmed here.
      await s.vault.setPassword(personAddress(lost.username));
      expect((await s.membership("lost")).body).toMatchObject({
        state: "member",
      });
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "an account with a master password is accepted, confirmed and a member; a member is left as is; a failed confirmation is accepted and retried",
  async () => {
    const s = await hosted({ kind: "personal" });
    try {
      const owner = somebody();
      s.vault.person(personAddress(owner.username), true);
      s.admit("owner", owner);
      await s.vault.confirmFails(true);
      expect(await s.membership("owner")).toEqual({
        status: 200,
        body: { kind: "vault-member", state: "accepted" },
      });
      expect(memberOf(await s.members(), owner)).toMatchObject({
        type: 1,
        status: 1,
      });
      await s.vault.confirmFails(false);
      expect(await s.membership("owner")).toEqual({
        status: 200,
        body: { kind: "vault-member", state: "member" },
      });
      expect(memberOf(await s.members(), owner)).toMatchObject({
        type: 1,
        status: 2,
      });
      // A member: nothing more is asked of the vault's API.
      const invitations = (await s.invitations()).length;
      expect(await s.membership("owner")).toEqual({
        status: 200,
        body: { kind: "vault-member", state: "member" },
      });
      expect(await s.invitations()).toHaveLength(invitations);
      expect(s.journal.map((entry) => entry.outcome)).toEqual(
        expect.arrayContaining(["invited", "not-confirmed", "confirmed"]),
      );
      // The page's actions for a member: "Přidat položku" and "Otevřít
      // trezor", in that order.
      const view = vaultPageView(
        parseVaultPage((await s.page("owner")).body),
        parseVaultMembership((await s.membership("owner")).body),
        messages("cs"),
      );
      expect(view.actions.map((action) => action.label)).toEqual([
        "Přidat položku",
        "Otevřít trezor",
      ]);
      // A person a Správce shared a collection with stays a User.
      const shared = somebody();
      await s.vault.addMember(await s.organizationId(), {
        email: personAddress(shared.username),
        type: 2,
        status: 2,
      });
      s.admit("shared", shared);
      expect((await s.membership("shared")).body).toEqual({
        kind: "vault-member",
        state: "member",
      });
      expect(memberOf(await s.members(), shared)).toMatchObject({ type: 2 });
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a reassigned work Environment's Správci leave the vault: only Admin-type members, never the Owner, Users or Custom members",
  async () => {
    const s = await hosted({ kind: "work" });
    try {
      const first = somebody();
      const next = somebody();
      for (const person of [first, next])
        s.vault.person(personAddress(person.username), true);
      s.admit("first", first);
      s.admit("next", next);
      expect((await s.membership("first")).body).toEqual({
        kind: "vault-member",
        state: "member",
      });
      const organizationId = await s.organizationId();
      const sharedWith = personAddress(somebody().username);
      const custom = personAddress(somebody().username);
      const otherAdmin = personAddress(somebody().username);
      await s.vault.addMember(organizationId, {
        email: sharedWith,
        type: 2,
        status: 2,
      });
      await s.vault.addMember(organizationId, {
        email: custom,
        type: 4,
        status: 2,
      });
      await s.vault.addMember(organizationId, {
        email: otherAdmin,
        type: 1,
        status: 0,
      });
      // Unchanged: nobody leaves.
      expect((await s.membership("first")).body).toMatchObject({
        state: "member",
      });
      expect(await s.members()).toHaveLength(5);
      // Assigned to someone else: every Admin leaves at the next look, then
      // the person at the browser (who has access now) is added.
      s.state.handover = workHandover(
        vaultMember(workAccount, workName),
        reassigned,
      );
      expect((await s.membership("next")).body).toEqual({
        kind: "vault-member",
        state: "member",
      });
      const after = await s.members();
      expect(
        after
          .map((member) => [member.email, member.type])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual(
        [
          [workAccount, 0],
          [sharedWith, 2],
          [custom, 4],
          [personAddress(next.username), 1],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
      expect(
        s.journal.filter((entry) => entry.outcome === "removed"),
      ).toHaveLength(2);
      // The earlier Správce, back while they still pass the gateway, is
      // added again: access to the Environment is the rule.
      expect((await s.membership("first")).body).toMatchObject({
        state: "member",
      });
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a personal Environment never removes anyone",
  async () => {
    const s = await hosted({ kind: "personal" });
    try {
      const owner = somebody();
      s.vault.person(personAddress(owner.username), true);
      const admin = personAddress(somebody().username);
      await s.vault.addMember(await s.organizationId(), {
        email: admin,
        type: 1,
        status: 2,
      });
      s.admit("owner", owner);
      expect((await s.membership("owner")).body).toMatchObject({
        state: "member",
      });
      s.admit("anonymous", null);
      expect((await s.membership("anonymous")).body).toEqual({
        kind: "vault-member-unknown",
        reason: "no-identity",
      });
      expect((await s.members()).map((member) => member.email)).toContain(
        admin,
      );
      expect(s.journal.map((entry) => entry.outcome)).not.toContain("removed");
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a Team Environment neither adds nor removes anyone, and says that only its agents use the vault",
  async () => {
    const s = await hosted({ kind: "team" });
    try {
      const member = somebody();
      s.vault.person(personAddress(member.username), true);
      const admin = personAddress(somebody().username);
      await s.vault.addMember(await s.organizationId(), {
        email: admin,
        type: 1,
        status: 2,
      });
      s.admit("member", member);
      const before = await s.vault.calls();
      const requests = s.vault.requests.length;
      const answer = await s.membership("member");
      expect(answer.body).toEqual({
        kind: "vault-member-unknown",
        reason: "not-managed",
      });
      expect((await s.vault.calls()).slice(before.length)).toBe("");
      expect(s.vault.requests).toHaveLength(requests);
      expect((await s.members()).map((member) => member.email)).toEqual([
        workAccount,
        admin,
      ]);
      const view = vaultPageView(
        parseVaultPage((await s.page("member")).body),
        parseVaultMembership(answer.body),
        messages("cs"),
      );
      expect(view.actions).toEqual([]);
      expect(view.hint).toBe(
        "Trezor tohoto Prostředí používají jen jeho agenti.",
      );
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "the installed Launchpad looks at the audience after its start: a reassigned work Environment's Správci leave without anyone opening the page",
  async () => {
    const person = somebody();
    const s = await hosted({
      kind: "work",
      vaultAtStart: true,
      // Under the first assignment a Správce was added; then the
      // Environment was assigned to someone else before this start.
      async prepare({ host, vault, state, organizationId }) {
        vault.person(personAddress(person.username), true);
        expect(await vaultMembership(host, person)).toEqual({
          kind: "vault-member",
          state: "member",
        });
        await vault.addMember(organizationId, {
          email: personAddress(somebody().username),
          type: 1,
          status: 2,
        });
        state.handover = workHandover(
          vaultMember(workAccount, workName),
          reassigned,
        );
      },
    });
    try {
      // The look ends with its journal: the vault lists the Správci gone
      // before the last removal is journaled.
      const removed = () =>
        s.journal.filter((entry) => entry.outcome === "removed");
      await until(
        async () =>
          removed().length >= 2 &&
          (await s.members()).every((member) => member.type !== 1),
      );
      expect(removed()).toHaveLength(2);
      expect(await s.members()).toEqual([
        expect.objectContaining({ email: workAccount, type: 0 }),
      ]);
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "no value, token or address reaches the logs, the journal, bw's argv or an answer, but the admitted person's own address in their membership answer",
  async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation(
      (...values: unknown[]) => {
        lines.push(values.map(String).join(" "));
      },
    );
    const s = await hosted({ kind: "work" });
    try {
      const people = [somebody(), somebody(), somebody()];
      s.vault.person(personAddress((people[0] as Person).username), true);
      s.vault.person(personAddress((people[1] as Person).username), false);
      const answers: unknown[] = [];
      // A membership answer carries the admitted person's own address, which
      // `membership` checks and sets aside (F53's addendum of 2026-10-16);
      // the rest of every answer names nobody.
      for (const [index, person] of people.entries()) {
        s.admit(`p${index}`, person);
        answers.push((await s.membership(`p${index}`)).body);
        answers.push((await s.page(`p${index}`)).body);
      }
      s.state.handover = workHandover(
        vaultMember(workAccount, workName),
        reassigned,
      );
      answers.push((await s.membership("p0")).body);
      expect(s.journal.map((entry) => entry.outcome)).toEqual(
        expect.arrayContaining([
          "invited",
          "confirmed",
          "no-account",
          "removed",
        ]),
      );
      const recorded = await readAccount(s.paths);
      const user = s.vault.users.get(s.account);
      const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: user?.id })).toString("base64url")}.signature`;
      const session = (await readSession(s.paths)) ?? "?";
      const secrets = [
        ...people.map((person) => person.subject),
        ...people.map((person) => person.username),
        ...people.map((person) => personAddress(person.username)),
        recorded?.masterPassword ?? "?",
        recorded?.clientSecret ?? "?",
        session,
        token,
      ];
      const argv = (await s.vault.calls())
        .split("\n")
        .map((line) => line.split("|session=")[0] ?? "")
        .join("\n");
      for (const secret of secrets) {
        expect(JSON.stringify(s.journal)).not.toContain(secret);
        expect(lines.join("\n")).not.toContain(secret);
        expect(argv).not.toContain(secret);
        expect(JSON.stringify(answers)).not.toContain(secret);
      }
      // The invitations went to the vault's API, never through argv.
      expect(argv).toContain("org-members");
      expect(argv).toContain("confirm org-member");
      expect(
        await readFile(join(s.home, "bw.calls"), "utf8").catch(() => ""),
      ).not.toContain("invite");
    } finally {
      log.mockRestore();
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a workstation's page says the vault is not here",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-vault-page-local-")),
    );
    const folder = join(parent, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "cs",
      detail: "concise",
      coordination: "direct",
    });
    const home = join(parent, "home");
    const vault = await startFakeVault(home);
    const zip = zipOf("bw", fakeBw);
    const pin = fakePin(zip);
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      {},
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
      fakeHost({
        home,
        vault,
        pin,
        download: fakeRelease(pin, zip).fetch,
        context: async () => ({ kind: "unsupported", reason: "workstation" }),
      }),
    );
    try {
      const url = new URL(app.url);
      const token = url.hash.slice(1);
      const page = await fetch(new URL("/api/vault", url.origin), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const model = parseVaultPage(await page.json());
      expect(model).toEqual({
        status: {
          kind: "vault-status",
          state: "unsupported",
          reason: "workstation",
        },
        setup: null,
        environment: null,
        name: null,
      });
      const membership = await fetch(
        new URL("/api/vault/membership", url.origin),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Origin: url.origin,
          },
          body: "{}",
        },
      );
      expect(await membership.json()).toEqual({
        kind: "vault-member-unknown",
        reason: "no-vault",
      });
      expect(vaultPageView(model, null, messages("cs"))).toMatchObject({
        note: "Trezor na tomto počítači není.",
        row: null,
        actions: [],
      });
      expect(vault.requests).toHaveLength(0);
    } finally {
      await app.close();
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "an Environment without a vault: the page's answer says why, and the page explains the vault, none on purpose in a public Organization (DEV-6631)",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-vault-page-none-")),
    );
    const folder = join(parent, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "cs",
      detail: "concise",
      coordination: "direct",
    });
    const home = join(parent, "home");
    const vault = await startFakeVault(home);
    const zip = zipOf("bw", fakeBw);
    const pin = fakePin(zip);
    let reason: "no-tailnet" | "no-vault" = "no-tailnet";
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      {},
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
      fakeHost({
        home,
        vault,
        pin,
        download: fakeRelease(pin, zip).fetch,
        context: async () => ({ kind: "unsupported", reason }),
      }),
    );
    try {
      const url = new URL(app.url);
      const token = url.hash.slice(1);
      const read = async () =>
        parseVaultPage(
          await (
            await fetch(new URL("/api/vault", url.origin), {
              headers: { Authorization: `Bearer ${token}` },
            })
          ).json(),
        );
      for (const [why, note] of [
        [
          "no-tailnet",
          "Tato Organizace je veřejná ukázka a skutečná hesla do ní nepatří, proto v ní trezor záměrně není. Všechno ostatní funguje jako ve skutečné Organizaci.",
        ],
        [
          "no-vault",
          "Trezor tohoto Prostředí není nastavený. Nastaví ho Admin Organizace a pak ho najdete tady.",
        ],
      ] as const) {
        reason = why;
        const model = await read();
        expect(model).toEqual({
          status: { kind: "vault-status", state: "unsupported", reason: why },
          setup: null,
          environment: null,
          name: null,
        });
        expect(vaultPageView(model, null, messages("cs"))).toMatchObject({
          note,
          row: null,
          actions: [],
        });
        expect(bitwardenGuide(model, null, messages("cs"))).toBeNull();
      }
      // Nothing was asked of the vault.
      expect(vault.requests).toHaveLength(0);
    } finally {
      await app.close();
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "Bitwarden in Codex Desktop: the steps carry the address of the vault the handover names, point to Vytvořit účet v trezoru while the person has no account, and are left out, with Začínáme's row, where only the agents use the vault",
  async () => {
    const cs = messages("cs");
    const s = await hosted({ kind: "work" });
    try {
      const person = somebody();
      s.admit("member", person);
      const read = async () => {
        const model = parseVaultPage((await s.page("member")).body);
        const standing = parseVaultMembership(await s.answer("member"));
        return bitwardenGuide(
          model,
          standing,
          cs,
          vaultPageView(model, standing, cs),
        );
      };
      // No account in the network's vault yet: the server to copy is the
      // handover's `vault.server_url`, the address the person's own, built
      // from the username of the gateway's answer, and the guide points to
      // the page's own button first.
      const first = await read();
      expect(s.state.handover.vault?.server_url).toBe(vaultOrigin);
      expect(first?.kind).toBe("server");
      expect(first?.steps.map((step) => step.value)).toEqual([
        null,
        vaultOrigin,
        personAddress(person.username),
        null,
      ]);
      expect(first?.first).toBe(cs.vaultBitwardenAccount);
      // The address comes only with a username the gateway's answer names:
      // none without one, none for nobody, and never another person's.
      s.admit("unnamed", { subject: randomUUID(), username: null });
      s.admit("nobody", null);
      for (const who of ["unnamed", "nobody"]) {
        const answer = await s.answer(who);
        expect([who, answer.address]).toEqual([who, undefined]);
        const standing = parseVaultMembership(answer);
        const model = parseVaultPage((await s.page(who)).body);
        expect(bitwardenGuide(model, standing, cs)?.steps[2]?.value).toBeNull();
      }
      const other = somebody();
      s.admit("other", other);
      expect((await s.answer("other")).address).toBe(
        personAddress(other.username),
      );
      // With an account, the steps alone.
      s.vault.person(personAddress(person.username), true);
      const joined = await read();
      expect(joined?.first).toBeNull();
      expect(joined?.steps[1]?.value).toBe(vaultOrigin);
    } finally {
      await s.close();
    }
    // A network whose vault does not require the Lazurio sign-in of people
    // yet (SSO declared, not SSO_ONLY): the membership says that only the
    // agents use the vault, so neither the page's steps nor Začínáme's row
    // (Pablo's review of #465).
    const open = await hosted({ kind: "work" });
    try {
      open.vault.flags.ssoOnly = false;
      open.admit("member", somebody());
      const model = parseVaultPage((await open.page("member")).body);
      const answer = (await open.membership("member")).body;
      expect(answer).toMatchObject({
        kind: "vault-member-unknown",
        reason: "sign-in-not-required",
      });
      const standing = parseVaultMembership(answer);
      expect(model?.status.state).toBe("connected");
      expect(bitwardenGuide(model, standing, cs)).toBeNull();
      expect(offersBitwarden(model, standing)).toBe(false);
      expect(vaultPageView(model, standing, cs).hint).toBe(
        cs.vaultPageAgentsOnly,
      );
    } finally {
      await open.close();
    }
    // A Team Environment adds nobody: only its agents use the vault, so the
    // page gives no steps.
    const team = await hosted({ kind: "team" });
    try {
      team.admit("member", somebody());
      const model = parseVaultPage((await team.page("member")).body);
      const standing = parseVaultMembership(
        (await team.membership("member")).body,
      );
      expect(model?.status.state).toBe("connected");
      expect(bitwardenGuide(model, standing, cs)).toBeNull();
    } finally {
      await team.close();
    }
  },
  60_000,
);
