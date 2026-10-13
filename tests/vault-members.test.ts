import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultSetup } from "../src/vault/flow";
import {
  personAddress,
  vaultAudience,
  vaultMembership,
} from "../src/vault/members";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownAccount,
  startFakeVault,
  zipOf,
} from "./fixtures/fake-vault";

// The Správci core (DEV-6631 task 638b) where its HTTP consumer
// (tests/launchpad-vault-page.test.ts) cannot reach: only a lowercase UUID
// names a person, whoever passes anything else; a vault that is not set up
// is asked nothing.

const posix = process.platform !== "win32";

test.skipIf(!posix)(
  "only a lowercase UUID names a person; a vault that is not set up is asked nothing",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "vault-members-")),
    );
    const home = join(parent, "home");
    const vault = await startFakeVault(home);
    const zip = zipOf("bw", fakeBw);
    const pin = fakePin(zip);
    const host = fakeHost({
      home,
      vault,
      pin,
      download: fakeRelease(pin, zip).fetch,
    });
    try {
      // Not set up: not connected, and nothing is asked of the vault.
      expect(await vaultMembership(host, randomUUID())).toEqual({
        kind: "vault-member-unknown",
        reason: "not-connected",
      });
      expect(vault.requests).toHaveLength(0);
      vault.allow(ownAccount);
      expect((await vaultSetup(host)).state).toBe("connected");
      const subject = randomUUID();
      vault.person(personAddress(subject), true);
      vault.person(personAddress(subject.toUpperCase()), true);
      const asked = vault.requests.length;
      for (const named of [
        subject.toUpperCase(),
        `${subject} `,
        "example-login",
        `${subject}@vaultwarden-identity.lazurio.ai`,
        "",
      ])
        expect([named, await vaultMembership(host, named)]).toEqual([
          named,
          { kind: "vault-member-unknown", reason: "no-identity" },
        ]);
      expect(vault.requests).toHaveLength(asked);
      // A personal Environment has no audience to look at.
      expect(await vaultAudience(host)).toBe("unchanged");
      expect(await vaultMembership(host, subject)).toEqual({
        kind: "vault-member",
        state: "member",
      });
    } finally {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);
