import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAppsCommand } from "../src/agent-entry/cli";
import {
  agentEntryRelayPaths,
  handOverRefusals,
  sharedReadRefusals,
} from "../src/agent-entry/relay";
import type { WindowSeams } from "../src/browser/window";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import type { MachineBinding } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { assignmentReceiptPath } from "../src/machine/assignment";
import { machineContextPath } from "../src/machine/context";
import { unixSocketTransport } from "../src/organization-settings/relay";
import {
  type FakeRelay,
  fakeRelay,
  type RelayRequest,
} from "./fixtures/fake-relay";
import {
  binding,
  handoverEntry,
  withBrowser,
  withEnvironmentRelay,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import { commitOf, target } from "./fixtures/update-world";

// Plan LZD-0009 M9, LazurioPlatform step 1 of Lazurio Auth's contract
// `docs/agent-application-entry.md` ("The Environment browser and the
// Folder", "Required consumer proof"): `lazurio apps shared` lists the
// applications colleagues share with the user, read through the
// Environment's relay as the Environment, and `lazurio apps open` asks Auth
// through the relay for a one-time hand-over and opens its answered address
// unchanged in the thread's window of the Environment browser. The list's
// `url` is only an input, every refusal is named, and nothing is opened
// without a 200. The relay (Machines step 2) does not exist yet: a fake on a
// unix socket answers exactly as the contract says. Every name is invented.

const host = "work03.example.lazurio.io";
const browserOrigin = `https://browser.${host}`;
const { team: _team, ...withoutTeam } = organization.owner;
const work = (document: Record<string, unknown> = {}) => ({
  ...organization,
  owner: withoutTeam,
  entry: withEnvironmentRelay(withBrowser(handoverEntry(host), host)),
  ...document,
});

const inspections = {
  organization: "example",
  module: "inspections",
  name: "Inspections",
  url: "https://inspections.work01.example.lazurio.io",
  role: "user",
  host: { login: "mira", name: "Mira Example" },
};
const warehouse = {
  organization: "example",
  module: "warehouse",
  name: "Warehouse",
  url: "https://warehouse.work02.example.lazurio.io",
  role: "admin",
  host: { login: "bob" },
};
// A second colleague sharing a Module of the same slug.
const inspectionsOfBob = {
  ...inspections,
  url: "https://inspections.work02.example.lazurio.io",
  host: { login: "bob" },
};

const listAnswer = (
  sharedApplications: unknown[] = [inspections, warehouse],
  agentEntry = "on",
) =>
  Response.json(
    {
      schema: "lazurio.environment-shared-applications.v1",
      environment: "environment-work03",
      agentEntry,
      sharedApplications,
    },
    { headers: { "cache-control": "no-store" } },
  );
// 32 random bytes, base64url without padding: 43 characters.
const value = `${"A".repeat(20)}-_${"b".repeat(21)}`;
const handOverUrl = (origin: string) =>
  `${origin}/.lazurio/agent-entry?hand_over=${value}`;
const handOverAnswer = (origin: string) =>
  Response.json({ url: handOverUrl(origin), expiresIn: 60 });
const refusal = (status: number, error: string) =>
  Response.json({ error }, { status });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function relayWith(
  answer: (request: RelayRequest) => Response | Promise<Response>,
): Promise<FakeRelay> {
  const relay = await fakeRelay(answer);
  cleanups.push(() => relay.close());
  return relay;
}

const uid = process.getuid?.() ?? -1;

/** A Folder of the Environment's operator for `handover`, and the handover
 * (with the receipt, when given) under a private root the test owns, where
 * the CLI reads the assignment generation. */
async function environment(
  handover: Record<string, unknown>,
  receipt?: unknown,
  machine: MachineBinding = binding(handover),
) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "apps-cli-")));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const home = join(parent, "home");
  await mkdir(home, { mode: 0o700 });
  const folder = join(home, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = "hosted-organization-personal";
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  const root = join(parent, "machine");
  await mkdir(join(root, dirname(machineContextPath)), {
    recursive: true,
    mode: 0o755,
  });
  await chmod(root, 0o755);
  await writeFile(join(root, machineContextPath), JSON.stringify(handover), {
    mode: 0o644,
  });
  if (receipt !== undefined)
    await writeFile(
      join(root, assignmentReceiptPath),
      JSON.stringify(receipt),
      {
        mode: 0o644,
      },
    );
  const sockets = join(home, "sockets");
  await mkdir(sockets);
  return {
    home,
    folder,
    sockets,
    source: { platform: "linux", root, custodian: uid },
  };
}

// Target ids as Chrome writes them.
const OPEN = "0E".repeat(16);
const NEWTARGET = "0F".repeat(16);

/** The browser and agent-browser behind the thread's window, recording
 * every command and DevTools call. */
function windowSeams(socketDir: string, targets: string[] = []) {
  const calls: unknown[] = [];
  const seams: WindowSeams = {
    env: { HOME: "/home/operator", AGENT_BROWSER_SOCKET_DIR: socketDir },
    run: async (command) => {
      calls.push([...command]);
      return { exitCode: 0, stdout: "" };
    },
    targets: async () => new Set(targets),
    cdp: async (method, params) => {
      calls.push([method, params]);
      return { targetId: NEWTARGET };
    },
  };
  return { seams, calls };
}

type World = Awaited<ReturnType<typeof environment>>;
const context = (
  world: World,
  relay: FakeRelay | null,
  seams?: WindowSeams,
) => ({
  identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
  platform: process.platform,
  env: { HOME: world.home, CLAUDE_CODE_SESSION_ID: "019a" },
  executable: "/unused",
  hostedFolder: undefined,
  relayTransport: () =>
    unixSocketTransport(relay?.socket ?? join(world.home, "no-relay.sock")),
  machineSource: world.source,
  windowSeams: seams,
});
const json = (output: { stdout?: string }) => JSON.parse(output.stdout ?? "");

test.skipIf(process.platform === "win32" || uid === 0)(
  "apps shared: the Dashboard's list through the relay, as the Environment, in the Folder's shape",
  async () => {
    const world = await environment(work());
    const relay = await relayWith(() => listAnswer());
    const listed = await runAppsCommand(
      ["shared", "--folder", world.folder, "--json"],
      context(world, relay),
    );
    expect(listed.code).toBe(0);
    expect(json(listed)).toEqual({
      schema: "lazurio.folder.shared-applications.v1",
      kind: "shared-applications",
      agentEntry: "on",
      sharedApplications: [inspections, warehouse],
      next_steps: [],
    });
    // Exactly one read, on the relay's one path; the Folder holds no token
    // and sends none: the relay attaches the Environment's own.
    expect(relay.requests).toHaveLength(1);
    const [read] = relay.requests;
    expect(read?.method).toBe("GET");
    expect(read?.path).toBe(agentEntryRelayPaths.shared);
    expect(read?.path).toBe("/shared-applications");
    expect(read?.body).toBe("");
    expect(read?.headers.authorization).toBeUndefined();
    expect(read?.headers.cookie).toBeUndefined();

    // For people and agents: each application with the command that opens
    // it, in the Folder's language.
    const text = await runAppsCommand(
      ["shared", "--folder", world.folder],
      context(world, relay),
    );
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("Inspections");
    expect(text.stdout).toContain(
      "lazurio apps open inspections --org example",
    );
    expect(text.stdout).toContain("lazurio apps open warehouse --org example");
  },
);

test.skipIf(process.platform === "win32" || uid === 0)(
  "apps shared: switched off is an empty list with agentEntry off and the Dashboard page where the user switches it on",
  async () => {
    const world = await environment(work());
    const relay = await relayWith(() => listAnswer([], "off"));
    const listed = await runAppsCommand(
      ["shared", "--folder", world.folder, "--json"],
      context(world, relay),
    );
    expect(listed.code).toBe(0);
    const answer = json(listed);
    expect(answer.agentEntry).toBe("off");
    expect(answer.sharedApplications).toEqual([]);
    expect(answer.next_steps.join("\n")).toContain(
      "https://dashboard.lazurio.ai/orgs/example/environments",
    );
  },
);

test.skipIf(process.platform === "win32" || uid === 0)(
  "apps shared: every refusal of the read and of the relay is named, and an answer outside the contract is no list",
  async () => {
    const world = await environment(work());
    const cases: [Response | (() => Response), string][] = [
      ...sharedReadRefusals.map(
        (code) =>
          [
            refusal(
              code.startsWith("token") || code === "bearer_missing" ? 401 : 403,
              code,
            ),
            code,
          ] as [Response, string],
      ),
      [
        refusal(503, "environment_identity_unavailable"),
        "environment_identity_unavailable",
      ],
      [new Response("bad gateway", { status: 502 }), "relay-unreachable"],
      [new Response("", { status: 504 }), "relay-unreachable"],
      // A relay without this path yet (before Machines step 2).
      [new Response("", { status: 404 }), "relay-unsupported"],
      [Response.json({ schema: "something-else" }), "relay-answer-invalid"],
      [
        Response.json({
          schema: "lazurio.environment-shared-applications.v1",
          environment: "environment-work03",
          agentEntry: "on",
          sharedApplications: [
            { ...inspections, url: "http://inspections.example" },
          ],
        }),
        "relay-answer-invalid",
      ],
      [refusal(418, "something_new"), "refused"],
    ];
    expect(sharedReadRefusals).toEqual([
      "bearer_missing",
      "token_expired",
      "token_invalid",
      "scope_not_allowed_here",
      "insufficient_scope",
      "environment_unknown",
    ]);
    for (const [answer, reason] of cases) {
      const relay = await relayWith(() =>
        typeof answer === "function" ? answer() : answer.clone(),
      );
      const refused = await runAppsCommand(
        ["shared", "--folder", world.folder, "--json"],
        context(world, relay),
      );
      expect(refused.code).toBe(2);
      const body = json(refused);
      expect(body.kind).toBe("blocked");
      expect(body.reason).toBe(reason);
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(20);
      expect(Array.isArray(body.next_steps)).toBe(true);
      // Without --json the code and its meaning go to stderr.
      const text = await runAppsCommand(
        ["shared", "--folder", world.folder],
        context(world, relay),
      );
      expect(text.code).toBe(2);
      expect(text.stderr).toContain(`(${reason})`);
    }
    // The relay's socket is not there: it did not answer.
    const silent = await runAppsCommand(
      ["shared", "--folder", world.folder, "--json"],
      context(world, null),
    );
    expect(json(silent).reason).toBe("relay-unreachable");
  },
);

test.skipIf(process.platform === "win32" || uid === 0)(
  "apps open: the hand-over asked with the list's origin and the bound generation, its answered address opened unchanged in a new window",
  async () => {
    const world = await environment(work());
    const relay = await relayWith((request) =>
      request.path === agentEntryRelayPaths.shared
        ? listAnswer()
        : handOverAnswer(inspections.url),
    );
    const { seams, calls } = windowSeams(world.sockets);
    const opened = await runAppsCommand(
      [
        "open",
        "inspections",
        "--org",
        "example",
        "--folder",
        world.folder,
        "--json",
      ],
      context(world, relay, seams),
    );
    expect(opened.code).toBe(0);
    expect(json(opened)).toEqual({
      schema: "lazurio.folder.shared-applications.v1",
      kind: "shared-application-opened",
      organization: "example",
      module: "inspections",
      name: "Inspections",
      url: inspections.url,
      role: "user",
      session: "claude-019a",
      targetId: NEWTARGET,
      link: `${browserOrigin}/t/${NEWTARGET}`,
      command: "agent-browser --cdp 9222 --session claude-019a",
    });
    // The list first, then exactly one hand-over: POST, JSON, the entry's
    // origin and the generation of a Work Environment without a receipt
    // (a `v2` one, which names null). No token from the Folder.
    expect(
      relay.requests.map((request) => [request.method, request.path]),
    ).toEqual([
      ["GET", "/shared-applications"],
      ["POST", "/agent-entry/hand-over"],
    ]);
    const asked = relay.requests[1] as RelayRequest;
    expect(asked.headers["content-type"]).toBe("application/json");
    expect(asked.headers.authorization).toBeUndefined();
    expect(JSON.parse(asked.body)).toEqual({
      origin: inspections.url,
      generation: null,
    });
    // The answered address, unchanged, is the new window's first page; the
    // list's own address is never opened.
    const created = calls.find(
      (call) => Array.isArray(call) && call[0] === "Target.createTarget",
    ) as [string, { url: string }];
    expect(created[1].url).toBe(handOverUrl(inspections.url));
    expect(JSON.stringify(calls)).not.toContain(`"${inspections.url}"`);
    // The one-time value is never printed.
    expect(opened.stdout).not.toContain(value);
    expect(opened.stderr ?? "").not.toContain(value);
  },
);

test.skipIf(process.platform === "win32" || uid === 0)(
  "apps open: the thread's open window goes to the answered address with agent-browser's own navigation",
  async () => {
    const world = await environment(work());
    await writeFile(
      join(world.sockets, "claude-019a.target"),
      JSON.stringify({ targetId: OPEN, url: "about:blank", pinned: true }),
    );
    const relay = await relayWith((request) =>
      request.path === agentEntryRelayPaths.shared
        ? listAnswer()
        : handOverAnswer(warehouse.url),
    );
    const { seams, calls } = windowSeams(world.sockets, [OPEN]);
    const opened = await runAppsCommand(
      [
        "open",
        "warehouse",
        "--org",
        "example",
        "--folder",
        world.folder,
        "--json",
      ],
      context(world, relay, seams),
    );
    expect(opened.code).toBe(0);
    expect(json(opened).targetId).toBe(OPEN);
    expect(calls).toEqual([
      [
        "/home/operator/.local/bin/agent-browser",
        "--cdp",
        "9222",
        "--session",
        "claude-019a",
        "open",
        handOverUrl(warehouse.url),
      ],
    ]);
  },
);

test.skipIf(process.platform === "win32" || uid === 0)(
  "apps open: a stock Environment names the generation its receipt bound",
  async () => {
    // A free work Environment's handover (root decision 0216): auth-sourced,
    // its person and generation in the receipt the finisher wrote.
    const pointer = {
      path: "/etc/lazurio/assignment.json",
      schema_version: "lazurio.assignment.v1",
    };
    const handover = {
      ...organization,
      machine: {
        id: "example-work-03",
        kind: "workspace-vm",
        name: "work-03",
        vmid: 903,
      },
      owner: {
        ...withoutTeam,
        assignment: { kind: "operator", source: "auth" },
      },
      assignment_receipt: pointer,
      operator: {
        os_user: "work-03",
        home: "/home/work-03",
        lazurio_root: "/home/work-03/Lazurio",
      },
      entry: withEnvironmentRelay(
        withBrowser(
          handoverEntry("{dns_slug}.example.lazurio.io"),
          "{dns_slug}.example.lazurio.io",
        ),
      ),
    };
    const subject = "https://auth.example.invalid/realms/workspace/0000-0003";
    const receipt = {
      schema_version: "lazurio.assignment.v1",
      environment: "example-work-03",
      state: "assigned",
      generation: 6,
      first: { generation: 4, subject, github_id: 4243 },
      current: {
        generation: 6,
        assignee: { subject, github_id: 4243, github_login: "Cyril-Example" },
      },
      dns_slug: "cyril",
      organization: "example",
      account: "cyril",
      hostname: "cyril-example-vm",
    };
    // The Folder as the assigned Environment's operator holds it.
    const world = await environment(handover, receipt, binding(work()));
    const relay = await relayWith((request) =>
      request.path === agentEntryRelayPaths.shared
        ? listAnswer()
        : handOverAnswer(inspections.url),
    );
    const { seams } = windowSeams(world.sockets);
    const opened = await runAppsCommand(
      [
        "open",
        "inspections",
        "--org",
        "example",
        "--folder",
        world.folder,
        "--json",
      ],
      context(world, relay, seams),
    );
    expect(opened.code).toBe(0);
    expect(JSON.parse(relay.requests[1]?.body ?? "")).toEqual({
      origin: inspections.url,
      generation: 6,
    });

    // Before the finisher bound anybody there is nobody to act for: nothing
    // is asked.
    const pending = await environment(handover, undefined, binding(work()));
    const quiet = await relayWith(() => listAnswer());
    const refused = await runAppsCommand(
      [
        "open",
        "inspections",
        "--org",
        "example",
        "--folder",
        pending.folder,
        "--json",
      ],
      context(pending, quiet, windowSeams(pending.sockets).seams),
    );
    expect(refused.code).toBe(2);
    expect(json(refused).reason).toBe("assignment-pending");
    expect(
      quiet.requests.filter((request) => request.method === "POST"),
    ).toEqual([]);
  },
);

test.skipIf(process.platform === "win32" || uid === 0)(
  "apps open: every refusal of the hand-over is named and nothing is opened without a 200 carrying the hand-over of exactly that origin",
  async () => {
    const world = await environment(work());
    expect<string[]>([...handOverRefusals].sort()).toEqual(
      [
        "invalid_request",
        "unauthorized",
        "not_found",
        "agent_entry_identity_absent",
        "environment_state_conflict",
        "assignment_generation_conflict",
        "agent_entry_off",
        "agent_entry_own_environment",
        "agent_entry_other_organization",
        "agent_entry_not_member",
        "application_record_inconsistent",
        "agent_entry_no_role",
        "management_temporarily_unavailable",
      ].sort(),
    );
    const statusOf: Record<string, number> = {
      invalid_request: 400,
      unauthorized: 401,
      not_found: 404,
      agent_entry_no_role: 403,
      agent_entry_not_member: 403,
      agent_entry_off: 403,
      agent_entry_other_organization: 403,
      agent_entry_own_environment: 409,
      agent_entry_identity_absent: 409,
      assignment_generation_conflict: 409,
      environment_state_conflict: 409,
      application_record_inconsistent: 503,
      management_temporarily_unavailable: 503,
    };
    const prefix = `${inspections.url}/.lazurio/agent-entry?hand_over=`;
    const cases: [() => Response, string][] = [
      ...handOverRefusals.map(
        (code) =>
          [() => refusal(statusOf[code] as number, code), code] as [
            () => Response,
            string,
          ],
      ),
      [
        () => refusal(503, "environment_identity_unavailable"),
        "environment_identity_unavailable",
      ],
      [() => new Response("", { status: 502 }), "relay-unreachable"],
      [() => new Response("", { status: 404 }), "relay-unsupported"],
      [() => refusal(429, "slow_down"), "refused"],
      // Not a 200: a redirect or another success opens nothing.
      [
        () =>
          new Response("", {
            status: 302,
            headers: { location: handOverUrl(inspections.url) },
          }),
        "relay-answer-invalid",
      ],
      [
        () =>
          Response.json(
            { url: handOverUrl(inspections.url), expiresIn: 60 },
            { status: 201 },
          ),
        "relay-answer-invalid",
      ],
      // A 200 whose address is not the hand-over of exactly the origin asked.
      [() => handOverAnswer(warehouse.url), "relay-answer-invalid"],
      [
        () => handOverAnswer(`${inspections.url}.evil.example`),
        "relay-answer-invalid",
      ],
      [
        () => Response.json({ url: `${prefix}short`, expiresIn: 60 }),
        "relay-answer-invalid",
      ],
      [
        () =>
          Response.json({ url: `${prefix}${value}&next=/x`, expiresIn: 60 }),
        "relay-answer-invalid",
      ],
      [
        () =>
          Response.json({
            url: `${inspections.url}/somewhere?hand_over=${value}`,
            expiresIn: 60,
          }),
        "relay-answer-invalid",
      ],
      [
        () => Response.json({ url: inspections.url, expiresIn: 60 }),
        "relay-answer-invalid",
      ],
      [() => Response.json({ expiresIn: 60 }), "relay-answer-invalid"],
      [() => new Response("not json", { status: 200 }), "relay-answer-invalid"],
    ];
    for (const [answer, reason] of cases) {
      const relay = await relayWith((request) =>
        request.path === agentEntryRelayPaths.shared ? listAnswer() : answer(),
      );
      const { seams, calls } = windowSeams(world.sockets);
      const refused = await runAppsCommand(
        [
          "open",
          "inspections",
          "--org",
          "example",
          "--folder",
          world.folder,
          "--json",
        ],
        context(world, relay, seams),
      );
      expect([reason, refused.code]).toEqual([reason, 2]);
      const body = json(refused);
      expect(body.kind).toBe("blocked");
      expect(body.reason).toBe(reason);
      expect(body.message.length).toBeGreaterThan(20);
      // Nothing opened, no window touched.
      expect([reason, calls]).toEqual([reason, []]);
      expect(refused.stdout).not.toContain(value);
      if (reason === "agent_entry_off")
        expect(body.next_steps.join("\n")).toContain(
          "https://dashboard.lazurio.ai/orgs/example/environments",
        );
    }
  },
);

test.skipIf(process.platform === "win32" || uid === 0)(
  "apps open: only an application of the list, one colleague's by --host where several share it, and never asked without the thread's window",
  async () => {
    const world = await environment(work());
    const relay = await relayWith((request) =>
      request.path === agentEntryRelayPaths.shared
        ? listAnswer([inspections, inspectionsOfBob, warehouse])
        : handOverAnswer(JSON.parse(request.body).origin),
    );
    const posts = () =>
      relay.requests.filter((request) => request.method === "POST").length;
    const run = (args: string[], seams = windowSeams(world.sockets).seams) =>
      runAppsCommand(
        [...args, "--folder", world.folder, "--json"],
        context(world, relay, seams),
      );

    // Not in the list: a name the user has no application of, or another
    // Organization's.
    for (const args of [
      ["open", "ledger", "--org", "example"],
      ["open", "warehouse", "--org", "other-example"],
    ]) {
      const refused = await run(args);
      expect(refused.code).toBe(2);
      expect(json(refused).reason).toBe("not-shared");
      expect(json(refused).next_steps.join("\n")).toContain(
        "lazurio apps shared",
      );
    }
    // Two colleagues share inspections: --host chooses, never a guess.
    const ambiguous = await run(["open", "inspections", "--org", "example"]);
    expect(json(ambiguous).reason).toBe("host-ambiguous");
    expect(json(ambiguous).next_steps.join("\n")).toContain(
      "lazurio apps open inspections --org example --host mira",
    );
    expect(json(ambiguous).next_steps.join("\n")).toContain("--host bob");
    expect(posts()).toBe(0);
    const chosen = await run([
      "open",
      "inspections",
      "--org",
      "example",
      "--host",
      "Bob",
    ]);
    expect(chosen.code).toBe(0);
    expect(json(chosen).url).toBe(inspectionsOfBob.url);
    expect(JSON.parse(relay.requests.at(-1)?.body ?? "").origin).toBe(
      inspectionsOfBob.url,
    );

    // Without a session there is no window to open it in: nothing is asked.
    const before = posts();
    const noSession = await runAppsCommand(
      [
        "open",
        "warehouse",
        "--org",
        "example",
        "--folder",
        world.folder,
        "--json",
      ],
      {
        ...context(world, relay, windowSeams(world.sockets).seams),
        env: { HOME: world.home },
      },
    );
    expect(noSession.code).toBe(2);
    expect(json(noSession).reason).toBe("no-session");
    expect(posts()).toBe(before);

    // Usage.
    for (const args of [
      ["open", "inspections"],
      ["open", "--org", "example"],
      ["open", "inspections", "--org", "example", "--org", "example"],
      ["shared", "extra"],
      ["list"],
      [],
    ]) {
      const usage = await runAppsCommand(args, context(world, relay));
      expect([args, usage.code]).toEqual([args, 2]);
    }
  },
);

// Pablo's review of #948: two entries of one Module where one names no
// host login, or two origins shared by the same login, must each be
// selectable; a person could otherwise share an application their agent
// can never open. `--host` where the login tells them apart, else
// `--origin` with the entry's exact `url`, which is only a selector among
// the list's entries.
test.skipIf(process.platform === "win32" || uid === 0)(
  "every listed application can be chosen: --host where its login tells it apart, --origin with the entry's url where it does not",
  async () => {
    const world = await environment(work());
    const nobody = {
      ...inspections,
      url: "https://inspections.work04.example.lazurio.io",
      host: { login: null },
    };
    const bobFirst = { ...warehouse };
    const bobSecond = {
      ...warehouse,
      url: "https://warehouse.work05.example.lazurio.io",
    };
    const relay = await relayWith((request) =>
      request.path === agentEntryRelayPaths.shared
        ? listAnswer([inspections, nobody, bobFirst, bobSecond])
        : handOverAnswer(JSON.parse(request.body).origin),
    );
    const asked = () =>
      relay.requests
        .filter((request) => request.method === "POST")
        .map((request) => JSON.parse(request.body).origin);
    const run = (args: readonly string[]) =>
      runAppsCommand(
        [...args, "--folder", world.folder, "--json"],
        context(world, relay, windowSeams(world.sockets).seams),
      );
    const command = (line: string) =>
      line.replace(/^lazurio apps /, "").split(" ");

    // The list names one command per entry, each choosing exactly it.
    const listed = await runAppsCommand(
      ["shared", "--folder", world.folder],
      context(world, relay),
    );
    const commands = (listed.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("lazurio apps open"));
    expect(commands).toEqual([
      "lazurio apps open inspections --org example --host mira",
      `lazurio apps open inspections --org example --origin ${nobody.url}`,
      `lazurio apps open warehouse --org example --origin ${bobFirst.url}`,
      `lazurio apps open warehouse --org example --origin ${bobSecond.url}`,
    ]);
    for (const [index, line] of commands.entries()) {
      const opened = await run(command(line));
      expect([line, opened.code]).toEqual([line, 0]);
      expect(asked().at(-1)).toBe(
        [inspections, nobody, bobFirst, bobSecond][index]?.url,
      );
    }

    // A refusal for an ambiguous name gives the same commands.
    const ambiguous = await run(["open", "inspections", "--org", "example"]);
    expect(json(ambiguous).reason).toBe("host-ambiguous");
    expect(json(ambiguous).next_steps).toEqual(
      expect.arrayContaining(commands.slice(0, 2)),
    );
    const sameLogin = await run([
      "open",
      "warehouse",
      "--org",
      "example",
      "--host",
      "bob",
    ]);
    expect(json(sameLogin).reason).toBe("host-ambiguous");
    expect(json(sameLogin).next_steps).toEqual(
      expect.arrayContaining(commands.slice(2)),
    );

    // --origin is only a selector: an origin the list does not have opens
    // nothing, and anything but an exact origin is a usage error.
    const before = asked().length;
    const unknown = await run([
      "open",
      "warehouse",
      "--org",
      "example",
      "--origin",
      "https://warehouse.work09.example.lazurio.io",
    ]);
    expect(json(unknown).reason).toBe("not-shared");
    for (const origin of [
      `${bobSecond.url}/`,
      `${bobSecond.url}/path`,
      "http://warehouse.work05.example.lazurio.io",
      "warehouse.work05.example.lazurio.io",
    ])
      expect(
        (
          await run([
            "open",
            "warehouse",
            "--org",
            "example",
            "--origin",
            origin,
          ])
        ).code,
      ).toBe(2);
    expect(
      (
        await runAppsCommand(
          ["shared", "--origin", bobSecond.url],
          context(world, relay),
        )
      ).code,
    ).toBe(2);
    expect(asked().length).toBe(before);
  },
);

test.skipIf(process.platform === "win32" || uid === 0)(
  "without the relay or the Environment browser nothing is asked or opened",
  async () => {
    // No relay recorded in the handover's entry.
    const noRelay = await environment(
      work({ entry: withBrowser(handoverEntry(host), host) }),
    );
    const relay = await relayWith(() => listAnswer());
    for (const args of [
      ["shared"],
      ["open", "inspections", "--org", "example"],
    ]) {
      const answer = await runAppsCommand(
        [...args, "--folder", noRelay.folder, "--json"],
        context(noRelay, relay, windowSeams(noRelay.sockets).seams),
      );
      expect(answer.code).toBe(10);
      expect(json(answer).reason).toBe("relay-absent");
    }
    // A relay, but no Environment browser: no hand-over is minted that
    // could not be opened.
    const noBrowser = await environment(
      work({ entry: withEnvironmentRelay(handoverEntry(host)) }),
    );
    const open = await runAppsCommand(
      [
        "open",
        "inspections",
        "--org",
        "example",
        "--folder",
        noBrowser.folder,
        "--json",
      ],
      context(noBrowser, relay, windowSeams(noBrowser.sockets).seams),
    );
    expect(open.code).toBe(10);
    expect(json(open).reason).toBe("no-browser");
    expect(relay.requests).toEqual([]);
  },
);
