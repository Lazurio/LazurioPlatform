import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctorContextRules,
  doctorReasons,
  observeRoutes,
  type RouteFacts,
  routeChecks,
  routeStanding,
} from "../src/doctor/doctor";
import { assignedEnvironments } from "../src/folder/machine-binding";
import type { AccessTarget } from "../src/ssh-access/access-service";
import {
  type EnvironmentRoute,
  includeLine,
  renderEnvironmentsKnownHosts,
  writeEnvironmentRoutes,
} from "../src/ssh-access/environments";
import {
  type RouteTest,
  routeCause,
  testRoutes,
} from "../src/ssh-access/routes";
import { bindings } from "./fixtures/machine-bindings";
import { routeSsh } from "./fixtures/route-ssh";

// Onboarding and the doctor try every route of root decision 0224 (plan
// DEV-6687 M7, decision F70's addendum): what `ssh <id>` resolves to must be
// the route, then that exact route is tried with `true`, each result with
// its cause and time. While
// the access service answers, a route it gives that is missing or
// unreached needs attention; while it does not answer, the doctor says
// exactly that and blames nothing else. Synthetic Environment ids only.

const now = () => Date.parse("2026-11-03T12:00:00.400Z");
const at = "2026-11-03T12:00:00Z";

test("a failed ssh is named by OpenSSH's own words, and what cannot be told apart stays unknown", () => {
  const cases: [string, string][] = [
    [
      "@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.",
      "host-key-mismatch",
    ],
    ["Host key verification failed.", "host-key-mismatch"],
    [
      "No ED25519 host key is known for alice.example and you have requested strict checking.",
      "host-key-mismatch",
    ],
    ["alice@host: Permission denied (publickey).", "login-refused"],
    [
      "ssh: connect to host h.example.invalid port 22: Connection timed out",
      "timeout",
    ],
    [
      "ssh: connect to host h.example.invalid port 22: Connection refused",
      "connection-refused",
    ],
    [
      "ssh: Could not resolve hostname h.example.invalid: Name or service not known",
      "unresolved",
    ],
    [
      "ssh: connect to host h.example.invalid port 22: No route to host",
      "network-unreachable",
    ],
    ["kex_exchange_identification: read: Connection reset by peer", "unknown"],
    ["", "unknown"],
  ];
  for (const [stderr, cause] of cases)
    expect([stderr, routeCause(stderr)]).toEqual([stderr, cause]);
});

test("each route is tried non-interactively and bounded, exactly as given, with the time it was observed", async () => {
  const path = await home();
  const routes = [
    "a.example",
    "b.example",
    "c.example",
    "d.example",
    "e.example",
  ].map((environment) => route(environment));
  await writeEnvironmentRoutes({ home: path, uid }, routes);
  const ssh = routeSsh(path, {
    answers: {
      "b.example": {
        exitCode: 255,
        stdout: "",
        stderr: "b@h: Permission denied (publickey).",
      },
      "c.example": "timeout",
      "d.example": {
        exitCode: 255,
        stdout: "",
        stderr: "ssh: connect to host d port 22: Connection timed out",
      },
      "e.example": {
        exitCode: 255,
        stdout: "",
        stderr: "Host key verification failed.",
      },
    },
  });
  expect(await testRoutes(routes, path, ssh.run, now)).toEqual([
    { environment: "a.example", result: "reached", at },
    { environment: "b.example", result: "failed", cause: "login-refused", at },
    { environment: "c.example", result: "failed", cause: "timeout", at },
    { environment: "d.example", result: "failed", cause: "timeout", at },
    {
      environment: "e.example",
      result: "failed",
      cause: "host-key-mismatch",
      at,
    },
  ]);
  expect(ssh.resolved).toEqual(routes.map((entry) => entry.environment));
  // Four at a time, so the tries are recorded in any order.
  const first = ssh.tries.find((entry) => entry.environment === "a.example");
  const knownHosts = first?.command
    .find((part) => part.startsWith("UserKnownHostsFile="))
    ?.slice("UserKnownHostsFile=".length) as string;
  expect(
    first?.command.map((part) =>
      part === `UserKnownHostsFile=${knownHosts}`
        ? "UserKnownHostsFile=<this try's file>"
        : part,
    ),
  ).toEqual([
    "ssh",
    "-F",
    "none",
    ...[
      "BatchMode=yes",
      "ConnectTimeout=10",
      `HostName=${routes[0]?.host}`,
      "User=alice",
      "Port=22",
      "HostKeyAlias=a.example",
      "UserKnownHostsFile=<this try's file>",
      "GlobalKnownHostsFile=/dev/null",
      "StrictHostKeyChecking=yes",
      "UpdateHostKeys=no",
      `IdentityFile=${path}/.ssh/lazurio-environment-ed25519`,
      "IdentitiesOnly=yes",
      "ForwardAgent=no",
      "ProxyJump=none",
      "ClearAllForwardings=yes",
      "ControlMaster=no",
      "ControlPath=none",
    ].flatMap((option) => ["-o", option]),
    "-n",
    "-T",
    "a.example",
    "true",
  ]);
  // Its own pinned keys only, in a file that is gone once it ended.
  expect(first?.knownHosts).toBe(
    renderEnvironmentsKnownHosts([routes[0] as EnvironmentRoute]),
  );
  expect(knownHosts.startsWith(path)).toBe(false);
  expect(await readFile(knownHosts, "utf8").catch(() => null)).toBeNull();
  // Nothing in a try forwards, jumps or accepts a key.
  for (const { command } of ssh.tries)
    expect(command.join(" ")).not.toMatch(
      /-A |-J |ForwardAgent=yes|StrictHostKeyChecking=(no|accept-new)|accept-new/,
    );
});

test("a route that ssh would not take as given is not configured, and nothing connects", async () => {
  const path = await home();
  const a = route("a.example");
  await writeEnvironmentRoutes({ home: path, uid }, [a]);
  const config = join(path, ".ssh", "config");
  const written = await readFile(config, "utf8");
  expect(written).toContain(includeLine);
  const ssh = routeSsh(path);
  const notConfigured: RouteTest[] = [
    {
      environment: "a.example",
      result: "failed",
      cause: "not-configured",
      at,
    },
  ];
  expect(await testRoutes([a], path, ssh.run, now)).toEqual([
    { environment: "a.example", result: "reached", at },
  ]);
  const other =
    "Host a.example\n  HostName elsewhere.example.invalid\n  User alice\n";
  for (const text of [
    // The Include removed and another Host for the same id.
    `${written.replace(`${includeLine}\n`, "")}\n${other}`,
    // Another Host for the same id before the Include: it wins in OpenSSH.
    `${other}${written}`,
    // A jump in front of the route.
    `Host a.example\n  ProxyJump jump.example.invalid\n${written}`,
    // The Include removed and nothing else: ssh takes the bare name.
    written.replace(`${includeLine}\n`, ""),
  ]) {
    await writeFile(config, text);
    expect([text, await testRoutes([a], path, ssh.run, now)]).toEqual([
      text,
      notConfigured,
    ]);
  }
  expect(ssh.tried).toEqual(["a.example"]);
});

test("a route replaced between its comparison and its try never lends its result to the replacement", async () => {
  const path = await home();
  const a = route("a.example");
  const moved = route("a.example", {
    host: "a-new.tailnet.example.invalid",
    hostKeys: [{ type: "ssh-ed25519", key: keyB }],
  });
  const replace = async () => {
    await writeEnvironmentRoutes({ home: path, uid }, [moved]);
  };
  // Replaced right after ssh resolved it: the try still goes to the route
  // given, with its own pinned key and never the replacement's.
  await writeEnvironmentRoutes({ home: path, uid }, [a]);
  const after = routeSsh(path, { afterResolve: replace });
  expect(await testRoutes([a], path, after.run, now)).toEqual([
    { environment: "a.example", result: "reached", at },
  ]);
  expect(after.tries[0]?.command).toContain(`HostName=${a.host}`);
  expect(after.tries[0]?.knownHosts).toBe(renderEnvironmentsKnownHosts([a]));
  expect(after.tries[0]?.knownHosts).not.toContain(keyB);
  // Replaced after the doctor compared it, before ssh resolved it: ssh would
  // take the replacement, so the route compared is not configured.
  await writeEnvironmentRoutes({ home: path, uid }, [a]);
  const before = routeSsh(path, { beforeResolve: replace });
  const facts = await observeRoutes({
    home: path,
    uid,
    machine: bindings.personal,
    service: { origin: "http://host.tailnet.example.invalid:8444" },
    routes: true,
    fetch: async () =>
      new Response(
        JSON.stringify({
          schema_version: "machines.access-targets.v1",
          targets: [
            {
              environment: "a.example",
              host: a.host,
              user: "alice",
              host_key: `ssh-ed25519 ${keyA}`,
              valid_until: "2026-11-03T12:03:30Z",
            },
          ],
        }),
        { status: 200 },
      ),
    run: before.run,
    now,
  });
  expect(rows(routeChecks(facts))).toEqual([
    'access-service ok  {"routes":1}',
    `environment-route warn route-unreached {"environment":"a.example","cause":"not-configured","at":"${at}"}`,
  ]);
  expect(before.resolved).toEqual(["a.example"]);
  expect(before.tried).toEqual([]);
});

const keyA =
  "AAAAC3NzaC1lZDI1NTE5AAAAIOosFYFA3vTPDE3z8629wlmF0Qecl1enPwpEjCjOsnfj";
const keyB =
  "AAAAC3NzaC1lZDI1NTE5AAAAIIFygZVmr1cFYx//JrQ0yWhRLdAwCbc1XS4H6ktOFDTx";
const route = (
  environment: string,
  overrides: Partial<AccessTarget> = {},
): AccessTarget => ({
  environment,
  host: `${environment.replace(".", "-")}.tailnet.example.invalid`,
  user: "alice",
  hostKeys: [{ type: "ssh-ed25519", key: keyA }],
  validUntil: "2026-11-03T12:03:30Z",
  ...overrides,
});
const facts = (overrides: Partial<RouteFacts>): RouteFacts => ({
  hosted: true,
  declared: true,
  tested: true,
  targets: null,
  expected: [],
  configured: [],
  tests: [],
  ...overrides,
});
const rows = (checks: ReturnType<typeof routeChecks>) =>
  checks.map((entry) =>
    [
      entry.id,
      entry.outcome,
      entry.reason ?? "",
      JSON.stringify(entry.context ?? {}),
    ].join(" "),
  );

test("while the service answers, every route it gives must be configured exactly as given and reached; one that is not needs attention", () => {
  const targets = [
    route("a.example"),
    route("b.example"),
    route("c.example"),
    // Same id, but the service moved the host and rotated the key since the
    // config was written: the old route is not the current one.
    route("d.example", {
      host: "d-new.tailnet.example.invalid",
      hostKeys: [{ type: "ssh-ed25519", key: keyB }],
    }),
  ];
  const result = routeChecks(
    facts({
      targets: { kind: "answered", targets },
      expected: targets,
      configured: [
        route("a.example"),
        route("b.example"),
        route("d.example"),
        // Nobody expects this one: never tried, never reported.
        route("old.example"),
      ],
      tests: [
        { environment: "a.example", result: "reached", at },
        {
          environment: "b.example",
          result: "failed",
          cause: "host-key-mismatch",
          at,
        },
      ],
    }),
  );
  expect(rows(result)).toEqual([
    'access-service ok  {"routes":4}',
    `environment-route ok  {"environment":"a.example","at":"${at}"}`,
    `environment-route warn route-unreached {"environment":"b.example","cause":"host-key-mismatch","at":"${at}"}`,
    'environment-route warn route-not-configured {"environment":"c.example"}',
    'environment-route warn route-outdated {"environment":"d.example"}',
  ]);
  for (const entry of result) expect(entry.outcome).not.toBe("fail");
  expect(
    rows(routeChecks(facts({ targets: { kind: "answered", targets: [] } }))),
  ).toEqual([
    'access-service ok  {"routes":0}',
    "environment-route skipped no-routes {}",
  ]);
  // A user, or the set of keys, is part of the route too.
  expect(
    routeStanding(route("a.example"), [route("a.example", { user: "bob" })]),
  ).toBe("outdated");
  expect(
    routeStanding(route("a.example"), [
      route("a.example", {
        hostKeys: [
          { type: "ssh-ed25519", key: keyA },
          { type: "ssh-ed25519", key: keyB },
        ],
      }),
    ]),
  ).toBe("outdated");
  // The deadline is not: it moves every minute.
  expect(
    routeStanding(route("a.example"), [
      route("a.example", { validUntil: "2026-11-03T12:05:00Z" }),
    ]),
  ).toBe("current");
});

test("a service that does not answer is reported as exactly that, and no route, key or target is blamed", () => {
  for (const kind of [
    "unreachable",
    "unavailable",
    "not-recognized",
    "malformed",
  ] as const)
    expect(
      rows(
        routeChecks(
          facts({ targets: { kind }, configured: [route("a.example")] }),
        ),
      ),
    ).toEqual([`access-service warn access-service-${kind} {}`]);
});

test("without --routes nothing is asked or tried, and without a declared service every assigned Work Environment of the handover is expected", () => {
  expect(
    rows(
      routeChecks(facts({ tested: false, configured: [route("a.example")] })),
    ),
  ).toEqual([
    "access-service skipped routes-not-tested {}",
    'environment-route skipped routes-not-tested {"routes":1}',
  ]);
  expect(
    rows(
      routeChecks(
        facts({
          declared: false,
          tested: false,
          expected: [route("a.example")],
        }),
      ),
    ),
  ).toEqual([
    "access-service skipped access-service-not-declared {}",
    'environment-route skipped routes-not-tested {"routes":1}',
  ]);
  expect(rows(routeChecks(facts({ hosted: false })))).toEqual([
    "access-service skipped not-hosted {}",
  ]);
});

// The real observation path: a temporary home with the managed files the
// Platform writes, a handover binding, a fake service and a fake ssh.
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function home() {
  const path = await mkdtemp(join(tmpdir(), "lazurio-routes-doctor-"));
  homes.push(path);
  return path;
}
const uid = process.getuid?.();
const bob = assignedEnvironments(
  bindings.personalAssigned,
)[0] as EnvironmentRoute;

test("without a declared service the doctor expects the handover's assignments: a missing file is an incomplete onboarding and an old route is never tried", async () => {
  const path = await home();
  const ssh = routeSsh(path);
  const observe = (machine = bindings.personalAssigned) =>
    observeRoutes({
      home: path,
      uid,
      machine,
      routes: true,
      run: ssh.run,
      now,
    });
  // Never written (or refused, or removed): reported, not silently skipped.
  expect(rows(routeChecks(await observe()))).toEqual([
    "access-service skipped access-service-not-declared {}",
    `environment-route warn route-not-configured {"environment":"${bob.environment}"}`,
  ]);
  expect(ssh.tried).toEqual([]);
  // Written as assigned: tried and reached.
  await writeEnvironmentRoutes({ home: path, uid }, [
    bob,
    route("old.example"),
  ]);
  expect(rows(routeChecks(await observe()))).toEqual([
    "access-service skipped access-service-not-declared {}",
    `environment-route ok  {"environment":"${bob.environment}","at":"${at}"}`,
  ]);
  expect(ssh.tried).toEqual([bob.environment]);
  // The assignment is gone: the route left in the file is not tried.
  ssh.tries.length = 0;
  expect(rows(routeChecks(await observe(bindings.personalRelated)))).toEqual([
    "access-service skipped access-service-not-declared {}",
  ]);
  expect(ssh.tried).toEqual([]);
});

test("with a declared service the doctor compares the current target in full and never reports an old endpoint as reached", async () => {
  const path = await home();
  await writeEnvironmentRoutes({ home: path, uid }, [route("a.example")]);
  const ssh = routeSsh(path);
  const moved = {
    environment: "a.example",
    host: "a-new.tailnet.example.invalid",
    user: "alice",
    host_key: `ssh-ed25519 ${keyB}`,
    valid_until: "2026-11-03T12:03:30Z",
  };
  const facts = await observeRoutes({
    home: path,
    uid,
    machine: bindings.personal,
    service: { origin: "http://host.tailnet.example.invalid:8444" },
    routes: true,
    fetch: async () =>
      new Response(
        JSON.stringify({
          schema_version: "machines.access-targets.v1",
          targets: [moved],
        }),
        { status: 200 },
      ),
    run: ssh.run,
    now,
  });
  expect(rows(routeChecks(facts))).toEqual([
    'access-service ok  {"routes":1}',
    'environment-route warn route-outdated {"environment":"a.example"}',
  ]);
  expect(ssh.tried).toEqual([]);
  // Unreachable: only the service is named, and nothing is tried.
  const down = await observeRoutes({
    home: path,
    uid,
    machine: bindings.personal,
    service: { origin: "http://host.tailnet.example.invalid:8444" },
    routes: true,
    fetch: async () => {
      throw new TypeError("connection refused");
    },
    run: ssh.run,
    now,
  });
  expect(rows(routeChecks(down))).toEqual([
    "access-service warn access-service-unreachable {}",
  ]);
  expect(ssh.tried).toEqual([]);
});

test("every reason is enumerated and the context keeps only checked values", () => {
  for (const reason of [
    "access-service-not-declared",
    "access-service-unreachable",
    "access-service-unavailable",
    "access-service-not-recognized",
    "access-service-malformed",
    "routes-not-tested",
    "route-not-configured",
    "route-unreached",
    "route-outdated",
    "no-routes",
  ])
    expect(doctorReasons).toContain(reason);
  const rules = doctorContextRules;
  expect(rules.environment?.("alice.example")).toBe(true);
  expect(rules.environment?.("/etc/passwd")).toBe(false);
  expect(rules.cause?.("timeout")).toBe(true);
  expect(rules.cause?.("anything")).toBe(false);
  expect(rules.at?.(at)).toBe(true);
  expect(rules.at?.("yesterday")).toBe(false);
});
