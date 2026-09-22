import { expect, test } from "bun:test";
import { minimumUpdaterVersion } from "../scripts/release-manifest";
import { isProductVersion } from "../src/update/identity";
import { compareVersions } from "../src/update/version";

// The minimum an installed client must have to apply a published release. Every
// release since the first one carries the same update protocol, so the value
// stays at the first release whose updater exists; a prerelease orders below
// its final version, and a minimum of "0.1.0" refused every rc client
// (docs/evidence/release-v0.1.0-2026-09-22.md).
test("the published minimum updater version admits every client released so far", () => {
  expect(isProductVersion(minimumUpdaterVersion)).toBe(true);
  for (const released of ["0.1.0-rc.1", "0.1.0-rc.2", "0.1.0"])
    expect(
      compareVersions(released, minimumUpdaterVersion),
    ).toBeGreaterThanOrEqual(0);
});
