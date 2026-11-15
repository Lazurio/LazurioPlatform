import { describe, expect, test } from "bun:test";
import { parseShell, type ShellEnvironment } from "../src/shell/contract";
import { envFrame } from "../src/shell/env-frame";

// The frame of decision 0248's addendum of 2026-11-15 and 0180's: a page of
// another person's Environment has a red frame, a page of a shared one (a
// Team Environment, Henry, the services Environment of a server) a blue
// one, and the person's own has none. Whose it is comes from the document
// the Environment answers behind its gateway, never from the page, and the
// viewer from the Lazurio account; an unknown viewer always gets a frame.

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

describe("envFrame", () => {
  test("the person's own work Environment has no frame, another person's a red one with their name", () => {
    const jana = env({ assignee: "jana", assigneeName: "Jana Dvořáková" });
    expect(envFrame(jana, "jana")).toBeNull();
    expect(envFrame(jana, "JANA")).toBeNull();
    expect(envFrame(jana, "matej")).toEqual({
      tone: "person",
      login: "jana",
      name: "Jana Dvořáková",
      kind: "work",
    });
  });

  test("a personal Environment is the viewer's own only by its owner", () => {
    const own = env({ kind: "personal", organizations: [], owner: "matej" });
    expect(envFrame(own, "matej")).toBeNull();
    expect(envFrame(own, "jana")).toEqual({
      tone: "person",
      login: "matej",
      name: null,
      kind: "personal",
    });
    // Without its owner nobody can tell it is the viewer's: framed.
    expect(
      envFrame(env({ kind: "personal", organizations: [] }), "matej"),
    ).toEqual({ tone: "person", login: null, name: null, kind: "personal" });
  });

  test("Team Environments, Henry and the services Environment of a server are framed blue for everyone", () => {
    expect(
      envFrame(env({ kind: "team", label: "Team Lazurio" }), "matej"),
    ).toEqual({
      tone: "shared",
      shared: "team",
      name: "Team Lazurio",
    });
    expect(
      envFrame(
        env({ kind: "team", label: "Team Lazurio", name: "Lazurio 2" }),
        "matej",
      ),
    ).toEqual({ tone: "shared", shared: "team", name: "Lazurio 2" });
    expect(
      envFrame(env({ kind: "automated", label: "Henry" }), "matej"),
    ).toEqual({
      tone: "shared",
      shared: "henry",
      name: "Henry",
    });
    expect(
      envFrame(env({ label: "Služby serveru", services: true }), "matej"),
    ).toEqual({ tone: "shared", shared: "services", name: "Služby serveru" });
    // A work Environment assigned to nobody is shared, never the viewer's.
    expect(envFrame(env({}), "matej")).toEqual({
      tone: "shared",
      shared: "work",
      name: null,
    });
  });

  test("an unknown viewer always gets a frame, never none", () => {
    expect(envFrame(env({ assignee: "jana" }), null)?.tone).toBe("person");
    expect(
      envFrame(
        env({ kind: "personal", organizations: [], owner: "jana" }),
        null,
      )?.tone,
    ).toBe("person");
  });

  test("the person's own computer and a page of no Environment have no frame", () => {
    expect(
      envFrame(env({ kind: "workstation", organizations: [] }), null),
    ).toBeNull();
    expect(envFrame(undefined, "matej")).toBeNull();
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

  test("a personal Environment keeps its owner and the services Environment its mark", () => {
    const personal = parseShell(document({ kind: "personal", owner: "jana" }));
    expect(personal?.environments[0]?.owner).toBe("jana");
    const services = parseShell(document({ services: true }));
    expect(services?.environments[0]?.services).toBe(true);
  });

  test("an owner beside another kind, a malformed owner or another mark is left out, never the Environment", () => {
    for (const extra of [
      { owner: "jana" },
      { kind: "personal", owner: "not a login" },
      { services: "yes" },
      { kind: "team", services: true },
    ]) {
      const shell = parseShell(document(extra));
      expect(shell?.environments).toHaveLength(1);
      expect(shell?.environments[0]?.owner).toBeUndefined();
      expect(shell?.environments[0]?.services).toBeUndefined();
    }
  });
});
