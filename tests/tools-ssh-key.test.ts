import { expect, test } from "bun:test";
import {
  fingerprintOf,
  ghTokenScopes,
  knownHostEntries,
  machineName,
  publicKeyOf,
  publishedHostKeys,
  sshGreeting,
  sshKeyTitle,
} from "../src/tools/ssh-key";
import { githubHostKeys } from "./fixtures/fake-login-tools";

test("fingerprints are the SHA-256 ones GitHub publishes for its host keys", () => {
  // `ssh_key_fingerprints` of https://api.github.com/meta, read 2026-09-28.
  expect(githubHostKeys.map((key) => fingerprintOf(key))).toEqual([
    "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
    "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
  ]);
});

test("a public key line is only a known type and base64", () => {
  expect(publicKeyOf(`${githubHostKeys[0]} comment here\n`)).toBe(
    githubHostKeys[0],
  );
  for (const bad of [
    "",
    "ssh-ed25519",
    "ssh-dss AAAAB3NzaC1kc3M=",
    "ssh-ed25519 not/base64!",
    // The armor line of a private key, assembled so no such line is in Git.
    ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "),
  ])
    expect(publicKeyOf(bad)).toBeUndefined();
});

test("the token scopes of the active github.com account are read from gh auth status", () => {
  const output = [
    "github.com",
    "  ✓ Logged in to github.com account octocat (keyring)",
    "  - Active account: true",
    "  - Git operations protocol: ssh",
    "  - Token: gho_************************************",
    "  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'",
    "",
    "  ✓ Logged in to github.com account other (keyring)",
    "  - Active account: false",
    "  - Token scopes: 'repo'",
  ].join("\n");
  expect(ghTokenScopes(output)).toEqual([
    "admin:public_key",
    "gist",
    "read:org",
    "repo",
  ]);
  expect(
    ghTokenScopes(
      "  ✓ Logged in to github.com account a (keyring)\n  ✓ Logged in to github.com account b (keyring)\n  - Token scopes: 'admin:public_key'",
    ),
  ).toBeUndefined();
  expect(ghTokenScopes("You are not logged into any GitHub hosts.")).toBe(
    undefined,
  );
  expect(
    ghTokenScopes(
      "  ✓ Logged in to github.com account a (keyring)\n  - Token scopes: none",
    ),
  ).toEqual([]);
});

test("GitHub's published host keys are accepted only as a short list of key lines", () => {
  expect(publishedHostKeys(JSON.stringify(githubHostKeys))).toEqual(
    githubHostKeys,
  );
  for (const bad of [
    "",
    "{}",
    "[]",
    '["ssh-ed25519 AAAA with comment"]',
    "[1]",
    JSON.stringify(Array(17).fill(githubHostKeys[0])),
  ])
    expect(publishedHostKeys(bad)).toBeUndefined();
});

test("known_hosts entries: plain and hashed keys, markers flagged", () => {
  const [ed25519, ecdsa] = githubHostKeys as [string, string];
  expect(
    knownHostEntries(
      `# Host github.com found: line 1 \ngithub.com ${ed25519}\n# Host github.com found: line 4 \n|1|salt=|hash= ${ecdsa}\n`,
    ),
  ).toEqual({ keys: [ed25519, ecdsa], marked: false });
  expect(knownHostEntries(`@revoked github.com ${ed25519}\n`).marked).toBe(
    true,
  );
  expect(knownHostEntries("github.com garbage\n").marked).toBe(true);
  expect(knownHostEntries("")).toEqual({ keys: [], marked: false });
});

test("the SSH greeting names the login; anything else is no greeting", () => {
  expect(
    sshGreeting(
      "Hi octo-cat! You've successfully authenticated, but GitHub does not provide shell access.",
    ),
  ).toBe("octo-cat");
  expect(sshGreeting("git@github.com: Permission denied (publickey).")).toBe(
    undefined,
  );
  expect(
    sshGreeting("Warning: Hi evil! You've successfully authenticated"),
  ).toBeUndefined();
});

test("the key title names Lazurio and a harmless Machine name", () => {
  expect(machineName("Matejs-MacBook-Pro.local")).toBe("Matejs-MacBook-Pro");
  expect(machineName("vm 01;rm -rf")).toBe("vm-01-rm--rf");
  expect(machineName("..")).toBe("machine");
  expect(machineName("x".repeat(100))).toHaveLength(63);
  expect(sshKeyTitle("vm-01")).toBe("Lazurio: vm-01");
});
