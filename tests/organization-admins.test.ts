import { expect, test } from "bun:test";
import { parseCanonicalOrganization } from "../src/organizations/canonical-manifest";
import { organizationAdmins } from "../src/organizations/organization-admins";
import {
  acceptedOrganizationAdmins,
  organizationAdminsRefusals,
  verifiedManifest,
} from "./fixtures/organization-manifests";

// The appointed Organization Admins of `lazurio.organization.json` (decision
// 0245, amended 2026-11-18): the canonical reader keeps the field as
// authored, `organizationAdmins` alone judges it, and a malformed list
// appoints no one without making the manifest unusable.

const withAdmins = (admins: unknown) => {
  const manifest = verifiedManifest();
  manifest.organization_admins = admins;
  return manifest;
};

test("an absent field appoints no one", () => {
  expect(
    organizationAdmins(parseCanonicalOrganization(verifiedManifest())),
  ).toEqual({
    status: "absent",
    admins: [],
  });
});

test("a declared list gives each Admin's GitHub id and login, in order", () => {
  for (const [name, admins, ids] of acceptedOrganizationAdmins) {
    const verdict = organizationAdmins(
      parseCanonicalOrganization(withAdmins(admins)),
    );
    expect([name, verdict.status]).toEqual([name, "declared"]);
    expect(verdict.admins?.map((admin) => admin.githubId)).toEqual([...ids]);
  }
  expect(
    organizationAdmins(
      parseCanonicalOrganization(
        withAdmins([{ github_id: "101", github_login: "example-admin" }]),
      ),
    ).admins,
  ).toEqual([{ githubId: 101, githubLogin: "example-admin" }]);
});

test("a malformed list is invalid with the reason, and the manifest stays usable", () => {
  for (const [name, admins, detail] of organizationAdminsRefusals) {
    const manifest = parseCanonicalOrganization(withAdmins(admins));
    const verdict = organizationAdmins(manifest);
    expect([name, verdict.status]).toEqual([name, "invalid"]);
    expect(verdict.status === "invalid" && verdict.detail, name).toContain(
      detail,
    );
    expect(verdict.admins).toBeNull();
  }
});
