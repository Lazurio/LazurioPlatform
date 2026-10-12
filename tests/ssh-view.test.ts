import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { messages } from "../src/launchpad/messages";
import {
  addRefusal,
  keyGroups,
  keyView,
  missingTexts,
  parseSshOverview,
  removeRefusal,
  sshPrompt,
} from "../src/launchpad/ssh-view";
import { inputRefusals } from "../src/ssh-access/access";

// Settings → SSH from your devices, the page's pure part (decision F49): the
// prompt the person gives their own agent names this Environment's page,
// the key and the very labels the page shows, in both languages; every
// refusal has its own sentence beside its field.

const page = await readFile(
  join(import.meta.dir, "..", "src", "launchpad", "index.html"),
  "utf8",
);

test("the prompt names this page, the key, the page's own labels and the rules", () => {
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    const prompt = sshPrompt(
      {
        url: "https://launchpad.alex-work.example-org.lazurio.io/settings/ssh",
        alias: "alex-work",
        keyPath: "~/.ssh/alex-work-ed25519",
      },
      copy,
    );
    expect(prompt).toContain(
      "https://launchpad.alex-work.example-org.lazurio.io/settings/ssh",
    );
    expect(prompt).toContain("~/.ssh/alex-work-ed25519.pub");
    expect(prompt).toContain("%USERPROFILE%\\.ssh\\alex-work-ed25519");
    expect(prompt).toContain(
      'ssh-keygen -t ed25519 -N "" -C alex-work -f ~/.ssh/alex-work-ed25519',
    );
    expect(prompt).toContain("~/.ssh/known_hosts_lazurio");
    expect(prompt).toContain("ssh alex-work true");
    expect(prompt).toContain("Host alex-work");
    expect(prompt).toContain("StrictHostKeyChecking");
    expect(prompt).toContain("Tailscale");
    expect(prompt).toContain("Admin");
    // The labels it sends the agent to are the ones on the page.
    for (const label of [
      copy.sshAddTitle,
      copy.sshAdd,
      copy.sshComputerTitle,
      copy.sshConfigLabel,
      copy.sshKnownHostsLabel,
    ])
      expect(prompt).toContain(label);
    expect(prompt).not.toMatch(/\{\w+\}/);
  }
});

test("the page gives an agent one stable element for each block it reads", () => {
  for (const [id, block] of [
    ["ssh-prompt", "prompt"],
    ["ssh-config", "config"],
    ["ssh-known-hosts", "known-hosts"],
  ] as const) {
    expect(page).toMatch(
      new RegExp(`<pre id="${id}" class="ssh-block" data-ssh-block="${block}"`),
    );
    expect(page).toContain(`data-copy="${id}"`);
  }
  for (const id of ["ssh-device", "ssh-key", "ssh-add-submit"])
    expect(page).toContain(`id="${id}"`);
});

test("every refusal has its sentence, beside the field it concerns", () => {
  for (const locale of ["en", "cs"] as const) {
    const copy = messages(locale);
    for (const reason of inputRefusals) {
      const refusal = addRefusal(reason, copy);
      expect(refusal.text).not.toBe(copy.sshAddFailed);
      expect(refusal.field).toBe(
        reason === "invalid-name"
          ? "device"
          : reason === "invalid-added-by"
            ? "form"
            : "publicKey",
      );
    }
    for (const reason of [
      "ssh-directory-unsafe",
      "authorized-keys-symlink",
      "authorized-keys-not-file",
      "authorized-keys-foreign-owner",
      "authorized-keys-too-large",
      "unsupported-platform",
    ]) {
      const refusal = addRefusal(reason, copy);
      expect(refusal.field).toBe("form");
      expect(refusal.text).not.toBe(copy.sshAddFailed);
    }
    expect(addRefusal("something-else", copy)).toEqual({
      field: "form",
      text: copy.sshAddFailed,
    });
    expect(removeRefusal("not-launchpad-key", copy)).toBe(copy.sshRemoveNotOwn);
    expect(removeRefusal("not-found", copy)).toBe(copy.sshRemoveNotFound);
    expect(removeRefusal(undefined, copy)).toBe(copy.sshRemoveFailed);
    const missing = [
      "tailscale-missing",
      "tailscale-failed",
      "tailnet-not-running",
      "no-dns-name",
      "host-key-missing",
      "user-invalid",
    ];
    expect(
      missingTexts(missing, copy).every((line) => !missing.includes(line)),
    ).toBe(true);
  }
});

test("a key the Launchpad added says who added it; one from outside cannot be removed", () => {
  const copy = messages("en");
  const own = {
    origin: "launchpad" as const,
    type: "ssh-ed25519" as const,
    fingerprint: "SHA256:o/4CeG0P+h9I7TE9MUuHkiJxKeDhAX4agiNUhz2gZsM",
    device: "alex-laptop",
    addedBy: "alex",
    added: "2026-10-12",
  };
  expect(keyView(own, copy)).toEqual({
    title: "alex-laptop",
    facts: [
      "Added 2026-10-12 by alex",
      "ssh-ed25519 · SHA256:o/4CeG0P+h9I7TE9MUuHkiJxKeDhAX4agiNUhz2gZsM",
    ],
    fingerprint: own.fingerprint,
    removable: true,
  });
  expect(keyView({ ...own, addedBy: "local" }, copy).facts[0]).toBe(
    "Added 2026-10-12 without a Lazurio account",
  );
  const outside = {
    origin: "outside" as const,
    type: "ssh-ed25519",
    fingerprint: own.fingerprint,
    comment: "ops@provisioning",
  };
  expect(keyView(outside, copy)).toMatchObject({
    title: "ops@provisioning",
    removable: false,
  });
  expect(
    keyView({ ...outside, type: null, fingerprint: null, comment: null }, copy),
  ).toEqual({
    title: copy.sshOutsideUnreadable,
    facts: [],
    fingerprint: null,
    removable: false,
  });
  expect(keyGroups([outside, own])).toEqual({
    devices: [own],
    outside: [outside],
  });
});

test("only an answer of the routes' shape is drawn", () => {
  const answer = {
    kind: "ssh-access",
    supported: true,
    keys: [],
    problem: null,
    computer: { state: "unavailable", missing: ["tailscale-missing"] },
  };
  expect(parseSshOverview(answer)).toEqual(answer as never);
  expect(parseSshOverview({ ...answer, kind: "other" })).toBeNull();
  expect(parseSshOverview({ ...answer, keys: [{ origin: "x" }] })).toBeNull();
  expect(parseSshOverview({ ...answer, computer: null })).toBeNull();
  expect(
    parseSshOverview({
      ...answer,
      keys: null,
      problem: "authorized-keys-symlink",
    }),
  ).toMatchObject({ keys: null, problem: "authorized-keys-symlink" });
});
