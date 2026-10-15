import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultSetup } from "../src/vault/flow";
import {
  accountAddressDomain,
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

// The Správci core (DEV-6631 tasks 638b and 774) where its HTTP consumer
// (tests/launchpad-vault-page.test.ts) cannot reach: a person's address is
// their Lazurio username's (root decision 0203 point 5), and only a person
// named by a lowercase UUID with a username by the Lazurio rule has one,
// whoever passes anything else; a vault that is not set up is asked nothing.

const posix = process.platform !== "win32";

test("a person's address is their Lazurio username at account.lazurio.ai", () => {
  expect(accountAddressDomain).toBe("account.lazurio.ai");
  expect(personAddress("petr")).toBe("petr@account.lazurio.ai");
  expect(personAddress("petr-novak-2")).toBe("petr-novak-2@account.lazurio.ai");
});

test.skipIf(!posix)(
  "only a named person with a Lazurio username has an address; a vault that is not set up is asked nothing",
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
      const subject = randomUUID();
      const username = "petr";
      // Not set up: not connected, and nothing is asked of the vault.
      expect(await vaultMembership(host, { subject, username })).toEqual({
        kind: "vault-member-unknown",
        reason: "not-connected",
      });
      expect(vault.requests).toHaveLength(0);
      vault.allow(ownAccount);
      expect((await vaultSetup(host)).state).toBe("connected");
      // Accounts wait at every address a lax reading could build, so taking
      // any of them would show.
      const others = [
        "Petr",
        subject,
        subject.toUpperCase(),
        "service-account-x",
        "pe",
        "a".repeat(40),
      ];
      for (const address of [username, ...others])
        vault.person(personAddress(address), true);
      const asked = vault.requests.length;
      // A named person whose sign-in carried no valid username: no address,
      // nobody asked about.
      for (const carried of [null, "", `${username} `, ...others])
        expect([
          carried,
          await vaultMembership(host, { subject, username: carried }),
        ]).toEqual([
          carried,
          { kind: "vault-member-unknown", reason: "no-username" },
        ]);
      // Nobody named (no subject, or not a lowercase UUID): whatever the
      // username, nobody is.
      for (const named of [
        null,
        subject.toUpperCase(),
        `${subject} `,
        "example-login",
        "",
      ])
        expect([
          named,
          await vaultMembership(host, { subject: named, username }),
        ]).toEqual([
          named,
          { kind: "vault-member-unknown", reason: "no-identity" },
        ]);
      expect(vault.requests).toHaveLength(asked);
      // A personal Environment has no audience to look at.
      expect(await vaultAudience(host)).toBe("unchanged");
      expect(await vaultMembership(host, { subject, username })).toEqual({
        kind: "vault-member",
        state: "member",
      });
      // The one invitation named the username's address.
      const [own] = vault.organizationsOf(ownAccount);
      expect(
        vault
          .of(`/api/organizations/${own?.id}/users/invite`)
          .map(
            (invitation) => (invitation.body as { emails?: unknown }).emails,
          ),
      ).toEqual([["petr@account.lazurio.ai"]]);
    } finally {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);
