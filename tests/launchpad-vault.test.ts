import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { readFolderTools } from "../src/folder/inspect-tools-change";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { startLaunchpad } from "../src/launchpad/server";
import { runTool } from "../src/tools/status";
import type { VaultHost, VaultJournalEntry } from "../src/vault/flow";
import { readSession, vaultPaths } from "../src/vault/store";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownAccount,
  pilotContext,
  startFakeVault,
  stateDirectory,
  vaultName,
  vaultOrigin,
  zipOf,
} from "./fixtures/fake-vault";
import { bindings } from "./fixtures/machine-bindings";

// Settings → Tools → bitwarden over HTTP (decisions F43, F52): the three
// routes behind the admission of every route, `{}` only, a setup answered
// while it runs and joined by the next request, the Launchpad's own setup
// after its start (the Executor pattern), and the curated routes of F19
// refusing the vault.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

/** Polls until `read` answers something, for at most `ms`. */
async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  ms = 30_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(25);
  }
}

async function session(
  options: Readonly<{
    /** Present: the Launchpad of an install base, asked at its start
     * whether it sets the vault up (`vaultAtStart`). */
    vaultAtStart?: () => Promise<boolean>;
    context?: VaultHost["context"];
    /** The host keeps no journal: the Launchpad journals itself. */
    launchpadJournal?: boolean;
    /** The network pre-allowed the account before the Launchpad starts. */
    allowed?: boolean;
    /** The Folder of a personal Remote Environment (bitwarden is offered
     * there on Linux) instead of this computer's. */
    hosted?: boolean;
  }> = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-vault-")),
  );
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  if (options.allowed === true) vault.allow(ownAccount);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const journal: VaultJournalEntry[] = [];
  const folder = join(parent, "Lazurio");
  if (options.hosted === true) {
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o700 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    await initializeHandoverFolder(folder, {
      preset: "hosted-personal",
      machine: bindings.personal,
      profile: presetProfile("hosted-personal", executionOs(process.platform)),
    });
  } else
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "cs",
      detail: "concise",
      coordination: "direct",
    });
  // The health socket of the base: a short path, within a socket's limit.
  const base = join(parent, "b");
  await mkdir(join(base, "update"), { recursive: true });
  const host = fakeHost({
    home,
    vault,
    pin,
    download: fakeRelease(pin, zip).fetch,
    journal,
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    options.vaultAtStart === undefined
      ? undefined
      : { base, version: "1.0.0", vaultAtStart: options.vaultAtStart },
    {},
    {
      path: "/usr/bin:/bin",
      home,
      xdg: {},
      platform: process.platform,
      run: runTool,
    },
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.launchpadJournal === true ? { ...host, journal: undefined } : host,
  );
  const url = new URL(app.url);
  const call = (route: string, body: unknown, headers: Json = {}) =>
    fetch(new URL(route, url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
        ...(headers as Record<string, string>),
      },
      body: JSON.stringify(body),
    });
  const json = async (route: string, body: unknown = {}) => {
    const response = await call(route, body);
    return { status: response.status, body: (await response.json()) as Json };
  };
  // A setup: started, then asked again while it runs.
  const setup = async () => {
    const seen: string[] = [];
    let job: unknown;
    for (let attempt = 0; attempt < 120; attempt++) {
      const answer = await json(
        "/api/tools/bitwarden/setup",
        job === undefined ? {} : { job },
      );
      if (answer.status !== 202) return { ...answer, seen };
      expect(answer.body.kind).toBe("vault-setting-up");
      job = answer.body.job;
      seen.push(String(answer.body.phase));
    }
    throw new Error("The setup did not end");
  };
  return {
    home,
    folder,
    vault,
    journal,
    call,
    json,
    setup,
    paths: vaultPaths(
      stateDirectory(home, "vaultwarden.example.lazurio.io", ownAccount),
    ),
    async close() {
      await app.close();
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test.skipIf(!posix)(
  "the vault routes set the Environment's own vault up, refresh it and read it over the one core",
  async () => {
    const s = await session();
    try {
      expect(await s.json("/api/tools/bitwarden/status")).toEqual({
        status: 200,
        body: {
          kind: "vault-status",
          state: "not-set-up",
          vault: vaultOrigin,
          account: ownAccount,
          name: vaultName,
          team: false,
          origin: "own",
          next: "install",
        },
      });
      expect(await s.setup()).toMatchObject({
        status: 200,
        body: { state: "not-allowed" },
      });
      s.vault.allow(ownAccount);
      const done = await s.setup();
      expect(done).toMatchObject({
        status: 200,
        body: { state: "connected", organization: vaultName, items: 0 },
      });
      const [organization] = s.vault.organizationsOf(ownAccount);
      expect(done.body.organizationId).toBe(organization?.id);
      expect(await s.json("/api/tools/bitwarden/refresh")).toMatchObject({
        status: 200,
        body: { state: "connected", organizationId: organization?.id },
      });
      expect(await s.json("/api/tools/bitwarden/status")).toMatchObject({
        status: 200,
        body: { state: "connected" },
      });
      // Only codes went to the journal, and no session to any answer.
      const operations = s.journal.map((entry) => entry.operation);
      expect(operations).toContain("setup");
      expect(operations).toContain("vault");
      expect(operations).toContain("refresh");
      const secret = (await readSession(s.paths)) ?? "?";
      expect(JSON.stringify(done.body)).not.toContain(secret);
      expect(JSON.stringify(s.journal)).not.toContain(secret);
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "the vault routes take `{}` only, behind the admission; connect and disconnect are gone; the curated routes refuse the vault",
  async () => {
    const s = await session();
    try {
      for (const route of [
        "/api/tools/bitwarden/status",
        "/api/tools/bitwarden/refresh",
        "/api/tools/bitwarden/setup",
      ]) {
        expect(
          (await s.call(route, {}, { Authorization: "Bearer wrong" })).status,
        ).toBe(403);
        expect((await s.call(route, { session: "x" })).status).toBe(400);
        expect(
          (await s.call(route, {}, { "Content-Type": "text/plain" })).status,
        ).toBe(415);
      }
      for (const route of [
        "/api/tools/bitwarden/connect",
        "/api/tools/bitwarden/disconnect",
      ])
        expect((await s.call(route, {})).status).toBe(404);
      // A setup is asked about only by the handle of the one that runs or
      // ran last.
      expect(
        await s.json("/api/tools/bitwarden/setup", {
          job: "0123456789abcdef0123456789abcdef",
        }),
      ).toEqual({
        status: 404,
        body: { kind: "blocked", reason: "job-unknown", tool: "bitwarden" },
      });
      expect(
        (await s.call("/api/tools/bitwarden/setup", { job: "x" })).status,
      ).toBe(400);
      expect(
        (
          await s.call("/api/tools/bitwarden/status", {
            job: "0123456789abcdef0123456789abcdef",
          })
        ).status,
      ).toBe(400);
      for (const route of [
        "/api/tools/install",
        "/api/tools/login/start",
        "/api/tools/logout",
      ])
        expect(await s.json(route, { tool: "bitwarden" })).toEqual({
          status: 409,
          body: { kind: "blocked", reason: "setup-vault", tool: "bitwarden" },
        });
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "after its start the Launchpad sets the own vault up once in the background: the start does not wait, the row's status shows the job, and the journal names the start",
  async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation(
      (...values: unknown[]) => {
        lines.push(values.map(String).join(" "));
      },
    );
    let asked = 0;
    const s = await session({
      launchpadJournal: true,
      allowed: true,
      vaultAtStart: async () => {
        asked++;
        return true;
      },
    });
    try {
      // The status follows the setup the start began, then its end.
      const ended = await until(async () => {
        const answer = await s.json("/api/tools/bitwarden/status");
        return answer.status === 200 && answer.body.state === "connected"
          ? answer
          : null;
      });
      expect(ended.body).toMatchObject({
        origin: "own",
        organization: vaultName,
      });
      expect(asked).toBe(1);
      expect(s.vault.organizationsOf(ownAccount)).toHaveLength(1);
      const vaultLines = lines
        .filter((line) => line.includes('"tools-vault"'))
        .map((line) => JSON.parse(line));
      expect(vaultLines).toContainEqual({
        scope: "tools-vault",
        operation: "setup",
        outcome: "connected",
        trigger: "start",
      });
      expect(vaultLines).toContainEqual({
        scope: "tools-vault",
        operation: "vault",
        outcome: "created",
        trigger: "start",
      });
      // The vault became ready, but this computer's Folder does not offer
      // it: the switch refuses as it always does, and nothing failed.
      expect(vaultLines).toContainEqual({
        scope: "tools-vault",
        operation: "vault",
        outcome: "ready",
        trigger: "start",
      });
      expect(
        vaultLines.filter((line) => line.outcome === "agents-not-enabled"),
      ).toEqual([]);
      expect((await readFolderTools(s.folder)).enabled).not.toContain(
        "bitwarden",
      );
    } finally {
      log.mockRestore();
      await s.close();
    }
  },
  60_000,
);

// Root decision 0198 point 1: the agents use the Environment's vault
// themselves. The Folder offers it on a Remote Environment on Linux only, so
// this runs there (CI); `tests/vault-flow.test.ts` holds the once-per-vault
// rule everywhere.
test.skipIf(process.platform !== "linux")(
  'the setup in which the vault becomes ready turns "Používají agenti" on in the Launchpad\'s Folder; a person who turns it off keeps it off through later setups',
  async () => {
    const s = await session({
      hosted: true,
      allowed: true,
      vaultAtStart: async () => true,
    });
    try {
      // The start's setup ends with the vault connected and switched on.
      await until(async () => {
        const answer = await s.json("/api/tools/bitwarden/status");
        return answer.status === 200 && answer.body.state === "connected"
          ? answer
          : null;
      });
      const on = await readFolderTools(s.folder);
      expect(on.enabled).toContain("bitwarden");
      // The person turns it off.
      expect(
        await s.json("/api/tools/update", {
          expectedRevision: on.revision,
          tools: on.enabled.filter((tool) => tool !== "bitwarden"),
        }),
      ).toMatchObject({ status: 200, body: { kind: "updated" } });
      // A later setup of the same vault, its session lost as after a
      // restart: connected again, and the switch stays off.
      await rm(join(s.paths.data, "fake", "session"));
      expect(await s.setup()).toMatchObject({
        status: 200,
        body: { state: "connected" },
      });
      expect((await readFolderTools(s.folder)).enabled).not.toContain(
        "bitwarden",
      );
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a Launchpad that is not a supervised base of the hosted operator, or a vault that needs no setup, sets nothing up at its start",
  async () => {
    // Not asked to (not a supervised hosted base).
    const s = await session({
      allowed: true,
      vaultAtStart: async () => false,
    });
    try {
      await Bun.sleep(300);
      expect(await s.json("/api/tools/bitwarden/status")).toMatchObject({
        status: 200,
        body: { state: "not-set-up", next: "install" },
      });
      expect(s.vault.requests).toHaveLength(0);
    } finally {
      await s.close();
    }
    // A 0197 pilot (no vault in the handover) is only read.
    let asked = false;
    const pilot = await session({
      context: async () => pilotContext(),
      vaultAtStart: async () => {
        asked = true;
        return true;
      },
    });
    try {
      await until(async () => asked);
      await Bun.sleep(300);
      expect(await pilot.json("/api/tools/bitwarden/status")).toEqual({
        status: 200,
        body: {
          kind: "vault-status",
          state: "unsupported",
          reason: "no-vault",
        },
      });
      expect(pilot.vault.requests).toHaveLength(0);
      expect(pilot.journal).toEqual([]);
    } finally {
      await pilot.close();
    }
  },
  60_000,
);
