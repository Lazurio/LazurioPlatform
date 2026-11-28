import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderAdoptionError } from "../src/folder/handover-layout";
import {
  type MachineBinding,
  machineIdentity,
  ownerOrganizationCorrection,
} from "../src/folder/machine-binding";
import {
  initializeMachineFolder,
  refreshMachineFolder,
} from "../src/machine/cli";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import provenance from "../src/machine/schema-provenance.json";
import { assignments, binding } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import { vendoredSchemaPullRequest } from "./fixtures/machine-schema-pin";

// Machines#1627: the handover names the Owner Organization by its immutable
// GitHub id beside its login, so a Work Environment follows a rename of its
// Organization on GitHub (#1281). Invented names and ids only.

const work = (login: string, id?: number) =>
  binding({
    ...organization,
    owner: {
      ...organization.owner,
      organization: login,
      ...(id === undefined ? {} : { organization_id: id }),
    },
  });

test("the vendored schema is Machines #1628's: an optional integer owner.organization_id", () => {
  expect(provenance.source_pull_request).toBe(vendoredSchemaPullRequest);
  const owner = (
    schema as unknown as {
      $defs: Record<
        string,
        { properties: { owner: { properties: Record<string, unknown> } } }
      >;
    }
  ).$defs.organization_workspace_vm?.properties.owner.properties;
  expect(owner?.organization_id).toEqual({
    type: "integer",
    minimum: 1,
    maximum: 9007199254740991,
  });
});

test("a handover with the Organization id binds it outside the identity, and one without it binds as before", () => {
  const identified = work("example", 7001);
  const plain = work("example");
  expect(identified?.owner).toMatchObject({
    kind: "organization",
    organization: "example",
    organizationId: 7001,
  });
  expect(plain?.owner).not.toHaveProperty("organizationId");
  expect(JSON.stringify(machineIdentity(identified))).toBe(
    JSON.stringify(machineIdentity(plain)),
  );
  // A non-integer or zero id is no handover.
  expect(() => work("example", 0)).toThrow();
  expect(() => work("example", 1.5)).toThrow();
});

test("a renamed Owner in the handover is the same Environment only by the same id", () => {
  const recorded = work("example", 7001);
  expect(
    ownerOrganizationCorrection(recorded, work("renamed", 7001), undefined),
  ).toBe("owner-renamed");
  expect(
    ownerOrganizationCorrection(recorded, work("renamed", 9009), undefined),
  ).toBeNull();
  expect(
    ownerOrganizationCorrection(
      work("example"),
      work("renamed", 7001),
      undefined,
    ),
  ).toBeNull();
});

// Through `machine folder-refresh` with the real handover, its
// `organization_key` present (review of #1282 and #1284).
const noChoices = {
  preset: undefined,
  locale: undefined,
  detail: undefined,
  coordination: undefined,
} as const;
const { team: _team, ...operatorOwner } = organization.owner;
const keyed = (login: string, key: string, id?: number) =>
  binding({
    ...organization,
    owner: {
      ...operatorOwner,
      assignment: assignments.operator,
      organization: login,
      organization_key: key,
      ...(id === undefined ? {} : { organization_id: id }),
    },
  });

async function folderOf(initial: MachineBinding) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "org-id-")));
  const folder = join(parent, "Lazurio");
  await mkdir(join(folder, "organizations"), { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  expect(
    await initializeMachineFolder(folder, initial, noChoices),
  ).toMatchObject({ code: 0, result: { kind: "initialized" } });
  return { parent, folder };
}

test.skipIf(process.platform === "win32")(
  "a refresh takes a new login only after the Folder recorded the same id, never by the key alone",
  async () => {
    const { parent, folder } = await folderOf(keyed("example", "Example"));
    try {
      // A handover with an id and a new login whose key matches it: no
      // recorded id proves it, so it is another Owner, and nothing changes.
      await expect(
        refreshMachineFolder(
          folder,
          keyed("renamed", "Renamed", 7001),
          undefined,
          "Renamed",
        ),
      ).rejects.toEqual(new FolderAdoptionError("binding-changed", ".lazurio"));
      // The id under the unchanged login: recorded, the same Machine.
      expect(
        await refreshMachineFolder(
          folder,
          keyed("example", "Example", 7001),
          undefined,
          "Example",
        ),
      ).toMatchObject({ code: 0, result: { kind: "refreshed" } });
      // Then the rename by the same id …
      expect(
        await refreshMachineFolder(
          folder,
          keyed("renamed", "Renamed", 7001),
          undefined,
          "Renamed",
        ),
      ).toMatchObject({
        code: 0,
        result: { kind: "refreshed", bindingCorrected: "owner-renamed" },
      });
      // … but never to another id or to none, whatever the key says.
      for (const live of [
        keyed("other", "Other", 9009),
        keyed("other", "Other"),
      ])
        await expect(
          refreshMachineFolder(folder, live, undefined, "Other"),
        ).rejects.toEqual(
          new FolderAdoptionError("binding-changed", ".lazurio"),
        );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
