import { expect, test } from "bun:test";
import { parseAccount } from "../src/launchpad/account";
import { cachedAccountFor, rememberAccount } from "../src/shell/account";
import {
  accountSharedApplicationsMax,
  isAccountApplicationOrigin,
  parseAccountSharedApplications,
  parseShellAccount,
} from "../src/shell/contract";
import { accountDocument } from "./fixtures/account-document";

// Decision 0231 and plan LZD-0009 M6: `lazurio.account.v1` gains the
// optional `sharedApplications`, exactly as Lazurio Auth's contract proposes
// it (`docs/application-roles.md`, Interfaces, `AccountSharedApplication`):
// the applications colleagues made available to the person from their Work
// Environments. Absent is none, at most 64, and an entry naming an
// Organization the document does not list or an origin that is not https
// makes the whole document invalid, as `buddy` does. Example names only.

// Bob shares his inspections application with Ada from his Work
// Environment of the example Organization; Ada is its Application User.
const inspections = {
  organization: "example",
  module: "inspections",
  name: "Inspections",
  url: "https://inspections.vm-02.example.lazurio.io",
  role: "user",
  host: { login: "bob", name: "Bob Example" },
};
const ledger = {
  organization: "other-example",
  module: "ledger",
  name: "Ledger",
  url: "https://ledger.vm-07.other-example.lazurio.io",
  role: "admin",
  host: { login: null },
};

const sharedOf = (value: unknown) =>
  parseShellAccount(accountDocument({ sharedApplications: value }));

test("valid: each entry in its exact shape, in the account's order, Organizations by their listed slug ignoring case", () => {
  const read = sharedOf([
    inspections,
    { ...ledger, organization: "Other-Example" },
  ]);
  expect(read?.sharedApplications).toEqual([
    {
      organization: "example",
      module: "inspections",
      name: "Inspections",
      url: "https://inspections.vm-02.example.lazurio.io",
      role: "user",
      host: { login: "bob", name: "Bob Example" },
    },
    {
      organization: "Other-Example",
      module: "ledger",
      name: "Ledger",
      url: "https://ledger.vm-07.other-example.lazurio.io",
      role: "admin",
      host: { login: null },
    },
  ]);
  // The rest of the document is read as without it.
  expect(read?.environments.map((entry) => entry.id)).toEqual(
    parseShellAccount(accountDocument())?.environments.map((entry) => entry.id),
  );
});

test("members an entry does not know are dropped; a host's name that is no name is left out, never the entry", () => {
  const read = sharedOf([
    {
      ...inspections,
      repository: "example/inspections",
      environment: "vm-02.example",
      host: { login: "bob", name: "", id: "u-1" },
    },
    {
      ...inspections,
      url: "https://inspections.vm-03.example.lazurio.io",
      host: { login: "bob", name: 7 },
    },
  ]);
  expect(read?.sharedApplications?.map((entry) => entry.host)).toEqual([
    { login: "bob" },
    { login: "bob" },
  ]);
  expect(
    read?.sharedApplications?.some(
      (entry) => "repository" in entry || "environment" in entry,
    ),
  ).toBe(false);
});

test("absent or null is none: the member is left out; an empty list is kept as nothing shared", () => {
  const absent = parseShellAccount(accountDocument());
  expect(absent).not.toBeNull();
  expect(absent && Object.hasOwn(absent, "sharedApplications")).toBe(false);
  const none = sharedOf(null);
  expect(none).not.toBeNull();
  expect(none && Object.hasOwn(none, "sharedApplications")).toBe(false);
  expect(sharedOf([])?.sharedApplications).toEqual([]);
});

test("an origin that is not exactly an https origin makes the whole document invalid", () => {
  for (const url of [
    "http://inspections.vm-02.example.lazurio.io",
    "https://inspections.vm-02.example.lazurio.io/",
    "https://inspections.vm-02.example.lazurio.io/app",
    "https://inspections.vm-02.example.lazurio.io?x=1",
    "https://inspections.vm-02.example.lazurio.io#top",
    "https://bob:secret@inspections.vm-02.example.lazurio.io",
    "https://inspections.vm-02.example.lazurio.io:443",
    "https://Inspections.vm-02.example.lazurio.io",
    "javascript:alert(1)",
    "inspections.vm-02.example.lazurio.io",
    "",
    42,
    null,
  ]) {
    expect(isAccountApplicationOrigin(url)).toBe(false);
    expect(sharedOf([{ ...inspections, url }])).toBeNull();
  }
  expect(isAccountApplicationOrigin(inspections.url)).toBe(true);
  // An https origin with its own port is still an origin.
  expect(
    sharedOf([
      {
        ...inspections,
        url: "https://inspections.vm-02.example.lazurio.io:8443",
      },
    ])?.sharedApplications?.[0]?.url,
  ).toBe("https://inspections.vm-02.example.lazurio.io:8443");
});

test("an entry naming an Organization the document does not list makes the whole document invalid", () => {
  for (const organization of ["unknown", "example-works", "", null, 7])
    expect(sharedOf([inspections, { ...ledger, organization }])).toBeNull();
});

test("at most 64: the 65th makes the whole document invalid", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...inspections,
      module: `inspections-${index}`,
      url: `https://inspections-${index}.vm-02.example.lazurio.io`,
    }));
  expect(accountSharedApplicationsMax).toBe(64);
  expect(sharedOf(many(64))?.sharedApplications).toHaveLength(64);
  expect(sharedOf(many(65))).toBeNull();
});

test("any other shape makes the whole document invalid", () => {
  for (const value of [
    "inspections",
    { inspections },
    [null],
    ["inspections"],
    [{ ...inspections, role: "owner" }],
    [{ ...inspections, role: "Admin" }],
    [{ ...inspections, role: undefined }],
    [{ ...inspections, module: "" }],
    [{ ...inspections, module: " inspections" }],
    [{ ...inspections, name: "" }],
    [{ ...inspections, name: "x".repeat(129) }],
    [{ ...inspections, name: undefined }],
    [{ ...inspections, host: undefined }],
    [{ ...inspections, host: "bob" }],
    [{ ...inspections, host: { name: "Bob Example" } }],
    [{ ...inspections, host: { login: "not a login" } }],
  ])
    expect(sharedOf(value)).toBeNull();
});

test("one reader for every consumer: the list by itself, against the Organizations a document lists", () => {
  const organizations = [{ slug: "example" }];
  expect(parseAccountSharedApplications(undefined, organizations)).toBe(
    undefined,
  );
  expect(parseAccountSharedApplications([inspections], organizations)).toEqual(
    sharedOf([inspections])?.sharedApplications,
  );
  expect(parseAccountSharedApplications([ledger], organizations)).toBe(false);
  expect(parseAccountSharedApplications([inspections], [])).toBe(false);
});

test("an Environment that keeps its operator's account keeps the shared applications with it", () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const read = sharedOf([inspections]);
  if (read === null) throw new Error("Expected a valid account document");
  rememberAccount(read, "ada", store);
  expect(cachedAccountFor("ada", store)?.sharedApplications).toEqual(
    read.sharedApplications,
  );
});

test("Apps reads the person and the shared applications only from a document valid as a whole", () => {
  const valid = parseAccount(
    accountDocument({ sharedApplications: [inspections] }),
  );
  expect(valid?.login).toBe("ada");
  expect(valid?.sharedApplications?.map((entry) => entry.name)).toEqual([
    "Inspections",
  ]);
  // Nothing shared is a known empty list.
  expect(parseAccount(accountDocument())?.sharedApplications).toEqual([]);
  // An invalid document still keeps its preferences and favourites, but
  // names nobody and shares nothing that is shown: unknown, never "none".
  const invalid = parseAccount(
    accountDocument({
      sharedApplications: [
        { ...inspections, url: "http://inspections.vm-02.example.lazurio.io" },
      ],
      preferences: { openApps: "same" },
    }),
  );
  expect(invalid?.openApps).toBe("same");
  expect(invalid?.login).toBeNull();
  expect(invalid?.sharedApplications).toBeNull();
  const partial = parseAccount({ schema: "lazurio.account.v1" });
  expect(partial?.login).toBeNull();
  expect(partial?.sharedApplications).toBeNull();
});
