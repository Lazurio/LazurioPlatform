import { afterEach, expect, test } from "bun:test";
import { processContentGit } from "../src/content/git";
import type { ContentHost } from "../src/content/host";
import { contentStatus, organizationsOf } from "../src/content/status";
import type { MachineBinding } from "../src/folder/machine-binding";
import { composioOrganizationRule } from "../src/integrations/composio-organization";
import type {
  Catalog,
  CatalogOrganization,
} from "../src/organizations/catalog";
import { selectOwnerOrganization } from "../src/organizations/catalog-selection";
import { runTool } from "../src/tools/status";
import {
  createWorld,
  presetFolder,
  stubGitHub,
  type World,
} from "./fixtures/content-world";
import { bindings } from "./fixtures/machine-bindings";

// #1287: after a rename on GitHub the root and the handover may name the
// Organization by different logins for a while. Content status, Organization
// settings, Composio and Organization tools select the handover's
// Organization by its id then, as the content sync does (#1281). Synthetic
// names and ids only.

const id = 7001;
const entry = (
  login: string,
  organizationId: number | undefined,
  directory = "example_GEN3",
): CatalogOrganization =>
  ({
    directory,
    organization: "example",
    displayName: "Example",
    forgeLogin: login,
    ...(organizationId === undefined
      ? {}
      : { forgeOrganizationId: organizationId }),
    state: "current",
    issues: [],
    executable: true,
  }) as unknown as CatalogOrganization;
const catalog = (...organizations: CatalogOrganization[]): Catalog =>
  ({ kind: "catalog", organizations }) as unknown as Catalog;

test("the owner is selected by the handover's id under another login, never against another id", () => {
  // The root still names the earlier login, the handover the new one.
  const renamed = catalog(entry("Old", id));
  expect(selectOwnerOrganization(renamed, "new").kind).toBe("missing");
  expect(selectOwnerOrganization(renamed, "new", id)).toMatchObject({
    kind: "found",
    organization: { forgeLogin: "Old" },
  });
  // The same login with another id is another Organization.
  expect(
    selectOwnerOrganization(catalog(entry("New", 9009)), "new", id).kind,
  ).toBe("missing");
  // A root without an id keeps the login rule.
  expect(
    selectOwnerOrganization(catalog(entry("New", undefined)), "new", id).kind,
  ).toBe("found");
  // Two roots of the id: never guessed.
  expect(
    selectOwnerOrganization(
      catalog(entry("Old", id, "a_GEN3"), entry("Other", id, "b_GEN3")),
      "new",
      id,
    ).kind,
  ).toBe("ambiguous");
  // A root of the handover's id wins over one of its login without an id.
  expect(
    selectOwnerOrganization(
      catalog(entry("Old", undefined, "a_GEN3"), entry("New", id, "b_GEN3")),
      "old",
      id,
    ),
  ).toMatchObject({ kind: "found", organization: { forgeLogin: "New" } });
  expect(organizationsOf([entry("Old", id)], "new", id)).toHaveLength(1);
  expect(organizationsOf([entry("Old", id)], "new")).toHaveLength(0);
});

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

function machine(login: string, organizationId?: number): MachineBinding {
  const base = bindings.organization;
  if (base?.owner.kind !== "organization") throw new Error("fixture");
  return Object.freeze({
    ...base,
    owner: Object.freeze({
      ...base.owner,
      organization: login,
      ...(organizationId === undefined ? {} : { organizationId }),
    }),
  });
}

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a Work Environment's content status keeps its renamed Organization present by its id",
  async () => {
    world = await createWorld();
    const current = world;
    const host = (organizations: CatalogOrganization[]): ContentHost =>
      ({
        github: stubGitHub(current).github,
        git: processContentGit({
          path: Bun.env.PATH,
          home: current.home,
          platform: process.platform,
          run: runTool,
          env: current.gitEnv,
        }),
        lockDirectory: current.lockDirectory,
        readCatalog: async () => catalog(...organizations),
      }) as unknown as ContentHost;
    const withId = await presetFolder(
      current,
      "hosted-organization-personal",
      machine("new", id),
    );
    expect(
      (await contentStatus(withId, host([entry("Old", id)]))).items,
    ).toMatchObject([
      { kind: "organization", login: "new", name: "Example", state: "present" },
    ]);
    expect(
      (await contentStatus(withId, host([entry("Old", 9009)]))).items,
    ).toMatchObject([{ kind: "organization", login: "new", state: "absent" }]);
    // The root of the id, not the one of the login without an id.
    expect(
      (
        await contentStatus(
          withId,
          host([
            entry("New", undefined, "a_GEN3"),
            { ...entry("Old", id, "b_GEN3"), displayName: "By id" },
          ]),
        )
      ).items,
    ).toMatchObject([
      { kind: "organization", login: "new", name: "By id", state: "present" },
    ]);
    // Without the id in the handover: as before, by login.
    const withoutId = await presetFolder(
      current,
      "hosted-organization-personal",
      machine("new"),
    );
    expect(
      (await contentStatus(withoutId, host([entry("Old", id)]))).items,
    ).toMatchObject([{ kind: "organization", login: "new", state: "absent" }]);
  },
  60_000,
);

test("Composio's organization rule names the Organization of the handover's id, not one of its login without an id", async () => {
  const rule = await composioOrganizationRule(
    "/nonexistent-folder",
    machine("old", id),
    {
      readCatalog: async () =>
        catalog(
          { ...entry("Old", undefined, "a_GEN3"), displayName: "By login" },
          { ...entry("New", id, "b_GEN3"), displayName: "By id" },
        ),
      wait: async () => {},
    },
  );
  expect(rule).toEqual({ kind: "named", name: "By id" });
  // Another id only: no owner, and never the login's root of another id.
  const other = await composioOrganizationRule(
    "/nonexistent-folder",
    machine("old", id),
    {
      readCatalog: async () =>
        catalog({ ...entry("Old", 9009), displayName: "Other" }),
      wait: async () => {},
    },
  );
  expect(other).toMatchObject({ kind: "unverified", reason: "absent" });
});
