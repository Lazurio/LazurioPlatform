import { expect, test } from "bun:test";
import {
  assignmentText,
  environmentFacts,
  type MachineView,
} from "../src/launchpad/machine-view";
import { messages } from "../src/launchpad/messages";

// The Launchpad's "This Environment" shows the recorded assignment as the
// Folder renders it (src/folder/render.ts assignmentLine): the Automated
// Environment of decision 0169 reads distinctly, naming its responsible
// operator, never as a plain operator assignment.
test.each([
  [
    "en",
    { kind: "operator", githubLogin: "example", githubId: 12345 },
    "example (GitHub id 12345)",
  ],
  ["en", { kind: "team" }, "shared by the Team"],
  [
    "en",
    { kind: "automation", githubLogin: "example", githubId: 12345 },
    "an automated Environment of an Organization persona; responsible operator example (GitHub id 12345)",
  ],
  [
    "cs",
    { kind: "operator", githubLogin: "example", githubId: 12345 },
    "example (GitHub id 12345)",
  ],
  ["cs", { kind: "team" }, "sdílený Teamem"],
  [
    "cs",
    { kind: "automation", githubLogin: "example", githubId: 12345 },
    "automatizovaný Environment persony Organizace; odpovědný operátor example (GitHub id 12345)",
  ],
] as const)(
  "the %s assignment line of %o reads %p",
  (locale, assignment, text) => {
    expect(assignmentText(assignment, messages(locale))).toBe(text);
  },
);

// Settings → Tento Environment (root decision 0188, the wireframe's
// `ThisEnvironment`): the kind, whom it belongs to and who works in it in a
// person's words; the technical facts folded under "Pro podporu".
const cs = messages("cs");
const en = messages("en");
const host = { kind: "virtualization-host", id: "example-host" } as const;
const personal: MachineView = {
  kind: "personal-vm",
  name: "example",
  owner: { kind: "principal", githubLogin: "octocat", githubId: 12345 },
  network: { headscaleHostname: "example" },
  host,
};
const work = (
  owner: Extract<MachineView["owner"], { kind: "organization" }>,
): MachineView => ({
  kind: "workspace-vm",
  name: "vm-01",
  owner,
  network: { headscaleHostname: "example-vm-01" },
  host,
});
const named = (login: string) => (login === "example-org" ? "Example" : null);

test("a personal Remote Environment: yours, only you work in it", () => {
  const { facts, support } = environmentFacts(
    {
      preset: "hosted-personal",
      machine: personal,
      organization: named,
      team: null,
    },
    cs,
  );
  expect(facts).toEqual([
    ["Druh", "Osobní Remote Environment"],
    ["Patří", "tobě (@octocat)"],
    ["Pracuje v něm", "jen ty"],
  ]);
  expect(support).toEqual([
    ["Technický název", "example"],
    ["Technický druh", "personal-vm"],
    ["Owner", "octocat (GitHub id 12345)"],
    ["Uzel tailnetu", "example"],
    ["Host", "virtualization-host example-host"],
  ]);
  expect(
    environmentFacts(
      {
        preset: "hosted-personal",
        machine: personal,
        organization: named,
        team: null,
      },
      en,
    ).facts,
  ).toEqual([
    ["Kind", "Personal Remote Environment"],
    ["Belongs to", "you (@octocat)"],
    ["Who works in it", "only you"],
  ]);
});

test("an Organization's Environments: its name, then the assignee, the Team or the automation", () => {
  const facts = (
    preset: string,
    machine: MachineView,
    team: string | null = null,
  ) =>
    environmentFacts({ preset, machine, organization: named, team }, cs).facts;
  expect(
    facts(
      "hosted-organization-personal",
      work({
        kind: "organization",
        organization: "example-org",
        team: null,
        assignment: { kind: "operator", githubLogin: "octocat", githubId: 1 },
      }),
    ),
  ).toEqual([
    ["Druh", "Pracovní Remote Environment"],
    ["Patří", "Example"],
    ["Pracuje v něm", "@octocat"],
  ]);
  expect(
    facts(
      "hosted-organization-team",
      work({
        kind: "organization",
        organization: "example-org",
        team: "sales",
      }),
      "Team Sales",
    ),
  ).toEqual([
    ["Druh", "Týmový Remote Environment"],
    ["Patří", "Example"],
    ["Pracuje v něm", "Team Sales"],
  ]);
  // Without the shell document's name, the recorded Team.
  expect(
    facts(
      "hosted-organization-team",
      work({ kind: "organization", organization: "other", team: "sales" }),
    ),
  ).toEqual([
    ["Druh", "Týmový Remote Environment"],
    ["Patří", "other"],
    ["Pracuje v něm", "Team sales"],
  ]);
  expect(
    facts(
      "hosted-organization-steward",
      work({
        kind: "organization",
        organization: "example-org",
        team: "steward",
        assignment: { kind: "automation", githubLogin: "octocat", githubId: 1 },
      }),
    ),
  ).toEqual([
    ["Druh", "Automatizovaný Environment"],
    ["Patří", "Example"],
    ["Pracuje v něm", "automatizace, odpovídá @octocat"],
  ]);
  // Nobody recorded: the row is left out rather than guessed.
  expect(
    facts(
      "hosted-organization-personal",
      work({ kind: "organization", organization: "example-org", team: null }),
    ),
  ).toEqual([
    ["Druh", "Pracovní Remote Environment"],
    ["Patří", "Example"],
  ]);
});

test("the technical facts are only under Pro podporu, a workstation says it is your computer", () => {
  const { facts, support } = environmentFacts(
    {
      preset: "hosted-organization-personal",
      machine: {
        ...work({
          kind: "organization",
          organization: "example-org",
          team: null,
          assignment: { kind: "operator", githubLogin: "octocat", githubId: 1 },
        }),
        relationships: { zone: "work", peers: [] },
      },
      organization: named,
      team: null,
    },
    cs,
  );
  const visible = facts.map(([, value]) => String(value)).join(" ");
  for (const technical of [
    "workspace-vm",
    "vm-01",
    "example-vm-01",
    "example-host",
    "GitHub id",
  ])
    expect(visible).not.toContain(technical);
  expect(support.map(([label]) => label)).toEqual([
    "Technický název",
    "Technický druh",
    "Owner",
    "Přiřazení",
    "Uzel tailnetu",
    "Host",
    "Vztahy (vynucuje Headscale, ne tahle stránka)",
  ]);
  expect(
    environmentFacts(
      { preset: "local", machine: null, organization: named, team: null },
      cs,
    ),
  ).toEqual({ facts: [["Druh", "Tvůj počítač"]], support: [] });
  expect(cs.machineSupport).toBe("Pro podporu");
  expect(en.machineSupport).toBe("For support");
});
