import { expect, test } from "bun:test";
import { shellDocument } from "../src/launchpad/shell-document";
import type { CatalogOrganization } from "../src/organizations/catalog";
import {
  environmentIdOf,
  isEnvironmentId,
  parseShell,
} from "../src/shell/contract";
import {
  organizationWithEntry,
  personalWithEntry,
} from "./fixtures/machine-bindings";

// The identity of an Environment entry (F37's addendum of 2026-10-04): an
// Environment's id in `lazurio.shell.v1` is its base host in lowercase DNS
// form, so it is unique across Organizations: `<machine>.<org>` for a hosted
// Organization Environment (`<app>.<machine>.<org>.lazurio.io`), the personal
// DNS slug for a personal Remote Environment (`<app>.<slug>.lazurio.io`), and
// a workstation keeps its local id. The Dashboard derives the same value from
// the registry's Apps address.

test("a hosted Organization Environment: the machine and the Organization of its address", () => {
  expect(environmentIdOf("https://launchpad.vm-01.example.lazurio.io")).toBe(
    "vm-01.example",
  );
  // Any app of the Environment names the same one, with or without the
  // trailing slash of an Apps address.
  expect(environmentIdOf("https://t3code.vm-01.example.lazurio.io/")).toBe(
    "vm-01.example",
  );
  expect(environmentIdOf("https://mausbot.vm-01.example.lazurio.io")).toBe(
    "vm-01.example",
  );
});

test("a personal Remote Environment: its personal DNS slug", () => {
  expect(environmentIdOf("https://launchpad.example.lazurio.io")).toBe(
    "example",
  );
  expect(environmentIdOf("https://t3code.example-person.lazurio.io/")).toBe(
    "example-person",
  );
});

test("an Organization's login in capitals is the lowercase DNS form", () => {
  expect(
    environmentIdOf("https://launchpad.vm-01.Example-Org.lazurio.io"),
  ).toBe("vm-01.example-org");
  expect(environmentIdOf("HTTPS://LAUNCHPAD.VM-01.EXAMPLE.LAZURIO.IO/")).toBe(
    "vm-01.example",
  );
});

test("anything but an Environment's app origin under lazurio.io is no id", () => {
  for (const origin of [
    "",
    "not a url",
    "http://launchpad.vm-01.example.lazurio.io",
    "https://launchpad.vm-01.example.lazurio.io:8443",
    "https://user@launchpad.vm-01.example.lazurio.io",
    "https://launchpad.vm-01.example.lazurio.io/settings",
    "https://launchpad.vm-01.example.lazurio.io/?x=1",
    "https://launchpad.vm-01.example.lazurio.io/#x",
    "https://launchpad.vm-01.example.lazurio.io.evil.example",
    "https://launchpad.vm-01.example.example.com",
    "https://lazurio.io",
    "https://launchpad.lazurio.io",
    "https://a.b.c.d.lazurio.io",
    "https://launchpad.-vm.example.lazurio.io",
    "https://launchpad.vm_01.example.lazurio.io",
    `https://launchpad.${"a".repeat(64)}.example.lazurio.io`,
    "/",
    "//launchpad.vm-01.example.lazurio.io",
  ])
    expect(environmentIdOf(origin)).toBeNull();
});

test("the id's own rule: one or two lowercase DNS labels", () => {
  for (const id of ["local", "vm-01.example", "example", "a.b", "x1"])
    expect(isEnvironmentId(id)).toBe(true);
  for (const id of [
    "",
    "VM-01.example",
    "vm-01.example.lazurio",
    "vm-01.",
    ".example",
    "vm-",
    "-vm",
    "vm_01",
    "vm 01",
    "vm-01/example",
    "a".repeat(64),
    7,
    null,
  ])
    expect(isEnvironmentId(id)).toBe(false);
});

const organization = (slug: string): CatalogOrganization => ({
  directory: `${slug}_GEN3`,
  organization: slug,
  displayName: `${slug} Example`,
  forgeLogin: slug,
  state: "current",
  issues: [],
  executable: true,
  teams: [],
  modules: [],
  repositories: [],
});

test("the producer: a hosted Environment by its address, a workstation as before", () => {
  const work = shellDocument({
    preset: "hosted-organization-personal",
    machine: organizationWithEntry(20000, "vm-01.example.lazurio.io"),
    locale: "en",
    catalog: { kind: "catalog", organizations: [organization("example")] },
  });
  expect(work.current).toBe("vm-01.example");
  expect(work.environments.map((entry) => entry.id)).toEqual(["vm-01.example"]);
  const personal = shellDocument({
    preset: "hosted-personal",
    machine: personalWithEntry(),
    locale: "en",
    catalog: { kind: "catalog", organizations: [] },
  });
  expect(personal.current).toBe("example");
  const workstation = shellDocument({
    preset: "local",
    machine: null,
    locale: "en",
    catalog: { kind: "catalog", organizations: [organization("example")] },
  });
  expect(workstation.current).toBe("local");
});

const environment = (id: string, organization: string) => ({
  id,
  label: null,
  kind: "work",
  organizations: [organization],
  assignee: null,
  apps: {
    apps: `https://launchpad.${id}.lazurio.io/`,
    chat: null,
    automate: null,
  },
});
const document = (ids: readonly [string, string]) => ({
  schema: "lazurio.shell.v1",
  locale: "en",
  current: ids[0],
  operator: { initials: null, login: null, avatar: null },
  environments: [environment(ids[0], "alpha"), environment(ids[1], "beta")],
  organizations: ["alpha", "beta"].map((slug) => ({
    slug,
    name: `${slug} Example`,
    avatar: null,
    dashboard: `https://dashboard.lazurio.ai/orgs/${slug}`,
  })),
  dashboard: "https://dashboard.lazurio.ai/",
  account: "https://dashboard.lazurio.ai/settings",
  addOrganization: null,
});

test("two Organizations whose Environments share a machine name are two entries", () => {
  const shell = parseShell(document(["vm-01.alpha", "vm-01.beta"]));
  expect(shell?.environments.map((entry) => entry.id)).toEqual([
    "vm-01.alpha",
    "vm-01.beta",
  ]);
  // The bare machine name could not tell them apart.
  expect(parseShell(document(["vm-01", "vm-01"]))).toBeNull();
  // An id that is not in the DNS form is refused, `current` included.
  expect(parseShell(document(["vm-01.Alpha", "vm-01.beta"]))).toBeNull();
  expect(parseShell(document(["vm 01", "vm-01.beta"]))).toBeNull();
});
