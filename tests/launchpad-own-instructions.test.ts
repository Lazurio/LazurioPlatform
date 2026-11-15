import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import {
  maxOwnInstructionsBytes,
  ownInstructionsSection,
  sectionBytes,
} from "../src/folder/own-instructions";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import { refreshFolder } from "../src/folder/update-profile";
import { maxVoiceBytes } from "../src/folder/voice";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import { bindings, organizationWithEntry } from "./fixtures/machine-bindings";
import { freePort } from "./fixtures/ports";

// Settings → Komunikace agentů → „Vlastní pokyny pro agenty“ over HTTP (root
// decision 0233, decision F14's addendum of 2026-11-06): `POST /api/profile`
// says whether this Environment has own instructions, whose they are and the
// saved text, and `POST /api/own-instructions/update` saves or removes them
// through the one operation that changes the text and nothing else. What the
// page draws of it is in launchpad-own-instructions-view.test.ts.

const bytes = (text: string) => Buffer.byteLength(text);
const posixTest = test.skipIf(process.platform === "win32");

type Call = (path: string, body: unknown) => Promise<Response>;
const profileOf = async (call: Call) =>
  (await (await call("/api/profile", {})).json()) as {
    revision: number;
    profile: Record<string, string>;
    ownInstructions: unknown;
    [name: string]: unknown;
  };

/** A Launchpad on a new Folder of the person's own computer. */
async function localSession() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-own-instructions-")),
  );
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  return session(parent, folder);
}

/** A Launchpad on a hosted Folder as folder-init adopts it, without an
 * entry: it answers this process with its token. */
async function hostedSession(
  preset: PresetName,
  machine: (typeof bindings)[keyof typeof bindings],
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-own-instructions-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  return session(parent, folder);
}

async function session(parent: string, folder: string) {
  const app = await startLaunchpad(folder);
  const url = new URL(app.url);
  const call: Call = (path, body) =>
    fetch(new URL(path, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
      },
      body: JSON.stringify(body),
    });
  return {
    folder,
    call,
    agents: () => readFile(join(folder, "AGENTS.md"), "utf8"),
    preferences: async () =>
      JSON.parse(
        await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
      ) as Record<string, unknown>,
    async close() {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const none = {
  allowed: true,
  ofOrganization: false,
  text: "",
  bytes: 0,
  maxBytes: maxOwnInstructionsBytes,
};

test("on the person's own computer the profile carries the own instructions, a save renders them and a removal takes the section away, and nothing else of the Folder changes", async () => {
  const app = await localSession();
  try {
    const first = await profileOf(app.call);
    expect(first.ownInstructions).toEqual(none);
    const before = await app.preferences();
    const text = "Odpovídej stručně.\nŘíkej mi Matěji; začni výsledkem. 🙂";
    const saved = await app.call("/api/own-instructions/update", {
      expectedRevision: first.revision,
      text,
    });
    expect([saved.status, await saved.json()]).toEqual([
      200,
      { kind: "updated", revision: first.revision + 1 },
    ]);
    const agents = await app.agents();
    expect(agents).toContain("## Vlastní pokyny uživatele");
    expect(agents).toContain(text);
    const second = await profileOf(app.call);
    expect(second.ownInstructions).toEqual({
      ...none,
      text,
      // UTF-8 bytes, not characters.
      bytes: bytes(text),
    });
    expect(bytes(text)).toBeGreaterThan(text.length);
    // The profile, the preset, the voice and the tools are what they were.
    const { revision: _first, ownInstructions: _none, ...restBefore } = first;
    const { revision: _second, ownInstructions: _text, ...restAfter } = second;
    expect(restAfter).toEqual(restBefore);
    expect(await app.preferences()).toEqual({
      ...before,
      revision: first.revision + 1,
      customInstructions: text,
    });
    // The same text again is unchanged.
    const again = await app.call("/api/own-instructions/update", {
      expectedRevision: second.revision,
      text,
    });
    expect([again.status, await again.json()]).toEqual([
      200,
      { kind: "unchanged" },
    ]);
    // Removed: null, the one representation of "none".
    const removed = await app.call("/api/own-instructions/update", {
      expectedRevision: second.revision,
      text: null,
    });
    expect([removed.status, await removed.json()]).toEqual([
      200,
      { kind: "updated", revision: second.revision + 1 },
    ]);
    expect(await app.agents()).not.toContain("## Vlastní pokyny uživatele");
    expect((await profileOf(app.call)).ownInstructions).toEqual(none);
    expect(await app.preferences()).toEqual({
      ...before,
      revision: second.revision + 1,
    });
  } finally {
    await app.close();
  }
}, 30_000);

test("a text over the bound, one that is not plain text, an empty one and a request with another key are refused before anything is written, and an old revision is stale", async () => {
  const app = await localSession();
  try {
    const { revision, profile } = await profileOf(app.call);
    const before = await app.agents();
    const refused = async (text: unknown) => {
      const answer = await app.call("/api/own-instructions/update", {
        expectedRevision: revision,
        text,
      });
      return [answer.status, await answer.json()];
    };
    const invalid = (problem: string) => [
      400,
      {
        error: "invalid-own-instructions",
        problem,
        maxBytes: maxOwnInstructionsBytes,
      },
    ];
    // 2,049 Czech letters are 4,098 bytes: the bound counts bytes.
    expect(await refused("ě".repeat(2049))).toEqual(invalid("too-long"));
    expect(await refused("x".repeat(4097))).toEqual(invalid("too-long"));
    expect(await refused("Piš\u001b[31m věcně")).toEqual(
      invalid("not-plain-text"),
    );
    expect(await refused("  \n ")).toEqual(invalid("blank"));
    // Null removes; an empty text is not a second way to say it.
    expect(await refused("")).toEqual(invalid("blank"));
    expect(await refused(7)).toEqual(invalid("not-text"));
    for (const body of [
      { expectedRevision: revision },
      { expectedRevision: revision, text: "Piš věcně.", preset: "local" },
      { expectedRevision: revision, text: "Piš věcně.", profile },
      { expectedRevision: "1", text: "Piš věcně." },
    ])
      expect(
        (await app.call("/api/own-instructions/update", body)).status,
      ).toBe(400);
    // The profile request still refuses the key: the field saves only
    // through its own route.
    for (const path of ["/api/preview", "/api/update"])
      expect(
        (
          await app.call(path, {
            expectedRevision: revision,
            profile,
            ownInstructions: { text: "Piš věcně." },
          })
        ).status,
      ).toBe(400);
    expect(await app.agents()).toBe(before);
    expect((await profileOf(app.call)).revision).toBe(revision);
    // The longest text there is fits.
    const longest = "ě".repeat(2048);
    expect(
      (
        await app.call("/api/own-instructions/update", {
          expectedRevision: revision,
          text: longest,
        })
      ).status,
    ).toBe(200);
    // Another tab still holds the old revision.
    const stale = await app.call("/api/own-instructions/update", {
      expectedRevision: revision,
      text: "Piš věcně.",
    });
    expect([stale.status, await stale.json()]).toEqual([
      409,
      { kind: "blocked", reason: "stale-revision" },
    ]);
    expect((await profileOf(app.call)).ownInstructions).toMatchObject({
      text: longest,
      bytes: maxOwnInstructionsBytes,
    });
  } finally {
    await app.close();
  }
}, 30_000);

test("the custom voice and the own instructions share one budget: whichever is saved second is refused with the three sizes", async () => {
  const app = await localSession();
  try {
    const first = await profileOf(app.call);
    const voice = "v".repeat(6000);
    expect(
      (
        await app.call("/api/update", {
          expectedRevision: first.revision,
          profile: first.profile,
          voice: { locale: "cs", text: voice },
        })
      ).status,
    ).toBe(200);
    const withVoice = await profileOf(app.call);
    const text = "x".repeat(3000);
    const section = sectionBytes(
      ownInstructionsSection("cs", "local", null, text),
    );
    const refused = await app.call("/api/own-instructions/update", {
      expectedRevision: withVoice.revision,
      text,
    });
    expect([refused.status, await refused.json()]).toEqual([
      409,
      {
        kind: "blocked",
        reason: "person-text-too-large",
        voiceBytes: 6000,
        instructionsBytes: section,
        maxBytes: maxVoiceBytes,
      },
    ]);
    expect(6000 + section).toBeGreaterThan(maxVoiceBytes);
    expect(await app.agents()).not.toContain("## Vlastní pokyny uživatele");
    // The other order: a short text is saved, then a voice too long next
    // to it, which the voice form now says with the same sizes.
    const short = "Piš věcně.";
    expect(
      (
        await app.call("/api/own-instructions/update", {
          expectedRevision: withVoice.revision,
          text: short,
        })
      ).status,
    ).toBe(200);
    const withBoth = await profileOf(app.call);
    const longVoice = "v".repeat(maxVoiceBytes);
    const voiceRefused = await app.call("/api/update", {
      expectedRevision: withBoth.revision,
      profile: withBoth.profile,
      voice: { locale: "cs", text: longVoice },
    });
    expect([voiceRefused.status, await voiceRefused.json()]).toEqual([
      409,
      {
        kind: "blocked",
        reason: "person-text-too-large",
        voiceBytes: maxVoiceBytes,
        instructionsBytes: sectionBytes(
          ownInstructionsSection("cs", "local", null, short),
        ),
        maxBytes: maxVoiceBytes,
      },
    ]);
    expect((await profileOf(app.call)).revision).toBe(withBoth.revision);
  } finally {
    await app.close();
  }
}, 30_000);

posixTest(
  "a Work Environment's instructions are the Organization's: the profile says so before anything is saved, and the saved section says it to agents",
  async () => {
    const app = await hostedSession(
      "hosted-organization-personal",
      bindings.organization,
    );
    try {
      const first = await profileOf(app.call);
      expect(first.ownInstructions).toEqual({ ...none, ofOrganization: true });
      const text = "Odpovídej stručně.";
      expect(
        (
          await app.call("/api/own-instructions/update", {
            expectedRevision: first.revision,
            text,
          })
        ).status,
      ).toBe(200);
      const agents = await app.agents();
      expect(agents).toContain(text);
      expect(agents).toContain(
        "Patří Organizaci spolu s Prostředím a její Admini je smí číst.",
      );
      expect((await profileOf(app.call)).ownInstructions).toEqual({
        ...none,
        ofOrganization: true,
        text,
        bytes: bytes(text),
      });
      // A Personal Environment's are the person's.
      const personal = await hostedSession(
        "hosted-personal",
        bindings.personal,
      );
      try {
        expect((await profileOf(personal.call)).ownInstructions).toEqual(none);
      } finally {
        await personal.close();
      }
    } finally {
      await app.close();
    }
  },
  30_000,
);

for (const [name, preset, machine] of [
  ["a Team Environment", "hosted-organization-team", bindings.assignedTeam],
  [
    "an Environment with automations",
    "hosted-organization-steward",
    bindings.automated,
  ],
] as const)
  posixTest(
    `${name} has no own instructions: the profile says so and a save is refused`,
    async () => {
      const app = await hostedSession(preset, machine);
      try {
        const first = await profileOf(app.call);
        expect(first.ownInstructions).toEqual({
          ...none,
          allowed: false,
          ofOrganization: false,
        });
        const before = await app.agents();
        const refused = await app.call("/api/own-instructions/update", {
          expectedRevision: first.revision,
          text: "Odpovídej stručně.",
        });
        expect([refused.status, await refused.json()]).toEqual([
          409,
          { kind: "blocked", reason: "own-instructions-unavailable" },
        ]);
        expect(await app.agents()).toBe(before);
        expect((await profileOf(app.call)).revision).toBe(first.revision);
      } finally {
        await app.close();
      }
    },
    30_000,
  );

posixTest(
  "a public Environment has no own instructions: the profile sends no text, even one its Folder records, and the save route is absent",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-own-instructions-")),
    );
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    const host = "workspace.example.lazurio.io";
    const port = freePort();
    // The same Environment before it was public: its person saved a text.
    await initializeHandoverFolder(folder, {
      preset,
      machine: organizationWithEntry(port, host),
      profile: presetProfile(preset, executionOs(process.platform), {
        locale: "cs",
      }),
    });
    const fetcher: AuthFetcher = async (_url, init) =>
      new Headers(init.headers).get("cookie") ===
      "__Secure-lazurio-workspace=valid"
        ? new Response("ok")
        : new Response("no", { status: 401 });
    const start = () =>
      startLaunchpad(folder, undefined, undefined, undefined, { fetcher });
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: {
          host: `launchpad.${host}`,
          cookie: "__Secure-lazurio-workspace=valid",
          origin: `https://launchpad.${host}`,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const secret = "Říkej mi Matěji.";
    try {
      const work = await start();
      try {
        const first = await (await post("/api/profile", {})).json();
        expect(first.ownInstructions).toEqual({
          ...none,
          ofOrganization: true,
        });
        expect(
          (
            await post("/api/own-instructions/update", {
              expectedRevision: first.revision,
              text: secret,
            })
          ).status,
        ).toBe(200);
      } finally {
        await work.close();
      }
      // The handover now says the gateway admits anyone: the Try overlay.
      expect(
        (
          await refreshFolder(
            folder,
            organizationWithEntry(port, host, false, false, true),
          )
        ).kind,
      ).toBe("refreshed");
      const open = await start();
      try {
        const answer = await post("/api/profile", {});
        const shown = await answer.json();
        expect(shown.machine.entry.audience).toBe("public");
        expect(shown.ownInstructions).toEqual({
          allowed: false,
          ofOrganization: true,
          text: "",
          bytes: 0,
          maxBytes: maxOwnInstructionsBytes,
        });
        // The Folder keeps the text and renders none; no visitor reads it.
        expect(JSON.stringify(shown)).not.toContain(secret);
        expect(
          await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
        ).toContain(secret);
        expect(await readFile(join(folder, "AGENTS.md"), "utf8")).not.toContain(
          secret,
        );
        for (const text of ["Odpovídej stručně.", null]) {
          const refused = await post("/api/own-instructions/update", {
            expectedRevision: shown.revision,
            text,
          });
          expect([refused.status, await refused.json()]).toEqual([
            404,
            { error: "not-found" },
          ]);
        }
        expect((await (await post("/api/profile", {})).json()).revision).toBe(
          shown.revision,
        );
      } finally {
        await open.close();
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  60_000,
);
