import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainHttp } from "../src/brain/admin";
import { convergeBrainKeys, writeBrainState } from "../src/brain/keys";
import { brainPaths } from "../src/brain/pin";

// A key Lazurio did not mint, handed over and working (plan LZD-0033 R11a,
// review of the map thread): Lazurio's state knows an older id, Machines
// minted a new key before C1 reached the host. The key in use must survive.
// The brain's admin API is a function: no socket, fictional tokens.

test("a working key whose id Lazurio does not know is kept and never revoked", async () => {
  const root = await mkdtemp(join(tmpdir(), "brain-keys-kept-"));
  const paths = brainPaths(join(root, "home"));
  await mkdir(join(paths.brain, "serve"), { recursive: true });
  await writeFile(paths.adminToken, "a".repeat(64));
  const keys = [
    {
      id: "L1",
      name: "lazurio-launchpad-memory",
      token: "l1".repeat(16),
      status: "revoked",
    },
    {
      id: "M2",
      name: "lazurio-launchpad-memory",
      token: "m2".repeat(16),
      status: "active",
    },
    {
      id: "E1",
      name: "lazurio-executor-brain",
      token: "e1".repeat(16),
      status: "active",
    },
    {
      id: "P1",
      name: "lazurio-brain-probe",
      token: "p1".repeat(16),
      status: "active",
    },
  ];
  for (const [path, token] of [
    [paths.launchpadKey, "m2".repeat(16)],
    [paths.executorKey, "e1".repeat(16)],
    [paths.probeKey, "p1".repeat(16)],
  ] as const)
    await writeFile(
      path,
      JSON.stringify({ url: "http://127.0.0.1:3131", token }),
    );
  await writeBrainState(paths, {
    keys: {
      launchpad: { id: "L1" },
      executor: { id: "E1" },
      probe: { id: "P1" },
    },
  });
  const revoked: string[] = [];
  const http: BrainHttp = async (_method, url, body, headers) => {
    const path = new URL(url).pathname;
    if (path === "/mcp") {
      const token = (headers?.authorization ?? "").replace("Bearer ", "");
      const ok = keys.some((k) => k.token === token && k.status === "active");
      return { status: ok ? 200 : 401, body: "{}" };
    }
    if (path === "/admin/login")
      return { status: 200, body: "{}", cookie: "admin=1" };
    if (path === "/admin/api/api-keys")
      return { status: 200, body: JSON.stringify(keys) };
    if (path === "/admin/api/api-keys/revoke") {
      const id = (body as { id: string }).id;
      revoked.push(id);
      for (const k of keys) if (k.id === id) k.status = "revoked";
      return { status: 200, body: "{}" };
    }
    return { status: 404, body: "{}" };
  };
  const result = await convergeBrainKeys({
    paths,
    http,
    base: "http://127.0.0.1:3131",
  });
  expect(result.outcomes).toEqual({
    launchpad: "kept",
    executor: "kept",
    probe: "kept",
  });
  expect(revoked).toEqual([]);
  expect(keys.find((k) => k.id === "M2")?.status).toBe("active");
});
