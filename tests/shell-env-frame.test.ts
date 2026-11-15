import { describe, expect, test } from "bun:test";
import type { MachineBinding } from "../src/folder/machine-binding";
import { ownerIdentity, shellDocument } from "../src/launchpad/shell-document";
import {
  parseShell,
  parseShellAccount,
  type ShellEnvironment,
  type ShellIdentity,
} from "../src/shell/contract";
import { envFrame, sameIdentity } from "../src/shell/env-frame";
import { bindings } from "./fixtures/machine-bindings";

// The frame of decision 0248's addendum of 2026-11-15 and 0180's: a page of
// another person's Environment has a red frame, a page of a shared one (a
// Team Environment, Henry, the services Environment of a server) a blue
// one, and the person's own has none. Whose it is comes from the document
// the Environment answers behind its gateway, never from the page, and the
// viewer from the Lazurio account. Both are compared only by an identity
// that survives a rename (the Lazurio Auth subject, the immutable GitHub
// id), never by a login or a username; an unknown side always gets a frame.

const apps = {
  apps: "https://launchpad.example-env.lazurio.io/",
  chat: null,
  automate: null,
};

const env = (fields: Partial<ShellEnvironment>): ShellEnvironment => ({
  id: "example-env",
  label: null,
  kind: "work",
  organizations: ["example"],
  assignee: null,
  apps,
  ...fields,
});

const matejSubject = "https://auth.lazurio.ai/realms/workspace/1111";
const janaSubject = "https://auth.lazurio.ai/realms/workspace/2222";
const matej: ShellIdentity = { subject: matejSubject, githubId: 101 };
const jana: ShellIdentity = { subject: janaSubject, githubId: 202 };

describe("sameIdentity", () => {
  test("one person only by a member both identities carry", () => {
    expect(sameIdentity(matej, matej)).toBe(true);
    // GitHub ids decide only where neither side has a subject: an identity
    // with a subject is a Lazurio account, and a GitHub id alone does not
    // prove it is the same one (an account may have relinked GitHub).
    expect(sameIdentity({ githubId: 101 }, { githubId: 101 })).toBe(true);
    expect(sameIdentity({ githubId: 101 }, matej)).toBe(false);
    expect(sameIdentity(matej, { githubId: 101 })).toBe(false);
    expect(
      sameIdentity({ subject: matejSubject }, { subject: matejSubject }),
    ).toBe(true);
    expect(sameIdentity(matej, jana)).toBe(false);
    // No member in common: not known to be one person.
    expect(sameIdentity({ subject: matejSubject }, { githubId: 101 })).toBe(
      false,
    );
    // The subject decides where both have one, whatever the GitHub ids say.
    expect(
      sameIdentity(
        { subject: matejSubject, githubId: 101 },
        { subject: janaSubject, githubId: 101 },
      ),
    ).toBe(false);
    expect(sameIdentity(undefined, matej)).toBe(false);
    expect(sameIdentity(matej, null)).toBe(false);
  });
});

describe("envFrame", () => {
  test("the person's own work Environment has no frame, another person's a red one with their name", () => {
    const janas = env({
      assignee: "jana",
      assigneeName: "Jana Dvořáková",
      ownerIdentity: jana,
    });
    expect(envFrame(janas, jana)).toBeNull();
    expect(envFrame(janas, matej)).toEqual({
      tone: "person",
      login: "jana",
      name: "Jana Dvořáková",
      kind: "work",
    });
  });

  test("a personal Environment is the viewer's own only by its owner's identity", () => {
    const own = env({
      kind: "personal",
      organizations: [],
      owner: "matej",
      ownerIdentity: matej,
    });
    expect(envFrame(own, matej)).toBeNull();
    expect(envFrame(own, jana)).toEqual({
      tone: "person",
      login: "matej",
      name: null,
      kind: "personal",
    });
  });

  test("a GitHub rename or relink keeps the person's own Environment unframed", () => {
    // The login shown changed after a rename; the subject and GitHub id did not.
    const renamed = env({ assignee: "matej-new", ownerIdentity: matej });
    expect(envFrame(renamed, matej)).toBeNull();
    // A relinked GitHub account: another GitHub id, the same Lazurio account.
    const relinked = env({
      kind: "personal",
      organizations: [],
      owner: "matej",
      ownerIdentity: { subject: matejSubject, githubId: 999 },
    });
    expect(envFrame(relinked, matej)).toBeNull();
  });

  test("a login equal to the viewer's username never makes another person's Environment the viewer's", () => {
    // Jana's GitHub login is "matej", the viewer's frozen Lazurio username.
    const work = env({ assignee: "matej", ownerIdentity: jana });
    expect(envFrame(work, matej)?.tone).toBe("person");
    const personal = env({
      kind: "personal",
      organizations: [],
      owner: "matej",
      ownerIdentity: jana,
    });
    expect(envFrame(personal, matej)?.tone).toBe("person");
  });

  test("an Environment or a viewer without an identity always gets a frame, never none", () => {
    expect(envFrame(env({ assignee: "matej" }), matej)?.tone).toBe("person");
    expect(
      envFrame(
        env({ kind: "personal", organizations: [], owner: "matej" }),
        matej,
      ),
    ).toEqual({ tone: "person", login: "matej", name: null, kind: "personal" });
    expect(
      envFrame(env({ assignee: "jana", ownerIdentity: jana }), null)?.tone,
    ).toBe("person");
  });

  test("Team Environments, Henry and the services Environment of a server are framed blue for everyone", () => {
    expect(
      envFrame(env({ kind: "team", label: "Team Lazurio" }), matej),
    ).toEqual({ tone: "shared", shared: "team", name: "Team Lazurio" });
    expect(
      envFrame(
        env({ kind: "team", label: "Team Lazurio", name: "Lazurio 2" }),
        matej,
      ),
    ).toEqual({ tone: "shared", shared: "team", name: "Lazurio 2" });
    expect(envFrame(env({ kind: "automated", label: "Henry" }), matej)).toEqual(
      { tone: "shared", shared: "henry", name: "Henry" },
    );
    expect(
      envFrame(env({ label: "Služby serveru", services: true }), matej),
    ).toEqual({ tone: "shared", shared: "services", name: "Služby serveru" });
    // A work Environment assigned to nobody is shared, never the viewer's.
    expect(envFrame(env({}), matej)).toEqual({
      tone: "shared",
      shared: "work",
      name: null,
    });
  });

  test("the person's own computer and a page of no Environment have no frame", () => {
    expect(
      envFrame(env({ kind: "workstation", organizations: [] }), null),
    ).toBeNull();
    expect(envFrame(undefined, matej)).toBeNull();
  });
});

describe("the members that say whose an Environment is (additive in v1)", () => {
  const document = (environment: Record<string, unknown>) => ({
    schema: "lazurio.shell.v1",
    locale: "cs",
    operator: { initials: null, login: null, avatar: null },
    current: "example-env",
    environments: [
      {
        id: "example-env",
        label: null,
        kind: "work",
        organizations: [],
        assignee: null,
        apps,
        ...environment,
      },
    ],
    organizations: [],
    dashboard: "https://dashboard.lazurio.ai/",
    account: "https://dashboard.lazurio.ai/settings",
    addOrganization: null,
  });

  test("an Environment keeps its owner's login, identity and the services mark", () => {
    const personal = parseShell(
      document({ kind: "personal", owner: "jana", ownerIdentity: jana }),
    );
    expect(personal?.environments[0]?.owner).toBe("jana");
    expect(personal?.environments[0]?.ownerIdentity).toEqual(jana);
    const work = parseShell(
      document({ assignee: "jana", ownerIdentity: { githubId: 202 } }),
    );
    expect(work?.environments[0]?.ownerIdentity).toEqual({ githubId: 202 });
    const services = parseShell(document({ services: true }));
    expect(services?.environments[0]?.services).toBe(true);
  });

  test("a misplaced or malformed member is left out, never the Environment", () => {
    for (const extra of [
      { owner: "jana" },
      { kind: "personal", owner: "not a login" },
      { services: "yes" },
      { kind: "team", services: true },
      { kind: "team", ownerIdentity: jana },
      { ownerIdentity: {} },
      { ownerIdentity: { githubId: 0 } },
      { ownerIdentity: { subject: "jana" } },
      { ownerIdentity: { login: "jana" } },
      { ownerIdentity: { ...jana, login: "jana" } },
    ]) {
      const shell = parseShell(document(extra));
      expect(shell?.environments).toHaveLength(1);
      expect(shell?.environments[0]?.owner).toBeUndefined();
      expect(shell?.environments[0]?.ownerIdentity).toBeUndefined();
      expect(shell?.environments[0]?.services).toBeUndefined();
    }
  });

  const account = (identity: unknown) => ({
    schema: "lazurio.account.v1",
    locale: "cs",
    operator: { initials: null, login: "matej", avatar: null },
    environments: [],
    organizations: [],
    last: null,
    ...(identity === undefined ? {} : { identity }),
  });

  test("the account document carries the viewer's identity, and a malformed one is left out", () => {
    expect(parseShellAccount(account(matej))?.identity).toEqual(matej);
    expect(parseShellAccount(account({ githubId: 101 }))?.identity).toEqual({
      githubId: 101,
    });
    for (const wrong of [
      undefined,
      {},
      { githubId: -1 },
      { login: "matej" },
      "matej",
    ]) {
      const parsed = parseShellAccount(account(wrong));
      expect(parsed).not.toBeNull();
      expect(parsed?.identity).toBeUndefined();
    }
  });
});

describe("the identity the Launchpad writes (ownerIdentity)", () => {
  const subject = "https://auth.lazurio.ai/realms/workspace/3333";
  const withOwner = (owner: unknown) =>
    ({ ...bindings.personal, owner }) as MachineBinding;
  const assigned = (assignment: unknown) =>
    ({
      ...bindings.organization,
      owner: { ...bindings.organization.owner, assignment },
    }) as MachineBinding;

  test("a personal Environment's owner by their GitHub id or their Lazurio account, never by a login", () => {
    expect(ownerIdentity(bindings.personal, "personal")).toEqual({
      githubId: 12345,
    });
    expect(
      ownerIdentity(
        withOwner({
          kind: "account",
          username: "example",
          subject,
          github: null,
        }),
        "personal",
      ),
    ).toEqual({ subject });
    expect(
      ownerIdentity(
        withOwner({
          kind: "account",
          username: "example",
          subject,
          github: { login: "renamed", id: 777 },
        }),
        "personal",
      ),
    ).toEqual({ subject, githubId: 777 });
  });

  test("a work Environment's assigned person, and nobody for a Team, Henry, the services Environment or no assignment", () => {
    expect(
      ownerIdentity(
        assigned({ kind: "operator", githubLogin: "example", githubId: 12345 }),
        "work",
      ),
    ).toEqual({ githubId: 12345 });
    expect(
      ownerIdentity(
        assigned({
          kind: "operator",
          account: { username: "example", subject, github: null },
        }),
        "work",
      ),
    ).toEqual({ subject });
    expect(ownerIdentity(bindings.organization, "work")).toBeNull();
    expect(ownerIdentity(bindings.assignedTeam, "team")).toBeNull();
    expect(ownerIdentity(bindings.automated, "automated")).toBeNull();
    expect(ownerIdentity(assigned({ kind: "services" }), "work")).toBeNull();
    expect(ownerIdentity(null, "workstation")).toBeNull();
  });

  test("the shell document carries it, so a page of the person's own Environment is unframed for them only", () => {
    const shell = shellDocument({
      preset: "hosted-personal",
      machine: bindings.personalEntry,
      locale: "en",
      catalog: { kind: "catalog", organizations: [] },
    });
    const environment = shell.environments[0];
    expect(environment?.ownerIdentity).toEqual({ githubId: 12345 });
    expect(envFrame(environment, { githubId: 12345 })).toBeNull();
    expect(envFrame(environment, { githubId: 54321 })?.tone).toBe("person");
    // A viewer known by their Lazurio account is not this principal owner by
    // the GitHub id alone: framed until the Environment records a subject.
    expect(
      envFrame(environment, { subject: matejSubject, githubId: 12345 })?.tone,
    ).toBe("person");
    expect(envFrame(environment, null)?.tone).toBe("person");
  });
});
