import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineUsageError, parseMachineArguments } from "../src/machine/cli";
import {
  linkClientPrefix,
  parsePairing,
  parseSessions,
  parseT3LinksState,
  renewBeforeMs,
  retryAfterMs,
  runT3Links,
  syncT3Links,
  type T3LinkSeams,
  t3LinkOrigin,
  t3LinkRole,
  t3LinksStatePath,
} from "../src/t3-links/links";
import {
  chatT3Label,
  environmentLabel,
  loopbackOrigin,
} from "../src/t3-links/live";
import {
  linkedEnvironmentsOn,
  setLinkedEnvironments,
} from "../src/t3-links/settings";
import type { ToolRunner } from "../src/tools/status";
import { bindings } from "./fixtures/machine-bindings";

// The links between T3 Code servers along the edge (root decision 0157,
// amended 2026-11-17; `src/t3-links/`). T3 Code on both ends is a fake that
// answers as `t3` does (Lazurio/t3code `cli/environment.ts`, `cli/auth.ts`,
// `cliAuthFormat.ts`); SSH to the target is that fake behind `ssh <id>`.
// Every fixture is synthetic.

const uid = process.getuid?.();
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

const target = "lazurio-bob.lazurioexampleorganization";
const origin = `https://t3code.${target}.lazurio.io`;
const day = 24 * 60 * 60_000;
const start = Date.parse("2026-11-18T00:00:00.000Z");

async function home(settings: unknown = { theme: "dark" }) {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-t3-links-"));
  homes.push(directory);
  await mkdir(join(directory, ".t3", "userdata"), { recursive: true });
  if (settings !== undefined)
    await writeFile(
      join(directory, ".t3", "userdata", "settings.json"),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  return directory;
}

type Session = {
  sessionId: string;
  subject: string;
  client: { label: string };
};
type Link = {
  environmentId: string;
  label: string;
  urls: string[];
  access: string;
  linkedAt: string;
  expiresAt: string;
  lastReachedAt: string;
  lastError: string | null;
  status: string;
};

/** Both ends of one link as T3 Code would answer, and every command run. */
function world(now: () => number) {
  const state = {
    targetSessions: [
      {
        sessionId: randomUUID(),
        subject: "browser-session",
        client: { label: "Chrome" },
      },
    ] as Session[],
    pairings: new Map<string, string>(),
    links: [] as Link[],
    localSessions: [] as Session[],
    commands: [] as {
      command: readonly string[];
      env: Record<string, string>;
    }[],
    linkRefuses: false,
    sshDown: false,
    sessionsVisible: true,
    issued: [] as string[],
  };
  const answer = (stdout: string, exitCode = 0) => ({
    exitCode,
    stdout,
    stderr: "",
  });
  const sessionsJson = (sessions: Session[]) =>
    `${JSON.stringify(
      sessions.map((session) => ({
        ...session,
        method: "bearer-access-token",
        scopes: [],
        connected: false,
        issuedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + 30 * day).toISOString(),
        lastConnectedAt: null,
      })),
      null,
      2,
    )}\n`;
  const run: ToolRunner = async (command, _timeout, env) => {
    state.commands.push({ command, env: { ...env } });
    if (command[0] === "ssh") {
      if (state.sshDown) return answer("", 255);
      const remote = (command.at(-1) as string).split(" ");
      expect(remote[0]).toBe('"$HOME/.local/bin/t3"');
      const verb = remote.slice(1, 4).join(" ");
      const last = remote.at(-1) as string;
      if (verb === "auth session list")
        return answer(
          sessionsJson(state.sessionsVisible ? state.targetSessions : []),
        );
      if (verb === "auth pairing create") {
        const id = randomUUID();
        const credential = `pc-${randomUUID()}`;
        state.pairings.set(id, credential);
        state.issued.push(credential);
        return answer(
          `${JSON.stringify({ id, credential, label: "lazurio-link", scopes: [], expiresAt: "x" }, null, 2)}\n`,
        );
      }
      if (verb === "auth pairing revoke") {
        state.pairings.delete(last);
        return answer("Revoked.\n");
      }
      if (verb === "auth session revoke") {
        state.targetSessions = state.targetSessions.filter(
          (session) => session.sessionId !== last,
        );
        return answer("Revoked.\n");
      }
      return answer("", 1);
    }
    const args = command.slice(1);
    const verb = args.slice(0, 2).join(" ");
    if (verb === "environment list")
      return answer(`${JSON.stringify(state.links)}\n`);
    if (verb === "environment link") {
      const code = args[args.indexOf("--pairing-code") + 1] as string;
      const url = args.at(-1) as string;
      const id = [...state.pairings].find(([, value]) => value === code)?.[0];
      if (state.linkRefuses || id === undefined)
        return { exitCode: 1, stdout: "", stderr: "PeerLinkError: refused" };
      state.pairings.delete(id);
      state.targetSessions.push({
        sessionId: randomUUID(),
        subject: "mcp-client",
        client: { label: `${linkClientPrefix}${env.T3CODE_ENVIRONMENT_LABEL}` },
      });
      const existing = state.links.find((link) => link.urls.includes(url));
      const link: Link = {
        environmentId: existing?.environmentId ?? randomUUID(),
        label: "Example / lazurio-bob",
        urls: [url],
        access: "full-access",
        linkedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + 30 * day).toISOString(),
        lastReachedAt: new Date(now()).toISOString(),
        lastError: null,
        status: "reachable",
      };
      state.links = [
        ...state.links.filter((found) => found !== existing),
        link,
      ];
      return answer(`Linked ${link.label}.\n`);
    }
    if (verb === "environment unlink") {
      state.links = state.links.filter(
        (link) => link.environmentId !== args.at(-1),
      );
      return answer("Forgot.\n");
    }
    if (verb === "auth session") {
      if (args[2] === "list") return answer(sessionsJson(state.localSessions));
      if (args[2] === "revoke") {
        state.localSessions = state.localSessions.filter(
          (session) => session.sessionId !== args.at(-1),
        );
        return answer("Revoked.\n");
      }
    }
    return answer("", 1);
  };
  return { state, run };
}

function seams(
  directory: string,
  run: ToolRunner,
  now: () => number,
): T3LinkSeams {
  return {
    run,
    now,
    home: directory,
    uid,
    path: "/usr/bin",
    t3: "/opt/t3",
    label: async () => "lazurio-bob",
  };
}

const readSettingsFile = async (directory: string) =>
  JSON.parse(
    await readFile(join(directory, ".t3", "userdata", "settings.json"), "utf8"),
  );
const readState = async (directory: string) =>
  readFile(t3LinksStatePath(directory), "utf8");

test("each end finds its role in its own handover only", () => {
  const source = t3LinkRole(bindings.personalAssigned);
  expect(source.kind).toBe("source");
  if (source.kind === "source")
    expect(source.targets.map((entry) => entry.environment)).toEqual([target]);
  expect(t3LinkRole(bindings.related)).toEqual({
    kind: "target",
    sources: ["example"],
  });
  expect(t3LinkRole(bindings.organization)).toEqual({
    kind: "target",
    sources: [],
  });
  expect(t3LinkRole(bindings.personal)).toEqual({
    kind: "source",
    targets: [],
  });
  expect(t3LinkRole(null)).toEqual({ kind: "none" });
  expect(t3LinkOrigin(target)).toBe(origin);
  expect(t3LinkOrigin("bob;rm -rf ~")).toBeNull();
});

test("the switch: on adds one member, off removes it, everything else stays", async () => {
  const directory = await home({ theme: "dark", providerInstances: {} });
  expect(await setLinkedEnvironments(directory, true)).toBe("written");
  expect(await readSettingsFile(directory)).toEqual({
    theme: "dark",
    providerInstances: {},
    linkedEnvironmentsEnabled: true,
  });
  expect(await setLinkedEnvironments(directory, true)).toBe("unchanged");
  expect(await linkedEnvironmentsOn(directory)).toBe(true);
  expect(await setLinkedEnvironments(directory, false)).toBe("written");
  expect(await readSettingsFile(directory)).toEqual({
    theme: "dark",
    providerInstances: {},
  });
  expect(await setLinkedEnvironments(directory, false)).toBe("unchanged");
});

test("the switch leaves a file T3 Code keeps for the person alone, and creates no T3 home", async () => {
  const directory = await home(undefined);
  const path = join(directory, ".t3", "userdata", "settings.json");
  await writeFile(path, '{ // the person\'s\n "theme": "dark" }\n');
  expect(await setLinkedEnvironments(directory, true)).toBe("unsafe");
  expect(await readFile(path, "utf8")).toContain("the person's");
  const bare = await mkdtemp(join(tmpdir(), "lazurio-t3-links-"));
  homes.push(bare);
  expect(await setLinkedEnvironments(bare, true)).toBe("absent");
  await expect(stat(join(bare, ".t3"))).rejects.toThrow();
});

test("the source links once, inside the edge, and a second look changes nothing", async () => {
  const directory = await home();
  let now = start;
  const { state, run } = world(() => now);
  const first = await syncT3Links(
    seams(directory, run, () => now),
    bindings.personalAssigned,
  );
  expect(first).toMatchObject({
    role: "source",
    result: "synced",
    setting: "written",
    links: [{ environment: target, result: "linked", revoked: 0 }],
  });
  expect((await readSettingsFile(directory)).linkedEnvironmentsEnabled).toBe(
    true,
  );
  // One session of the link on the target, labelled by the running Chat.
  expect(
    state.targetSessions.filter((session) => session.subject === "mcp-client"),
  ).toHaveLength(1);
  const link = state.commands.find((entry) => entry.command[2] === "link");
  expect(link?.env.T3CODE_ENVIRONMENT_LABEL).toBe("lazurio-bob");
  expect(link?.command).toContain("full-access");
  expect(link?.command.at(-1)).toBe(origin);
  // Every target command goes over the managed route, non-interactively.
  for (const entry of state.commands.filter(
    (entry) => entry.command[0] === "ssh",
  ))
    expect(entry.command.slice(0, 8)).toEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "--",
      target,
    ]);
  const recorded = parseT3LinksState(JSON.parse(await readState(directory)));
  expect(recorded?.enabledByLazurio).toBe(true);
  expect(Object.keys(recorded?.links ?? {})).toEqual([target]);
  expect((await stat(t3LinksStatePath(directory))).mode & 0o777).toBe(0o600);

  state.commands.length = 0;
  now += day;
  const second = await syncT3Links(
    seams(directory, run, () => now),
    bindings.personalAssigned,
  );
  expect(second).toMatchObject({
    setting: "unchanged",
    links: [{ environment: target, result: "current" }],
  });
  // Only the local list: no SSH, no pairing.
  expect(
    state.commands.map((entry) => entry.command.slice(1, 3).join(" ")),
  ).toEqual(["environment list"]);
});

test("the pairing code goes only onto the one command that spends it", async () => {
  const directory = await home();
  const now = () => start;
  const { state, run } = world(now);
  const report = await syncT3Links(
    seams(directory, run, now),
    bindings.personalAssigned,
  );
  expect(state.issued).toHaveLength(1);
  const code = state.issued[0] as string;
  const carrying = state.commands.filter((entry) =>
    JSON.stringify(entry).includes(code),
  );
  expect(carrying).toHaveLength(1);
  expect(carrying[0]?.command.slice(1, 3)).toEqual(["environment", "link"]);
  expect(JSON.stringify(report)).not.toContain(code);
  expect(await readState(directory)).not.toContain(code);
  expect(JSON.stringify(await readSettingsFile(directory))).not.toContain(code);
});

test("renewal before seven days are left keeps exactly one session on the target", async () => {
  const directory = await home();
  let now = start;
  const { state, run } = world(() => now);
  await syncT3Links(
    seams(directory, run, () => now),
    bindings.personalAssigned,
  );
  const firstSession = state.targetSessions.find(
    (session) => session.subject === "mcp-client",
  )?.sessionId;
  now += 30 * day - renewBeforeMs + 60_000;
  const renewed = await syncT3Links(
    seams(directory, run, () => now),
    bindings.personalAssigned,
  );
  expect(renewed).toMatchObject({
    links: [{ environment: target, result: "renewed", revoked: 1 }],
  });
  const linkSessions = state.targetSessions.filter(
    (session) => session.subject === "mcp-client",
  );
  expect(linkSessions).toHaveLength(1);
  expect(linkSessions[0]?.sessionId).not.toBe(firstSession);
  // The person's own sessions on the target are never touched.
  expect(
    state.targetSessions.some(
      (session) => session.subject === "browser-session",
    ),
  ).toBe(true);
  expect(state.links).toHaveLength(1);
});

test("a revoked link is linked again, and an old session stays when the new one is not seen", async () => {
  const directory = await home();
  let now = start;
  const { state, run } = world(() => now);
  await syncT3Links(
    seams(directory, run, () => now),
    bindings.personalAssigned,
  );
  (state.links[0] as Link).lastError =
    "The linked environment no longer accepts this link.";
  state.sessionsVisible = false;
  now += day;
  const report = await syncT3Links(
    seams(directory, run, () => now),
    bindings.personalAssigned,
  );
  expect(report).toMatchObject({
    links: [{ environment: target, result: "renewed", revoked: 0 }],
  });
  expect(
    state.commands.some((entry) =>
      String(entry.command.at(-1)).includes("session revoke"),
    ),
  ).toBe(false);
});

test("a refused link revokes its unspent code and waits a quarter of an hour", async () => {
  const directory = await home();
  let now = start;
  const { state, run } = world(() => now);
  state.linkRefuses = true;
  const failed = await syncT3Links(
    seams(directory, run, () => now),
    bindings.personalAssigned,
  );
  expect(failed).toMatchObject({
    links: [{ environment: target, result: "failed", cause: "link-refused" }],
  });
  expect(state.pairings.size).toBe(0);
  state.commands.length = 0;
  now += retryAfterMs - 1000;
  const waiting = await syncT3Links(
    seams(directory, run, () => now),
    bindings.personalAssigned,
  );
  expect(waiting).toMatchObject({
    links: [{ environment: target, result: "waiting", cause: "link-refused" }],
  });
  expect(state.commands.some((entry) => entry.command[0] === "ssh")).toBe(
    false,
  );
  state.linkRefuses = false;
  now += 2000;
  const linked = await syncT3Links(
    seams(directory, run, () => now),
    bindings.personalAssigned,
  );
  expect(linked).toMatchObject({ links: [{ result: "linked" }] });
});

test("an unreachable target or an unknown label pairs nothing", async () => {
  const directory = await home();
  const now = () => start;
  const { state, run } = world(now);
  state.sshDown = true;
  expect(
    await syncT3Links(seams(directory, run, now), bindings.personalAssigned),
  ).toMatchObject({
    links: [{ result: "failed", cause: "target-unreachable" }],
  });
  const other = await home();
  const second = world(now);
  expect(
    await syncT3Links(
      { ...seams(other, second.run, now), label: async () => undefined },
      bindings.personalAssigned,
    ),
  ).toMatchObject({ links: [{ result: "failed", cause: "label-unknown" }] });
  expect(
    second.state.commands.some((entry) => entry.command[0] === "ssh"),
  ).toBe(false);
});

test("when the edge goes the source forgets its link and turns off only its own switch", async () => {
  const directory = await home();
  const now = () => start;
  const { state, run } = world(now);
  await syncT3Links(seams(directory, run, now), bindings.personalAssigned);
  const gone = await syncT3Links(seams(directory, run, now), bindings.personal);
  expect(gone).toMatchObject({ unlinked: [target], setting: "written" });
  expect(state.links).toHaveLength(0);
  expect(
    (await readSettingsFile(directory)).linkedEnvironmentsEnabled,
  ).toBeUndefined();
  // Then nothing is left to do, and T3 Code is no longer asked.
  state.commands.length = 0;
  expect(
    await syncT3Links(seams(directory, run, now), bindings.personal),
  ).toEqual({
    role: "source",
    result: "idle",
  });
  expect(state.commands).toHaveLength(0);

  // A switch the person had on stays on.
  const own = await home({ linkedEnvironmentsEnabled: true });
  const second = world(now);
  await syncT3Links(seams(own, second.run, now), bindings.personalAssigned);
  await syncT3Links(seams(own, second.run, now), bindings.personal);
  expect((await readSettingsFile(own)).linkedEnvironmentsEnabled).toBe(true);
});

test("a link the person made is never forgotten by Lazurio", async () => {
  const directory = await home();
  const now = () => start;
  const { state, run } = world(now);
  state.links.push({
    environmentId: randomUUID(),
    label: "Laptop",
    urls: ["http://127.0.0.1:5000"],
    access: "read-only",
    linkedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    lastReachedAt: "2026-11-01T00:00:00.000Z",
    lastError: null,
    status: "reachable",
  });
  await syncT3Links(seams(directory, run, now), bindings.personalAssigned);
  await syncT3Links(seams(directory, run, now), bindings.personal);
  expect(state.links.map((link) => link.label)).toEqual(["Laptop"]);
});

test("the target keeps the switch on while the edge exists and ends every linked session when it goes", async () => {
  const directory = await home();
  const now = () => start;
  const { state, run } = world(now);
  const on = await syncT3Links(seams(directory, run, now), bindings.related);
  expect(on).toMatchObject({
    role: "target",
    setting: "written",
    sources: ["example"],
    revoked: 0,
  });
  expect((await readSettingsFile(directory)).linkedEnvironmentsEnabled).toBe(
    true,
  );
  state.localSessions = [
    {
      sessionId: randomUUID(),
      subject: "mcp-client",
      client: { label: `${linkClientPrefix}lazurio-bob` },
    },
    {
      sessionId: randomUUID(),
      subject: "mcp-client",
      client: { label: "Claude Desktop" },
    },
    {
      sessionId: randomUUID(),
      subject: "browser-session",
      client: { label: "Chrome" },
    },
  ];
  const again = await syncT3Links(seams(directory, run, now), bindings.related);
  expect(again).toMatchObject({ setting: "unchanged", revoked: 0 });
  const gone = await syncT3Links(
    seams(directory, run, now),
    bindings.organization,
  );
  expect(gone).toMatchObject({ setting: "written", sources: [], revoked: 1 });
  expect(state.localSessions.map((session) => session.client.label)).toEqual([
    "Claude Desktop",
    "Chrome",
  ]);
  expect(
    (await readSettingsFile(directory)).linkedEnvironmentsEnabled,
  ).toBeUndefined();
  expect(
    await syncT3Links(seams(directory, run, now), bindings.organization),
  ).toEqual({
    role: "target",
    result: "idle",
  });
});

test("a revocation that failed on the target is tried again", async () => {
  const directory = await home();
  const now = () => start;
  const { state, run } = world(now);
  await syncT3Links(seams(directory, run, now), bindings.related);
  const failing: ToolRunner = async (command, timeout, env, options) =>
    command[2] === "session"
      ? { exitCode: 1, stdout: "", stderr: "" }
      : run(command, timeout, env, options);
  expect(
    await syncT3Links(seams(directory, failing, now), bindings.organization),
  ).toMatchObject({
    revoked: "failed",
  });
  expect(
    parseT3LinksState(JSON.parse(await readState(directory)))?.sources,
  ).toEqual(["example"]);
  state.localSessions = [
    {
      sessionId: randomUUID(),
      subject: "mcp-client",
      client: { label: `${linkClientPrefix}x` },
    },
  ];
  expect(
    await syncT3Links(seams(directory, run, now), bindings.organization),
  ).toMatchObject({
    revoked: 1,
  });
});

test("an unreadable state is replaced and reported, never trusted", async () => {
  const directory = await home();
  const now = () => start;
  const { run } = world(now);
  await mkdir(join(directory, ".local", "state", "lazurio"), {
    recursive: true,
  });
  await writeFile(t3LinksStatePath(directory), "not json");
  const report = await syncT3Links(
    seams(directory, run, now),
    bindings.organization,
  );
  expect(report).toMatchObject({
    role: "target",
    result: "synced",
    stateRecovered: true,
  });
  expect(
    parseT3LinksState(JSON.parse(await readState(directory))),
  ).not.toBeNull();
});

test("T3 Code's answers are taken only in their exact shapes", () => {
  expect(
    parsePairing(
      'warning\n{\n "id": "abc-1",\n "credential": "secret-code-1"\n}\n',
    ),
  ).toEqual({
    id: "abc-1",
    credential: "secret-code-1",
  });
  expect(
    parsePairing('{"id":"a b","credential":"secret-code-1"}'),
  ).toBeUndefined();
  expect(
    parseSessions('[{"sessionId":"x; reboot","subject":"mcp-client"}]'),
  ).toBeUndefined();
  expect(
    parseT3LinksState({
      version: 1,
      enabledByLazurio: false,
      links: { "bad id": {} },
      attempts: {},
      sources: [],
    }),
  ).toBeNull();
});

test("the label comes only from the running Chat on loopback", async () => {
  expect(loopbackOrigin("http://127.0.0.1:3773")).toBe("http://127.0.0.1:3773");
  expect(loopbackOrigin("https://t3code.example.lazurio.io")).toBeUndefined();
  expect(loopbackOrigin("http://user:pw@127.0.0.1:3773")).toBeUndefined();
  expect(environmentLabel("  lazurio-bob ")).toBe("lazurio-bob");
  expect(environmentLabel("a\nb")).toBeUndefined();
  const directory = await home();
  expect(await chatT3Label(directory, uid)).toBeUndefined();
  await writeFile(
    join(directory, ".t3", "userdata", "server-runtime.json"),
    JSON.stringify({
      version: 1,
      pid: 1,
      port: 3773,
      origin: "http://127.0.0.1:3773",
      startedAt: "x",
    }),
  );
  const asked: string[] = [];
  const label = await chatT3Label(directory, uid, async (url) => {
    asked.push(url);
    return new Response(
      JSON.stringify({ environmentId: "e", label: "lazurio-bob" }),
    );
  });
  expect(label).toBe("lazurio-bob");
  expect(asked).toEqual(["http://127.0.0.1:3773/.well-known/t3/environment"]);
});

test("the loop runs one look at a time and stops", async () => {
  let looks = 0;
  let release: () => void = () => undefined;
  let tick: () => void = () => undefined;
  let cleared = false;
  const stop = runT3Links(
    () =>
      new Promise<void>((resolve) => {
        looks += 1;
        release = resolve;
      }),
    {
      everyMs: 1000,
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    },
  );
  tick();
  expect(looks).toBe(1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tick();
  expect(looks).toBe(2);
  stop();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tick();
  expect(looks).toBe(2);
  expect(cleared).toBe(true);
});

test("`lazurio machine t3-links` takes no option", () => {
  expect(parseMachineArguments(["t3-links"]).command).toBe("t3-links");
  expect(() => parseMachineArguments(["t3-links", "--preset", "x"])).toThrow(
    MachineUsageError,
  );
});
