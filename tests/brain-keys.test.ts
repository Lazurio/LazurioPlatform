import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainHttp } from "../src/brain/admin";
import { convergeBrainKeys, readBrainState } from "../src/brain/keys";
import { brainPaths } from "../src/brain/pin";

// The keys Lazurio mints over the brain's admin API (plan LZD-0033 R11a),
// against a loopback stand-in of gbrain's admin and MCP endpoints with
// fictional tokens: kept while they work, minted otherwise, every other
// active key of the same name revoked, and Machines' ledger only read.

type Key = {
  id: string;
  name: string;
  token: string;
  status: string;
  scopes: string[];
};
const brain = {
  admin: "admin-secret-for-tests-only",
  keys: [] as Key[],
  logins: 0,
};
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body =
        request.method === "POST" ? await request.json().catch(() => ({})) : {};
      const cookie = request.headers.get("cookie") ?? "";
      if (url.pathname === "/mcp") {
        const token = (request.headers.get("authorization") ?? "").replace(
          "Bearer ",
          "",
        );
        const ok = brain.keys.some(
          (key) => key.token === token && key.status === "active",
        );
        return new Response("{}", { status: ok ? 200 : 401 });
      }
      if (url.pathname === "/admin/login") {
        brain.logins++;
        return body.token === brain.admin
          ? new Response("{}", { headers: { "set-cookie": "admin=1; Path=/" } })
          : new Response("{}", { status: 401 });
      }
      if (!cookie.includes("admin=1"))
        return new Response("{}", { status: 401 });
      if (url.pathname === "/admin/api/api-keys" && request.method === "GET")
        return Response.json(brain.keys.map(({ token: _t, ...key }) => key));
      if (url.pathname === "/admin/api/api-keys") {
        const key = {
          id: `id-${brain.keys.length + 1}`,
          name: body.name,
          token: `tok-${brain.keys.length + 1}-${"x".repeat(32)}`,
          status: "active",
          scopes: body.scopes,
        };
        brain.keys.push(key);
        return Response.json({
          id: key.id,
          name: key.name,
          token: key.token,
          scopes_applied: key.scopes,
        });
      }
      if (url.pathname === "/admin/api/api-keys/revoke") {
        for (const key of brain.keys)
          if (key.id === body.id) key.status = "revoked";
        return Response.json({});
      }
      return new Response("{}", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function home(adminToken = brain.admin) {
  const root = await mkdtemp(join(tmpdir(), "brain-keys-"));
  const paths = brainPaths(root);
  await mkdir(join(paths.brain, "serve"), { recursive: true });
  await writeFile(paths.adminToken, `${adminToken}\n`, { mode: 0o600 });
  return paths;
}

const active = (name: string) =>
  brain.keys.filter((k) => k.name === name && k.status === "active");

describe("brain keys", () => {
  test("a fresh brain gets all three keys, handed over 0600, ids in Lazurio's state", async () => {
    brain.keys = [];
    const paths = await home();
    const result = await convergeBrainKeys({ paths, http: brainHttp, base });
    expect(result.outcomes).toEqual({
      launchpad: "minted",
      executor: "minted",
      probe: "minted",
    });
    for (const file of [
      paths.launchpadKey,
      paths.executorKey,
      paths.probeKey,
    ]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const handover = JSON.parse(await readFile(file, "utf8"));
      expect(handover.url).toBe(base);
      expect(handover.token.length).toBeGreaterThanOrEqual(16);
    }
    expect(brain.keys.map((k) => [k.name, k.scopes])).toEqual([
      ["lazurio-launchpad-memory", ["read"]],
      ["lazurio-executor-brain", ["read", "write"]],
      ["lazurio-brain-probe", ["read"]],
    ]);
    const state = await readBrainState(paths);
    expect(state.keys).toEqual({
      launchpad: { id: "id-1" },
      executor: { id: "id-2" },
      probe: { id: "id-3" },
    });
    // The state never carries a token or the owner credential.
    const text = await readFile(paths.state, "utf8");
    expect(text).not.toContain("tok-");
    expect(text).not.toContain(brain.admin);
  });

  test("keys that work are kept: nothing minted, the owner not even asked", async () => {
    brain.keys = [];
    const paths = await home();
    await convergeBrainKeys({ paths, http: brainHttp, base });
    const logins = brain.logins;
    const again = await convergeBrainKeys({ paths, http: brainHttp, base });
    expect(again.outcomes).toEqual({
      launchpad: "kept",
      executor: "kept",
      probe: "kept",
    });
    expect(brain.keys).toHaveLength(3);
    // Kept keys revoke nothing, so the owner credential is not used at all.
    expect(brain.logins).toBe(logins);
  });

  test("Machines' Launchpad key is kept by the id their ledger records, and nothing is revoked while it works", async () => {
    brain.keys = [
      {
        id: "m-1",
        name: "lazurio-launchpad-memory",
        token: `tok-m1-${"y".repeat(32)}`,
        status: "active",
        scopes: ["read"],
      },
      {
        id: "m-orphan",
        name: "lazurio-launchpad-memory",
        token: `tok-mo-${"y".repeat(32)}`,
        status: "active",
        scopes: ["read"],
      },
    ];
    const paths = await home();
    await writeFile(
      paths.launchpadKey,
      JSON.stringify({ url: base, token: brain.keys[0]?.token }),
    );
    const ledger = join(
      paths.home,
      ".local",
      "state",
      "lazurio",
      "buddy",
      "managed.json",
    );
    await mkdir(join(ledger, ".."), { recursive: true });
    const ledgerText = JSON.stringify({
      schema: "lazurio.buddy.managed.v1",
      gbrain_launchpad_key: { id: "m-1" },
    });
    await writeFile(ledger, ledgerText);
    const result = await convergeBrainKeys({ paths, http: brainHttp, base });
    expect(result.outcomes.launchpad).toBe("kept");
    // Revoking happens only after Lazurio's own mint, whose id is certain;
    // the orphan goes with the next one.
    expect(active("lazurio-launchpad-memory").map((k) => k.id)).toEqual([
      "m-1",
      "m-orphan",
    ]);
    expect(result.state.keys?.launchpad).toEqual({ id: "m-1" });
    // Machines' ledger is read, never written.
    expect(await readFile(ledger, "utf8")).toBe(ledgerText);
  });

  test("a handed-over key that no longer works is replaced and revoked", async () => {
    brain.keys = [];
    const paths = await home();
    await convergeBrainKeys({ paths, http: brainHttp, base });
    for (const key of brain.keys)
      if (key.name === "lazurio-executor-brain") key.status = "revoked";
    const stale = brain.keys.find((k) => k.name === "lazurio-launchpad-memory");
    if (stale) stale.token = `tok-changed-${"z".repeat(32)}`; // the handover no longer opens a session
    const result = await convergeBrainKeys({ paths, http: brainHttp, base });
    expect(result.outcomes).toEqual({
      launchpad: "minted",
      executor: "minted",
      probe: "kept",
    });
    expect(active("lazurio-launchpad-memory")).toHaveLength(1);
    expect(active("lazurio-executor-brain")).toHaveLength(1);
  });

  test("an owner credential the brain refuses mints nothing and says failed", async () => {
    brain.keys = [];
    const paths = await home("not-the-owner");
    const result = await convergeBrainKeys({ paths, http: brainHttp, base });
    expect(result.outcomes).toEqual({
      launchpad: "failed",
      executor: "failed",
      probe: "failed",
    });
    expect(brain.keys).toHaveLength(0);
  });
});
