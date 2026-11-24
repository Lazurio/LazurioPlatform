import { afterEach, expect, spyOn, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeRoutes, routeChecks } from "../src/doctor/doctor";
import {
  assignedEnvironments,
  handoverRoutes,
} from "../src/folder/machine-binding";
import { withEnvironmentSsh } from "../src/machine/cli";
import type { AccessServiceFetch } from "../src/ssh-access/access-service";
import {
  managedHeader,
  recordedRoutes,
  writeEnvironmentRoutes,
  writeEnvironmentSsh,
} from "../src/ssh-access/environments";
import {
  declaredServiceOf,
  routesSourceOf,
  syncEnvironmentRoutes,
} from "../src/ssh-access/routes";
import { runTool } from "../src/tools/status";
import { binding, bindings } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personalAssigned from "./fixtures/machine-context-personal-assigned.json";
import { routeSsh } from "./fixtures/route-ssh";

// LazurioPlatform#1227: the sister-organization exception (Machines
// workloads/conglomerate-host/SISTER-ORGANIZATION-ENVIRONMENT-SOURCE.md)
// projects a peer with `access: "assigned"` into a Work Environment's
// handover, and the Platform writes `Host <id>` for it. The home access
// service derives nothing for that peer, so on a Work Environment the
// handover's own routes are written beside the service's targets, the
// service's winning for the same Environment id (decision F70, addendum of
// 2026-11-24). A Personal Environment with a service keeps only the
// service's routes, as before. Every fixture is synthetic.

const uid = process.getuid?.();
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function home() {
  const path = await mkdtemp(join(tmpdir(), "lazurio-work-assigned-"));
  homes.push(path);
  return path;
}
const conf = (path: string) =>
  join(path, ".ssh", "config.d", "lazurio-environments.conf");
const knownHosts = (path: string) =>
  join(path, ".ssh", "known_hosts_lazurio_environments");
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const keyA =
  "AAAAC3NzaC1lZDI1NTE5AAAAIOosFYFA3vTPDE3z8629wlmF0Qecl1enPwpEjCjOsnfj";
const keyB =
  "AAAAC3NzaC1lZDI1NTE5AAAAIIFygZVmr1cFYx//JrQ0yWhRLdAwCbc1XS4H6ktOFDTx";
const origin = "http://example-conglomerate-host.tailnet.example.invalid:8444";
const sister = "carol-01.sister";

const { team: _team, ...owner } = organization.owner;
const sisterPeer = (environment = sister) => ({
  name: "sister-carol-01-vm",
  kind: "workspace-vm",
  zone: "work",
  organization: "sister",
  environment,
  access: "assigned",
  ssh: {
    host: "sister-carol-01-vm.tailnet.example.invalid",
    user: "carol",
    direction: "outbound",
    host_keys: [{ type: "ssh-ed25519", key: keyA }],
  },
  https: [],
});
const laptop = {
  name: "example-laptop",
  kind: "client-device",
  zone: "personal",
  organization: null,
  ssh: {
    host: "example-laptop.tailnet.example.invalid",
    user: null,
    direction: "inbound",
  },
  https: [],
};
const work = (peers: unknown[], declared = false) =>
  binding({
    ...organization,
    owner,
    relationships: { zone: "work", peers },
    ...(declared ? { access_service: { origin } } : {}),
  });
const workAssigned = work([laptop, sisterPeer()]);
const workAssignedServed = work([laptop, sisterPeer()], true);
const personalServed = binding({
  ...personalAssigned,
  access_service: { origin },
});

const now = Date.parse("2026-11-24T02:00:00Z");
const target = (overrides: Record<string, unknown> = {}) => ({
  environment: "alice.example",
  host: "example-alice-vm.tailnet.example.invalid",
  user: "alice",
  host_key: `ssh-ed25519 ${keyB}`,
  valid_until: "2026-11-24T02:03:30Z",
  ...overrides,
});
/** A fake service: registration accepted, targets as given; `null` targets
 * refuse the connection. */
function fakeService(targets: unknown[] | null): AccessServiceFetch {
  return async (url) => {
    const path = new URL(url).pathname;
    if (targets === null) throw new TypeError("connection refused");
    if (path === "/v1/source-key")
      return new Response(
        JSON.stringify({
          schema_version: "machines.access-source-key-receipt.v1",
          changed: true,
        }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
        schema_version: "machines.access-targets.v1",
        targets,
      }),
      { status: 200 },
    );
  };
}

test("a Work Environment's handover routes are its assigned peers; the Folder's personal lists stay personal", () => {
  expect(handoverRoutes(workAssigned)).toEqual([
    {
      environment: sister,
      organization: "sister",
      host: "sister-carol-01-vm.tailnet.example.invalid",
      user: "carol",
      hostKeys: [{ type: "ssh-ed25519", key: keyA }],
    },
  ]);
  // The manual and AGENTS.md of a Work Folder do not list them as the
  // person's assigned Work Environments.
  expect(assignedEnvironments(workAssigned)).toEqual([]);
  expect(handoverRoutes(bindings.personalAssigned)).toEqual(
    assignedEnvironments(bindings.personalAssigned),
  );
  // No assigned peer, no route; nothing on a Machine of another kind.
  expect(handoverRoutes(work([laptop]))).toEqual([]);
  expect(handoverRoutes(bindings.organization)).toEqual([]);
  expect(handoverRoutes(bindings.services)).toEqual([]);
  expect(handoverRoutes(null)).toEqual([]);
});

test("without a declared service a Work Environment writes Host <id> for its assigned peer, pinned, and a second run changes nothing", async () => {
  const path = await home();
  const location = { home: path, uid };
  expect(routesSourceOf(workAssigned)).toEqual(handoverRoutes(workAssigned));
  const seams = {
    run: runTool,
    now: () => now,
    current: async () => routesSourceOf(workAssigned),
  };
  expect<unknown>(
    await withEnvironmentSsh(
      { kind: "refreshed", revision: 4 },
      workAssigned,
      location,
      undefined,
      seams,
    ),
  ).toEqual({
    kind: "refreshed",
    revision: 4,
    environmentSsh: { kind: "written", environments: [sister] },
  });
  const written = await readFile(conf(path), "utf8");
  expect(written).toContain(`\nHost ${sister}\n`);
  expect(written).toContain(
    "  HostName sister-carol-01-vm.tailnet.example.invalid\n  User carol\n",
  );
  expect(written).toContain("  StrictHostKeyChecking yes\n");
  expect(await readFile(knownHosts(path), "utf8")).toBe(
    `${managedHeader}\n${sister} ssh-ed25519 ${keyA}\n`,
  );
  expect<unknown>(
    await withEnvironmentSsh(
      { kind: "unchanged" },
      workAssigned,
      location,
      undefined,
      seams,
    ),
  ).toEqual({
    kind: "unchanged",
    environmentSsh: { kind: "unchanged", environments: [sister] },
  });
  // The peer leaves the handover: its route goes with it.
  const gone = work([laptop]);
  expect<unknown>(
    await withEnvironmentSsh({ kind: "unchanged" }, gone, location, undefined, {
      ...seams,
      current: async () => routesSourceOf(gone),
    }),
  ).toEqual({ kind: "unchanged", environmentSsh: { kind: "removed" } });
  expect(await exists(conf(path))).toBe(false);
  // The direct writer (onboarding of a Work Folder) writes the same route.
  expect(await writeEnvironmentSsh(location, workAssigned)).toEqual({
    kind: "written",
    environments: [sister],
  });
});

test("with a declared service a Work Environment writes the service's targets and its own assigned peer; the service wins for the same id", async () => {
  const source = routesSourceOf(workAssignedServed);
  const service = declaredServiceOf(workAssignedServed);
  expect(service).toEqual({ origin, own: handoverRoutes(workAssigned) });
  expect<unknown>(source).toEqual(service);
  const path = await home();
  const location = { home: path, uid };
  const seams = (targets: unknown[] | null, at = now) => ({
    run: runTool,
    now: () => at,
    current: async () => routesSourceOf(workAssignedServed),
    fetch: fakeService(targets),
  });
  if (service === null) throw new Error("no service");
  const first = await syncEnvironmentRoutes(
    location,
    service,
    seams([target()]),
  );
  expect(first.targets).toBe("answered");
  expect(first.ssh).toEqual({
    kind: "written",
    environments: ["alice.example", sister],
  });
  expect(
    (await recordedRoutes(location)).map((route) => [
      route.environment,
      route.host,
      route.validUntil ?? null,
    ]),
  ).toEqual([
    [
      "alice.example",
      "example-alice-vm.tailnet.example.invalid",
      "2026-11-24T02:03:30Z",
    ],
    [sister, "sister-carol-01-vm.tailnet.example.invalid", null],
  ]);
  // The service names the same Environment: its target is the one written.
  const both = await syncEnvironmentRoutes(
    location,
    service,
    seams([
      target({
        environment: sister,
        host: "served-carol-01-vm.tailnet.example.invalid",
      }),
    ]),
  );
  expect(both.ssh).toEqual({ kind: "written", environments: [sister] });
  expect((await recordedRoutes(location)).map((route) => route.host)).toEqual([
    "served-carol-01-vm.tailnet.example.invalid",
  ]);
  // An unreachable service adds nothing and keeps its unexpired routes; the
  // handover's own route stays, as it never depended on the service.
  await syncEnvironmentRoutes(location, service, seams([target()]));
  const down = await syncEnvironmentRoutes(location, service, seams(null));
  expect(down.targets).toBe("unreachable");
  expect(down.ssh).toEqual({
    kind: "unchanged",
    environments: ["alice.example", sister],
  });
  const later = await syncEnvironmentRoutes(
    location,
    service,
    seams(null, Date.parse("2026-11-24T02:04:30Z")),
  );
  expect(later.ssh).toEqual({ kind: "written", environments: [sister] });
});

test("a live handover whose own routes changed supersedes the write, and nothing is written", async () => {
  const path = await home();
  const location = { home: path, uid };
  const service = declaredServiceOf(workAssignedServed);
  if (service === null) throw new Error("no service");
  const moved = work([laptop, sisterPeer("carol-02.sister")], true);
  const result = await syncEnvironmentRoutes(location, service, {
    run: runTool,
    now: () => now,
    current: async () => routesSourceOf(moved),
    fetch: fakeService([target()]),
  });
  expect(result.ssh).toEqual({ kind: "superseded" });
  expect(await exists(conf(path))).toBe(false);
});

test("a Personal Environment with a declared service keeps only the service's routes", async () => {
  expect(declaredServiceOf(personalServed)).toEqual({ origin });
  const path = await home();
  const location = { home: path, uid };
  const result = await syncEnvironmentRoutes(
    location,
    { origin },
    {
      run: runTool,
      now: () => now,
      current: async () => routesSourceOf(personalServed),
      fetch: fakeService([target()]),
    },
  );
  expect(result.ssh).toEqual({
    kind: "written",
    environments: ["alice.example"],
  });
});

test("the doctor expects a Work Environment's assigned peer with or without the service, and tries it", async () => {
  const path = await home();
  const ssh = routeSsh(path);
  const own = handoverRoutes(workAssigned);
  await writeEnvironmentRoutes({ home: path, uid }, own);
  const observe = (machine: typeof workAssigned, fetch?: AccessServiceFetch) =>
    observeRoutes({
      home: path,
      uid,
      machine,
      routes: true,
      run: ssh.run,
      now: () => now,
      ...(fetch === undefined ? {} : { fetch }),
    });
  const without = await observe(workAssigned);
  expect(without.expected.map((route) => route.environment)).toEqual([sister]);
  expect(ssh.tried).toEqual([sister]);
  // The service answers nothing for it; it is still expected and tried.
  ssh.tries.length = 0;
  const served = await observe(workAssignedServed, fakeService([]));
  expect(served.expected.map((route) => route.environment)).toEqual([sister]);
  expect(ssh.tried).toEqual([sister]);
  expect(
    routeChecks(served)
      .filter((check) => check.id === "environment-route")
      .map((check) => [check.outcome, check.context]),
  ).toEqual([["ok", { environment: sister, at: "2026-11-24T02:00:00Z" }]]);
});

test("while the service does not answer the doctor still reports the handover's own route, and not one an unexpired service route holds", async () => {
  const path = await home();
  const location = { home: path, uid };
  const ssh = routeSsh(path);
  const observe = () =>
    observeRoutes({
      home: path,
      uid,
      machine: workAssignedServed,
      routes: true,
      run: ssh.run,
      now: () => now,
      fetch: fakeService(null),
    });
  const rows = async () =>
    routeChecks(await observe()).map((check) => [
      check.id,
      check.outcome,
      check.reason ?? "",
      check.context ?? {},
    ]);
  // Never written: the missing route is named beside the service's failure.
  expect(await rows()).toEqual([
    ["access-service", "warn", "access-service-unreachable", {}],
    [
      "environment-route",
      "warn",
      "route-not-configured",
      { environment: sister },
    ],
  ]);
  expect(ssh.tried).toEqual([]);
  // Written: tried and reported.
  await writeEnvironmentRoutes(location, handoverRoutes(workAssigned));
  expect(await rows()).toEqual([
    ["access-service", "warn", "access-service-unreachable", {}],
    [
      "environment-route",
      "ok",
      "",
      { environment: sister, at: "2026-11-24T02:00:00Z" },
    ],
  ]);
  expect(ssh.tried).toEqual([sister]);
  // An unexpired route the service gave under the same id keeps it: the
  // handover's copy is not expected, and nothing is blamed or tried.
  ssh.tries.length = 0;
  await writeEnvironmentRoutes(location, [
    {
      environment: sister,
      host: "served-carol-01-vm.tailnet.example.invalid",
      user: "carol",
      hostKeys: [{ type: "ssh-ed25519", key: keyB }],
      validUntil: "2026-11-24T02:03:30Z",
    },
  ]);
  expect(await rows()).toEqual([
    ["access-service", "warn", "access-service-unreachable", {}],
  ]);
  expect(ssh.tried).toEqual([]);
});

test("a first synchronization while the service is down writes the handover's own route and says so", async () => {
  const path = await home();
  const location = { home: path, uid };
  const said: string[] = [];
  const error = spyOn(console, "error").mockImplementation((line: unknown) => {
    said.push(String(line));
  });
  try {
    const result = (await withEnvironmentSsh(
      { kind: "initialized", revision: 1 },
      workAssignedServed,
      location,
      undefined,
      {
        run: runTool,
        now: () => now,
        current: async () => routesSourceOf(workAssignedServed),
        fetch: fakeService(null),
      },
    )) as unknown as {
      environmentRoutes?: { targets: string; ssh: unknown };
    };
    expect(result.environmentRoutes?.targets).toBe("unreachable");
    expect(result.environmentRoutes?.ssh).toEqual({
      kind: "written",
      environments: [sister],
    });
  } finally {
    error.mockRestore();
  }
  expect(said).toEqual([
    "The access service did not give this Environment its routes (unreachable); none of its routes was added, and those it gave earlier end at their deadline. The routes this Environment's handover declares itself are written as declared.",
  ]);
  // A Personal Environment, which has no own routes beside the service, is
  // told only about the service's.
  said.length = 0;
  const personal = spyOn(console, "error").mockImplementation(
    (line: unknown) => {
      said.push(String(line));
    },
  );
  try {
    await withEnvironmentSsh(
      { kind: "initialized", revision: 1 },
      personalServed,
      { home: await home(), uid },
      undefined,
      {
        run: runTool,
        now: () => now,
        current: async () => routesSourceOf(personalServed),
        fetch: fakeService(null),
      },
    );
  } finally {
    personal.mockRestore();
  }
  expect(said).toEqual([
    "The access service did not give this Environment its routes (unreachable); none of its routes was added, and those it gave earlier end at their deadline.",
  ]);
});
