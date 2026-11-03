import { expect, test } from "bun:test";
import {
  doctorContextRules,
  doctorReasons,
  type RouteFacts,
  routeChecks,
} from "../src/doctor/doctor";
import type { AccessTarget } from "../src/ssh-access/access-service";
import { routeCause, testRoutes } from "../src/ssh-access/routes";
import type { ToolRunner } from "../src/tools/status";

// Onboarding and the doctor try every route of root decision 0224 (plan
// DEV-6687 M7, decision F70's addendum): `ssh -o BatchMode=yes <id> true`
// through the managed config, each result with its cause and time. While
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

test("each route is tried non-interactively and bounded, as an agent uses it, with the time it was observed", async () => {
  const calls: (readonly string[])[] = [];
  const answers: Record<string, Awaited<ReturnType<ToolRunner>>> = {
    "a.example": { exitCode: 0, stdout: "", stderr: "" },
    "b.example": {
      exitCode: 255,
      stdout: "",
      stderr: "b@h: Permission denied (publickey).",
    },
    "c.example": "timeout",
  };
  const run: ToolRunner = async (command, timeoutMs, env) => {
    calls.push(command);
    expect(timeoutMs).toBeGreaterThan(10_000);
    expect(env.HOME).toBe("/home/someone");
    return answers[command.at(-2) as string] ?? "timeout";
  };
  const results = await testRoutes(
    ["a.example", "b.example", "c.example", "d.example", "e.example"],
    "/home/someone",
    run,
    now,
  );
  expect(results).toEqual([
    { environment: "a.example", result: "reached", at },
    {
      environment: "b.example",
      result: "failed",
      cause: "login-refused",
      at,
    },
    { environment: "c.example", result: "failed", cause: "timeout", at },
    { environment: "d.example", result: "failed", cause: "timeout", at },
    { environment: "e.example", result: "failed", cause: "timeout", at },
  ]);
  expect(calls[0]).toEqual([
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-n",
    "-T",
    "a.example",
    "true",
  ]);
  // Nothing in the command forwards, jumps or accepts a key.
  for (const command of calls)
    expect(command.join(" ")).not.toMatch(
      /-A|-J|ProxyJump|ForwardAgent|StrictHostKeyChecking|accept-new/,
    );
});

const target = (environment: string): AccessTarget => ({
  environment,
  host: `${environment.replace(".", "-")}.tailnet.example.invalid`,
  user: "alice",
  hostKeys: [{ type: "ssh-ed25519", key: "AAAA" }],
  validUntil: "2026-11-03T12:03:30Z",
});
const facts = (overrides: Partial<RouteFacts>): RouteFacts => ({
  hosted: true,
  declared: true,
  tested: true,
  targets: null,
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

test("while the service answers, every route it gives must be configured and reached; one that is not needs attention", () => {
  const result = routeChecks(
    facts({
      targets: {
        kind: "answered",
        targets: [
          target("a.example"),
          target("b.example"),
          target("c.example"),
        ],
      },
      configured: ["a.example", "b.example"],
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
    'access-service ok  {"routes":3}',
    `environment-route ok  {"environment":"a.example","at":"${at}"}`,
    `environment-route warn route-unreached {"environment":"b.example","cause":"host-key-mismatch","at":"${at}"}`,
    'environment-route warn route-not-configured {"environment":"c.example"}',
  ]);
  for (const entry of result) expect(entry.outcome).not.toBe("fail");
  expect(
    rows(routeChecks(facts({ targets: { kind: "answered", targets: [] } }))),
  ).toEqual([
    'access-service ok  {"routes":0}',
    "environment-route skipped no-routes {}",
  ]);
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
          facts({
            targets: { kind },
            configured: ["a.example"],
            tests: [],
          }),
        ),
      ),
    ).toEqual([`access-service warn access-service-${kind} {}`]);
});

test("without --routes nothing is asked or tried, and without a declared service the handover's routes are tried as they are", () => {
  expect(
    rows(routeChecks(facts({ tested: false, configured: ["a.example"] }))),
  ).toEqual([
    "access-service skipped routes-not-tested {}",
    'environment-route skipped routes-not-tested {"routes":1}',
  ]);
  expect(
    rows(
      routeChecks(
        facts({ declared: false, tested: false, configured: ["a.example"] }),
      ),
    ),
  ).toEqual([
    "access-service skipped access-service-not-declared {}",
    'environment-route skipped routes-not-tested {"routes":1}',
  ]);
  expect(
    rows(
      routeChecks(
        facts({
          declared: false,
          configured: ["a.example"],
          tests: [
            {
              environment: "a.example",
              result: "failed",
              cause: "timeout",
              at,
            },
          ],
        }),
      ),
    ),
  ).toEqual([
    "access-service skipped access-service-not-declared {}",
    `environment-route warn route-unreached {"environment":"a.example","cause":"timeout","at":"${at}"}`,
  ]);
  expect(rows(routeChecks(facts({ hosted: false })))).toEqual([
    "access-service skipped not-hosted {}",
  ]);
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
