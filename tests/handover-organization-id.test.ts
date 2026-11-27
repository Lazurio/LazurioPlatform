import { expect, test } from "bun:test";
import {
  machineIdentity,
  ownerOrganizationCorrection,
} from "../src/folder/machine-binding";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import provenance from "../src/machine/schema-provenance.json";
import organization from "./fixtures/machine-context.json";
import { binding } from "./fixtures/machine-bindings";
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
    ownerOrganizationCorrection(work("example"), work("renamed", 7001), undefined),
  ).toBeNull();
});
