import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { runTool } from "../src/tools/status";
import type { VaultJournalEntry } from "../src/vault/flow";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  fingerprint,
  startFakeVault,
  zipOf,
} from "./fixtures/fake-vault";

// Settings → Tools → bitwarden over HTTP (decision F43): the four routes
// behind the admission of every route, `{}` only, a connect answered while it
// runs and joined by the next request, and the curated routes of F19
// refusing the vault.

const posix = process.platform !== "win32";
const account = "vaultwarden@example.lazurio.io";
type Json = Record<string, unknown>;

async function session() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-vault-")),
  );
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const journal: VaultJournalEntry[] = [];
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
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
    fakeHost({
      home,
      vault,
      pin,
      download: fakeRelease(pin, zip).fetch,
      journal,
    }),
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
  // A connect: started, then asked again while it runs.
  const connect = async () => {
    const seen: string[] = [];
    let job: unknown;
    for (let attempt = 0; attempt < 60; attempt++) {
      const answer = await json(
        "/api/tools/bitwarden/connect",
        job === undefined ? {} : { job },
      );
      if (answer.status !== 202) return { ...answer, seen };
      expect(answer.body.kind).toBe("vault-connecting");
      job = answer.body.job;
      seen.push(String(answer.body.phase));
    }
    throw new Error("The connect did not end");
  };
  return {
    vault,
    journal,
    call,
    json,
    connect,
    async close() {
      await app.close();
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test.skipIf(!posix)(
  "the vault routes connect, confirm, refresh and disconnect over the one core",
  async () => {
    const s = await session();
    try {
      expect(await s.json("/api/tools/bitwarden/status")).toEqual({
        status: 200,
        body: {
          kind: "vault-status",
          state: "not-installed",
          vault: "https://vaultwarden.example.lazurio.io",
          account,
          collection: "Environmenty/Osobní · example",
          name: "Osobní",
          team: false,
          registered: false,
        },
      });
      expect(await s.connect()).toMatchObject({
        status: 200,
        body: { state: "awaiting-invite" },
      });
      s.vault.invite(account);
      expect(await s.connect()).toMatchObject({
        status: 200,
        body: { state: "confirming", fingerprint },
      });
      await s.vault.confirm("Environmenty/Osobní · example", 4);
      expect(await s.json("/api/tools/bitwarden/refresh")).toMatchObject({
        status: 200,
        body: { state: "connected", collections: 1, items: 4 },
      });
      expect(await s.json("/api/tools/bitwarden/disconnect")).toMatchObject({
        status: 200,
        body: { state: "none", registered: true },
      });
      // Only codes went to the journal.
      expect(s.journal.map((entry) => entry.operation)).toEqual([
        "connect",
        "unlock",
        "connect",
        "refresh",
        "disconnect",
      ]);
    } finally {
      await s.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "the vault routes take `{}` only, behind the admission, and the curated routes refuse the vault",
  async () => {
    const s = await session();
    try {
      for (const route of [
        "/api/tools/bitwarden/status",
        "/api/tools/bitwarden/refresh",
        "/api/tools/bitwarden/connect",
        "/api/tools/bitwarden/disconnect",
      ]) {
        expect(
          (await s.call(route, {}, { Authorization: "Bearer wrong" })).status,
        ).toBe(403);
        expect((await s.call(route, { session: "x" })).status).toBe(400);
        expect(
          (await s.call(route, {}, { "Content-Type": "text/plain" })).status,
        ).toBe(415);
      }
      // A connect is asked about only by the handle of the one that runs or
      // ran last.
      expect(
        await s.json("/api/tools/bitwarden/connect", {
          job: "0123456789abcdef0123456789abcdef",
        }),
      ).toEqual({
        status: 404,
        body: { kind: "blocked", reason: "job-unknown", tool: "bitwarden" },
      });
      expect(
        (await s.call("/api/tools/bitwarden/connect", { job: "x" })).status,
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
