import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentScope } from "../src/content/model";
import {
  assignedPerson,
  isServerServices,
  type MachineBinding,
  parseMachineBinding,
  unknownAssignment,
} from "../src/folder/machine-binding";
import {
  allowedPresets,
  derivePreset,
  githubIdentity,
  machineAssignment,
  presetProfile,
  presetReference,
  selectablePresets,
} from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { workEnvironment } from "../src/github/pilot";
import { launchpadBoot } from "../src/launchpad/boot-document";
import { signsInAsPerson } from "../src/launchpad/first-run";
import {
  assignmentText,
  environmentFacts,
  presetLabel,
} from "../src/launchpad/machine-view";
import { messages } from "../src/launchpad/messages";
import {
  assigneeLogin,
  environmentKind,
  operatorLogin,
  presetKinds,
  shellDocument,
} from "../src/launchpad/shell-document";
import { machineInspection } from "../src/machine/cli";
import {
  type OrganizationWorkspaceContext,
  parseMachineContext,
} from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import type { Catalog } from "../src/organizations/catalog";
import { bindingValues, contextValues } from "../src/recover/private-values";
import { shellMessages } from "../src/shell/messages";
import { environmentName, environmentWho } from "../src/shell/view";
import { githubLoginRefused } from "../src/tools/github-gate";
import { assignmentOf, vaultContextOf } from "../src/vault/context";
import type { VaultHost } from "../src/vault/flow";
import { vaultMembership } from "../src/vault/members";
import { pilotWorld } from "./fixtures/github-pilot";
import { assignments, bindings } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";
import services from "./fixtures/machine-context-services.json";

// Root decision 0209 (plan DEV-6674): every Proxmox server of an Organization
// has one services Environment `services-NN`, to people "Služby serveru"
// ("Server services"): a work Environment of the Organization that only its
// Owners and Admins enter. Machines gives it the closed handover assignment
// {"kind": "services"} and lists its services (Machines
// docs/server-services.md §2 and §2.1). The fixture is shaped like that
// handover with example names only: its Team is the broker's GitHub Team
// (`server-services`), whose grants scope the brokered GitHub identity, and
// its admission (the Owner role of the Organization) is the gateway's, which
// the handover does not carry and the Platform derives nothing from.

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const servicesBinding = bindings.services;
const team = derivePreset(servicesBinding);
const organizationPresets = [
  "hosted-organization-personal",
  "hosted-organization-team",
  "hosted-organization-steward",
] as const;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("the vendored schema has Machines' closed `services` assignment and the Organization branch's `services` member", () => {
  const defs = (
    schema as unknown as {
      $defs: Record<string, Record<string, unknown>>;
    }
  ).$defs;
  const branches = (defs.organization_assignment as { oneOf: unknown[] }).oneOf;
  expect(branches).toContainEqual({
    description: expect.any(String),
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: { kind: { const: "services" } },
  });
  const work = defs.organization_workspace_vm as {
    properties: Record<string, Record<string, unknown>>;
  };
  expect(work.properties.services).toMatchObject({
    type: "array",
    maxItems: 32,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind"],
    },
  });
  // Only the Organization branch carries either.
  const personalVm = defs.personal_vm as {
    properties: Record<string, unknown>;
  };
  expect("services" in personalVm.properties).toBe(false);
});

test("a services Environment's handover is read exactly as written and observed with no authority", () => {
  const context = parseMachineContext(bytes(services));
  expect(JSON.stringify(context)).toBe(JSON.stringify(services));
  expect(context.owner).toEqual({
    kind: "organization",
    organization: "example",
    organization_key: "Example",
    team: "server-services",
    assignment: { kind: "services" },
  });
  if (context.owner.kind !== "organization") throw new Error("organization");
  expect(Object.isFrozen(context.owner.assignment)).toBe(true);
  if (context.machine.kind !== "workspace-vm") throw new Error("work VM");
  const listed = (context as OrganizationWorkspaceContext).services;
  expect(listed).toEqual(services.services as never);
  expect(Object.isFrozen(listed)).toBe(true);
  expect(context.account).toBeNull();
  expect(machineInspection({ context, digest: "a".repeat(64) })).toEqual({
    kind: "machine-context-observed",
    context,
    digest: "a".repeat(64),
    authority: "none",
  });
  // The assignment alone, on the base work VM of the other fixtures, reads
  // too: Machines may write it without listing a service.
  const bare = {
    ...organization,
    owner: { ...organization.owner, assignment: assignments.services },
  };
  expect(parseMachineContext(bytes(bare)).owner).toMatchObject({
    assignment: { kind: "services" },
  });
});

const service = services.services[0];
for (const [name, input] of Object.entries({
  "an assignment of another unknown kind": {
    ...services,
    owner: { ...services.owner, assignment: { kind: "server-services" } },
  },
  "a services kind in another case": {
    ...services,
    owner: { ...services.owner, assignment: { kind: "Services" } },
  },
  "a services assignment naming a person": {
    ...services,
    owner: {
      ...services.owner,
      assignment: { kind: "services", github_login: "example", github_id: 1 },
    },
  },
  "a services assignment naming a Team": {
    ...services,
    owner: {
      ...services.owner,
      assignment: { kind: "services", team: "server-services" },
    },
  },
  "a services assignment on the personal branch": {
    ...personal,
    owner: { ...personal.owner, assignment: assignments.services },
  },
  "services on the personal branch": {
    ...personal,
    services: services.services,
  },
  "a service of unknown kind": {
    ...services,
    services: [{ ...service, kind: "database" }],
  },
  "a service without its kind": {
    ...services,
    services: [{ id: "team-01" }],
  },
  "a service with a hostname": {
    ...services,
    services: [{ ...service, hostname: "team-01.example.lazurio.io" }],
  },
  "a page on a privileged port": {
    ...services,
    services: [{ ...service, page_port: 1024 }],
  },
  "a page beyond the port range": {
    ...services,
    services: [{ ...service, page_port: 65536 }],
  },
  "services that are no list": {
    ...services,
    services: { "team-01": service },
  },
}))
  test(`the handover refuses ${name}`, () => {
    expect(() => parseMachineContext(bytes(input))).toThrow(
      "machine-context-invalid",
    );
  });

test("the binding projects the services assignment one to one, names nobody and records no service", () => {
  expect(servicesBinding.owner).toEqual({
    kind: "organization",
    organization: "example",
    team: "server-services",
    assignment: { kind: "services" },
  });
  if (servicesBinding.owner.kind !== "organization")
    throw new Error("organization");
  expect(Object.isFrozen(servicesBinding.owner.assignment)).toBe(true);
  expect("services" in servicesBinding).toBe(false);
  expect(isServerServices(servicesBinding)).toBe(true);
  expect(isServerServices(bindings.assignedTeam)).toBe(false);
  expect(assignedPerson(servicesBinding.owner.assignment)).toBeNull();
  // The binding a Folder stores reads back exactly, and refuses what no
  // handover could project.
  expect(
    parseMachineBinding(JSON.parse(JSON.stringify(servicesBinding))),
  ).toEqual(servicesBinding);
  for (const assignment of [
    { kind: "services", githubLogin: "example", githubId: 12345 },
    { kind: "services", team: "server-services" },
    { kind: "Services" },
    { kind: "server-services" },
  ])
    expect(() =>
      parseMachineBinding({
        ...servicesBinding,
        owner: { ...servicesBinding.owner, assignment },
      }),
    ).toThrow();
  expect(() =>
    parseMachineBinding({
      ...bindings.personal,
      owner: { ...bindings.personal.owner, assignment: { kind: "services" } },
    }),
  ).toThrow();
  // Every match on the kind ends in the guard; a kind no match handles fails.
  expect(() => unknownAssignment("everyone" as never)).toThrow(
    "Invalid Machine assignment",
  );
  expect(() => assignedPerson({ kind: "everyone" } as never)).toThrow(
    "Invalid Machine assignment",
  );
});

test("Služby serveru derive the Team preset and only it: GitHub only through the Organization's broker, never a person's sign-in", () => {
  for (const binding of [servicesBinding, bindings.assignedServices]) {
    expect(machineAssignment(binding)).toBe("services");
    expect(derivePreset(binding)).toBe("hosted-organization-team");
    expect(selectablePresets(binding)).toEqual(["hosted-organization-team"]);
    expect(allowedPresets(binding)).toEqual(organizationPresets);
    expect(presetReference("hosted-organization-team", binding)).toEqual({
      name: "hosted-organization-team",
      version: 1,
      selection: "derived",
    });
    for (const other of [
      "hosted-organization-personal",
      "hosted-organization-steward",
    ] as const)
      expect(() => presetReference(other, binding)).toThrow(
        "Workspace preset is not allowed by the Machine handover",
      );
  }
  if (team === null) throw new Error("derived");
  expect(githubIdentity(team, servicesBinding)).toBe("brokered-organization");
  expect(githubLoginRefused(team, "gh", "login")).toBe(true);
  expect(githubLoginRefused(team, "gh", "ssh-key")).toBe(true);
  // No Začínáme asks the person to sign in to GitHub there, and the hosting
  // prepares its content through the broker.
  expect(signsInAsPerson(team)).toBe(false);
  expect(contentScope(team, servicesBinding)).toEqual({
    allowed: false,
    reason: "prepared-by-hosting",
  });
});

test("the GitHub sign-in pilot refuses Služby serveru, also where a Folder's state names a person's Work preset", async () => {
  const world = await pilotWorld({
    preset: "hosted-organization-team",
    machine: servicesBinding,
  });
  cleanups.push(world.cleanup);
  expect(await workEnvironment(world.hostedFolder)).toEqual({
    kind: "refused",
    reason: "not-work-environment",
    preset: "hosted-organization-team",
  });
  // No supported path records the Work preset on Služby serveru (a new
  // choice takes only the Team preset, and a refresh that would derive
  // another preset is blocked); a Folder whose state says so anyway still
  // offers no person's sign-in.
  const forged = await pilotWorld({ preset: "hosted-organization-personal" });
  cleanups.push(forged.cleanup);
  const file = join(forged.folder as string, ".lazurio", "preferences.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  state.machine.owner.assignment = { kind: "services" };
  await writeFile(file, JSON.stringify(state));
  expect(await workEnvironment(forged.hostedFolder)).toEqual({
    kind: "refused",
    reason: "subject-unknown",
    preset: "hosted-organization-personal",
  });
});

test("no person is named or withheld for Služby serveru, and no personal operator owns them", () => {
  const context = parseMachineContext(bytes(services));
  for (const values of [
    bindingValues(servicesBinding),
    contextValues(context),
  ]) {
    const kinds = values.map((entry) => entry.kind);
    expect(kinds).not.toContain("github-login");
    expect(kinds).not.toContain("github-id");
    expect(values).toContainEqual({ kind: "team", value: "server-services" });
    expect(values).toContainEqual({ kind: "organization", value: "example" });
  }
  expect(operatorLogin(servicesBinding)).toBeNull();
  expect(assigneeLogin(servicesBinding, "work")).toBeNull();
  // The operator's and the Automated Environment's person stay withheld.
  expect(
    bindingValues(bindings.assignedOperator).map((entry) => entry.kind),
  ).toContain("github-login");
});

test("the vault of Služby serveru fingerprints its assignment and, like a Team Environment's, adds no person", async () => {
  const context = parseMachineContext(bytes(services));
  const fingerprint = assignmentOf(context);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const assigned = (assignment: unknown) =>
    assignmentOf(
      parseMachineContext(
        bytes({ ...services, owner: { ...services.owner, assignment } }),
      ),
    );
  expect(assigned(assignments.services)).toBe(fingerprint);
  for (const other of [
    assignments.team,
    assignments.operator,
    assignments.automation,
  ])
    expect(assigned(other)).not.toBe(fingerprint);
  if (team === null) throw new Error("derived");
  const own = vaultContextOf({
    handover: context,
    environment: presetKinds[team] as "team",
  });
  expect(own).toMatchObject({
    kind: "own",
    environment: "team",
    organization: "example",
    assignment: fingerprint,
  });
  const host = { context: async () => own } as unknown as VaultHost;
  expect(
    await vaultMembership(host, { subject: "account|1", username: "jana" }),
  ).toEqual({ kind: "vault-member-unknown", reason: "not-managed" });
});

const catalog: Catalog = {
  kind: "catalog",
  organizations: [
    {
      directory: "example_GEN3",
      organization: "example",
      displayName: "Example",
      state: "current",
      issues: [],
      executable: true,
      teams: [{ slug: "server-services", displayName: "Server services" }],
      modules: [],
      repositories: [],
    },
  ],
};

test("the shell names Služby serveru a work Environment, never a Team one, assigned to nobody", () => {
  if (team === null) throw new Error("derived");
  for (const [locale, name, kind] of [
    ["cs", "Služby serveru", "Pracovní"],
    ["en", "Server services", "Work"],
  ] as const) {
    const shell = shellDocument({
      preset: team,
      machine: servicesBinding,
      locale,
      catalog,
    });
    const [environment] = shell.environments;
    if (environment === undefined) throw new Error("The document has one");
    expect(environment).toMatchObject({
      id: "services-01.example",
      label: name,
      kind: "work",
      organizations: ["example"],
      assignee: null,
    });
    expect(shell.operator).toEqual({
      initials: null,
      login: null,
      avatar: null,
    });
    const copy = shellMessages(locale);
    expect(environmentName(environment, copy)).toBe(name);
    expect(environmentWho(environment, copy)).toBe(kind);
    // The Launchpad's first paint takes the same kind.
    const boot = launchpadBoot({
      preset: team,
      machine: servicesBinding,
      locale,
      catalog,
      entry: servicesBinding.entry ?? null,
      tailnet: null,
    });
    expect(boot.shell?.environments[0]?.kind).toBe("work");
  }
  expect(environmentKind(team, servicesBinding)).toBe("work");
  // A Team Environment of the same preset stays a Team one.
  expect(environmentKind(team, bindings.assignedTeam)).toBe("team");
  expect(
    shellDocument({
      preset: team,
      machine: bindings.assignedTeam as MachineBinding,
      locale: "cs",
      catalog,
    }).environments[0]?.kind,
  ).toBe("team");
});

test("Toto Prostředí says the kind, whose it is and who works there in a person's words, and the assignment for support", () => {
  if (team === null) throw new Error("derived");
  const named = (login: string) => (login === "example" ? "Example" : null);
  const cs = messages("cs", "work");
  const en = messages("en", "work");
  const czech = environmentFacts(
    { preset: team, machine: servicesBinding, organization: named, team: null },
    cs,
  );
  expect(czech.facts).toEqual([
    ["Druh", "Pracovní Prostředí se službami serveru"],
    ["Patří", "Example"],
    ["Pracuje v něm", "Owneři a Admini Organizace"],
  ]);
  expect(czech.support).toContainEqual(["Přiřazení", "Služby serveru"]);
  expect(czech.support).toContainEqual(["Team", "server-services"]);
  const english = environmentFacts(
    { preset: team, machine: servicesBinding, organization: named, team: null },
    en,
  );
  expect(english.facts).toEqual([
    ["Kind", "Work Environment with the server's services"],
    ["Belongs to", "Example"],
    ["Who works in it", "Owners and Admins of the Organization"],
  ]);
  expect(english.support).toContainEqual(["Assignment", "Server services"]);
  // No technical word and no Team kind in what a person reads.
  for (const [, value] of [...czech.facts, ...english.facts]) {
    expect(value).not.toBe("services");
    expect(String(value)).not.toMatch(/kind|hosted-|Týmov|\bTeam\b/);
  }
  expect(assignmentText({ kind: "services" }, cs)).toBe("Služby serveru");
  expect(assignmentText({ kind: "services" }, en)).toBe("Server services");
  // Obecné's choice says the same kind for the Team preset they have; a
  // Team Environment's stays Týmové.
  expect(cs[presetLabel(team, servicesBinding)]).toBe(
    "Pracovní Prostředí se službami serveru",
  );
  expect(cs[presetLabel(team, bindings.assignedTeam)]).toBe("Týmové Prostředí");
  expect(en[presetLabel("hosted-organization-personal", servicesBinding)]).toBe(
    "Work Environment",
  );
});

test("the generated Folder tells agents who enters Služby serveru, that the Team's rules hold there and what people call it", () => {
  if (team === null) throw new Error("derived");
  const render = (machine: MachineBinding, locale: "cs" | "en") =>
    renderOutputs({
      preset: team,
      machine,
      profile: presetProfile(team, "linux", { locale }),
    });
  const czech = render(servicesBinding, "cs");
  const agents = czech["AGENTS.md"];
  expect(agents).toContain(
    "- Přiřazení: Služby serveru (root decision 0209). Vstupují sem jen Owneři a Admini Organizace",
  );
  expect(agents).toContain(
    "lidem je to ale Pracovní Prostředí jménem Služby serveru, nikdy Týmové.",
  );
  expect(agents).toContain(
    "- Operátor: Owner nebo Admin Organizace, který je právě připojený.",
  );
  expect(agents).not.toContain("- Operátor: člen Teamu");
  // A named person publishes, as from a Team Environment (root 0209 (c)).
  expect(agents).toContain("Komu mám říct, aby tyhle změny publikoval?");
  expect(agents).toContain("brokerovaná identita Organizace");
  const manual = czech["manual/this-machine.md"];
  expect(manual).toContain("Jde ale o Služby serveru (root decision 0209)");
  expect(manual).toContain(
    "Tenhle Environment (Služby serveru, root decision 0209) je v pracovní zóně Organizace `example`.",
  );
  expect(manual).not.toContain(
    "Příchozí spojení přijímá jen od členů živého GitHub Teamu, ke kterému je svázaný",
  );
  const english = render(servicesBinding, "en");
  expect(english["AGENTS.md"]).toContain(
    "- Assignment: Server services (root decision 0209).",
  );
  expect(english["AGENTS.md"]).toContain(
    "- Operator: whichever Owner or Admin of the Organization is connected now.",
  );
  expect(english["manual/this-machine.md"]).toContain(
    "This, though, is Server services (root decision 0209)",
  );
  // A Team Environment's Folder says none of it.
  const teamFolder = render(bindings.assignedTeam, "cs");
  expect(teamFolder["AGENTS.md"]).toContain("- Přiřazení: sdílený Teamem.");
  expect(teamFolder["AGENTS.md"]).toContain("- Operátor: člen Teamu");
  expect(teamFolder["AGENTS.md"]).not.toContain("Služby serveru");
  expect(teamFolder["manual/this-machine.md"]).not.toContain("Služby serveru");
});
