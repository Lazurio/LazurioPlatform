import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { messages } from "../src/launchpad/messages";
import {
  addRefusal,
  keyGroups,
  keyView,
  missingTexts,
  parseComputer,
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

test("the laptop handoff carries the Environment recipe without inventing connection parameters", () => {
  for (const locale of ["en", "cs"] as const) {
    for (const organization of ["north", "south"]) {
      const alias = `lazurio.org.${organization}.alex-work`;
      const url = `https://launchpad.alex-work.${organization}.example/settings/ssh`;
      const desktopLink = `codex://settings/connections/ssh/add?${new URLSearchParams({ name: alias, projectPath: "/home/alex/Lazurio Folder", enabled: "true" })}`;
      const prompt = sshPrompt(
        { url, alias, keyPath: `~/.ssh/${alias}-ed25519`, desktopLink },
        messages(locale),
      );
      expect(prompt).toContain(url);
      expect(prompt).toContain(`](${desktopLink})`);
      expect(prompt).toContain("Settings → Connections → SSH");
      expect(prompt).toContain(
        locale === "cs" ? "Kliknutí nech na mně" : "Let me click it",
      );
      expect(prompt).toContain(
        locale === "cs"
          ? "kliknout ještě jednou"
          : "click the same link once again",
      );
      expect(prompt).toContain(
        locale === "cs" ? "zachovat SSH alias" : "keeping the SSH alias",
      );
      expect(prompt).toContain(`~/.ssh/${alias}-ed25519`);
      expect(prompt).toContain(`%USERPROFILE%\\.ssh\\${alias}-ed25519`);
      expect(prompt).toContain("Tailscale");
      expect(prompt).not.toMatch(/\{\w+\}/);
      expect(prompt).not.toContain(
        organization === "north" ? "lazurio.org.south" : "lazurio.org.north",
      );
    }
  }
});

test("the rendered Codex link must match this connection and Folder", () => {
  const base = {
    state: "ready" as const,
    alias: "lazurio.org.north.alex",
    keyPath: "~/.ssh/key",
    config: "Host lazurio.org.north.alex",
    knownHosts: "pin",
  };
  const codex = {
    projectPath: "/home/alex/Lazurio",
    url: "codex://settings/connections/ssh/add?name=lazurio.org.north.alex&projectPath=%2Fhome%2Falex%2FLazurio&enabled=true",
  };
  expect(parseComputer(base)).toEqual(base);
  expect(parseComputer({ ...base, codex })).not.toBeNull();
  for (const url of [
    "javascript:alert(1)",
    codex.url.replace("north", "south"),
    `${codex.url}&name=other`,
    codex.url.replace("Lazurio", "Other"),
  ]) {
    expect(parseComputer({ ...base, codex: { ...codex, url } })).toBeNull();
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
