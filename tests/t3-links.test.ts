import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineBinding } from "../src/folder/machine-binding";
import { MachineUsageError, parseMachineArguments } from "../src/machine/cli";
import {
  decodeLabel,
  emptyT3LinksState,
  encodeLabel,
  issueLinkPairing,
  linkClientPrefix,
  parsePairing,
  parseSessions,
  parseT3LinksState,
  readT3LinksState,
  renewBeforeMs,
  retryAfterMs,
  runT3Links,
  syncT3Links,
  type T3LinkSeams,
  type T3LinksState,
  t3LinkOrigin,
  t3LinkRole,
  t3LinksStatePath,
  writeT3LinksState,
} from "../src/t3-links/links";
import type { RpcAnswer, T3Rpc } from "../src/t3-links/rpc";
import type { ToolRunner } from "../src/tools/status";
import { binding, bindings } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";

// The links between T3 Code servers (root decision 0157, amended 2026-11-17;
// `src/t3-links/`), with the real code on both ends. Each end's T3 Code is a
// fake that answers as T3 Code does: its CLI (`cli/auth.ts`,
// `cliAuthFormat.ts`) and its RPC (`peerLinks.*`, `server.updateSettings`),
// which alone writes its `settings.json`. SSH from the source runs the
// target's `t3` and the target's real `issueLinkPairing`
// (`lazurio machine t3-link-pair`). Every fixture is synthetic.

const uid = process.getuid?.();
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const target = "lazurio-bob.lazurioexampleorganization";
const origin = `https://t3code.${target}.lazurio.io`;
const targetPeerId = "1a119ae1-ab2d-4e2b-90b9-354eb88cf486";
const day = 24 * 60 * 60_000;
const start = Date.parse("2026-11-18T00:00:00.000Z");

const { team: _team, ...withoutTeam } = organization.owner;
/** The work Environment whose handover names these inbound personal peers. */
function workWith(...sources: string[]): MachineBinding {
  return binding({
    ...organization,
    owner: withoutTeam,
    relationships: {
      zone: "work",
      peers: sources.map((name) => ({
        name,
        kind: "personal-vm",
        zone: "personal",
        organization: null,
        ssh: {
          host: `${name}.tailnet.example.invalid`,
          user: "operator",
          direction: "inbound",
        },
        https: [],
      })),
    },
  });
}

async function home(settings: unknown = { theme: "dark" }) {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-t3-links-"));
  directories.push(directory);
  await mkdir(join(directory, ".t3", "userdata"), { recursive: true });
  await mkdir(join(directory, ".local", "state", "lazurio"), {
    recursive: true,
  });
  await writeFile(
    join(directory, ".t3", "userdata", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  return directory;
}
const settingsOf = async (directory: string) =>
  JSON.parse(
    await readFile(join(directory, ".t3", "userdata", "settings.json"), "utf8"),
  );
const stateOf = async (directory: string) =>
  parseT3LinksState(
    JSON.parse(await readFile(t3LinksStatePath(directory), "utf8")),
  ) as T3LinksState;

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

/** Both ends as T3 Code would answer, and everything either end ran. */
async function world(sourceSettings?: unknown, targetSettings?: unknown) {
  const w = {
    now: start,
    sourceHome: await home(sourceSettings),
    targetHome: await home(targetSettings),
    targetBinding: workWith("lazurio-bob"),
    links: [] as Link[],
    targetSessions: [
      {
        sessionId: randomUUID(),
        subject: "browser-session",
        client: { label: "Chrome" },
      },
    ] as Session[],
    pairings: new Map<string, string>(),
    issued: [] as string[],
    commands: [] as {
      side: string;
      command: readonly string[];
      env: unknown;
    }[],
    requests: [] as { side: string; tag: string; payload: unknown }[],
    opened: { source: 0, target: 0 },
    closed: { source: 0, target: 0 },
    sshDown: false,
    linkRefuses: false,
    sessionsVisible: true,
    revokeFails: false,
    serverDown: { source: false, target: false },
    duringSettings: async (_side: string): Promise<void> => undefined,
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
      })),
      null,
      2,
    )}\n`;
  // The target's own `t3`.
  const targetRun: ToolRunner = async (command, _timeout, env) => {
    w.commands.push({ side: "target", command, env });
    const [verb, object, action] = command.slice(1, 4);
    const last = command.at(-1) as string;
    if (verb === "auth" && object === "session" && action === "list")
      return answer(sessionsJson(w.sessionsVisible ? w.targetSessions : []));
    if (verb === "auth" && object === "session" && action === "revoke") {
      if (w.revokeFails) return answer("", 1);
      w.targetSessions = w.targetSessions.filter(
        (session) => session.sessionId !== last,
      );
      return answer("Revoked.\n");
    }
    if (verb === "auth" && object === "pairing" && action === "create") {
      const id = randomUUID();
      const credential = `pc-${randomUUID()}`;
      w.pairings.set(id, credential);
      w.issued.push(credential);
      return answer(
        `${JSON.stringify({ id, credential, scopes: [] }, null, 2)}\n`,
      );
    }
    if (verb === "auth" && object === "pairing" && action === "revoke") {
      w.pairings.delete(last);
      return answer("Revoked.\n");
    }
    return answer("", 1);
  };
  // What only the running server writes.
  const serverSets = async (directory: string, value: boolean) => {
    const path = join(directory, ".t3", "userdata", "settings.json");
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      `${JSON.stringify({ ...current, linkedEnvironmentsEnabled: value }, null, 2)}\n`,
    );
  };
  const rpcOf = (side: "source" | "target") => async () => {
    if (w.serverDown[side]) return "server-down" as const;
    w.opened[side] += 1;
    const rpc: T3Rpc = {
      async request(tag, payload): Promise<RpcAnswer> {
        w.requests.push({ side, tag, payload });
        const directory = side === "source" ? w.sourceHome : w.targetHome;
        if (tag === "server.updateSettings") {
          await w.duringSettings(side);
          const patch = (payload as { patch: Record<string, unknown> }).patch;
          await serverSets(directory, patch.linkedEnvironmentsEnabled === true);
          return { ok: true, value: {} };
        }
        if (side === "target") return { ok: false, error: "unexpected" };
        if (tag === "peerLinks.list")
          return { ok: true, value: { links: w.links } };
        if (tag === "peerLinks.unlink") {
          const id = (payload as { environmentId: string }).environmentId;
          const removed = w.links.some((link) => link.environmentId === id);
          w.links = w.links.filter((link) => link.environmentId !== id);
          return { ok: true, value: { removed } };
        }
        if (tag === "peerLinks.link") {
          const input = payload as { url: string; pairingCode: string };
          const id = [...w.pairings].find(
            ([, code]) => code === input.pairingCode,
          )?.[0];
          const on = async (directory: string) =>
            (await settingsOf(directory)).linkedEnvironmentsEnabled === true;
          if (
            w.linkRefuses ||
            id === undefined ||
            !(await on(w.sourceHome)) ||
            !(await on(w.targetHome))
          )
            return { ok: false, error: "PeerLinkError:pairing_rejected" };
          w.pairings.delete(id);
          w.targetSessions.push({
            sessionId: randomUUID(),
            subject: "mcp-client",
            client: { label: `${linkClientPrefix}lazurio-bob` },
          });
          const link: Link = {
            environmentId: targetPeerId,
            label: "Example / lazurio-bob",
            urls: [input.url],
            access: "full-access",
            linkedAt: new Date(w.now).toISOString(),
            expiresAt: new Date(w.now + 30 * day).toISOString(),
            lastReachedAt: new Date(w.now).toISOString(),
            lastError: null,
            status: "reachable",
          };
          // T3 Code keeps one link per peer.
          w.links = [
            ...w.links.filter((found) => found.environmentId !== targetPeerId),
            link,
          ];
          return { ok: true, value: link };
        }
        return { ok: false, error: "unknown" };
      },
      async close() {
        w.closed[side] += 1;
      },
    };
    return rpc;
  };
  const targetSeams = (): T3LinkSeams => ({
    run: targetRun,
    now: () => w.now,
    home: w.targetHome,
    uid,
    path: "/usr/bin",
    t3: "/opt/t3",
    node: null,
    label: async () => "Example / lazurio-bob",
    rpc: rpcOf("target"),
  });
  // The source's SSH reaches the target's `t3` and its Lazurio.
  const sourceRun: ToolRunner = async (command, timeout, env) => {
    w.commands.push({ side: "source", command, env });
    if (command[0] !== "ssh" || w.sshDown) return answer("", 255);
    const remote = (command.at(-1) as string).split(" ");
    if (remote[0] === '"$HOME/.local/bin/t3"')
      return targetRun(
        [
          "/opt/t3",
          ...remote
            .slice(1)
            .map((part) =>
              part === '"$HOME/.t3"' ? join(w.targetHome, ".t3") : part,
            ),
        ],
        timeout,
        env,
      );
    if (remote[0] === '"$HOME/.local/bin/lazurio"') {
      expect(remote.slice(1, 3)).toEqual(["machine", "t3-link-pair"]);
      const issued = await issueLinkPairing(
        targetSeams(),
        w.targetBinding,
        remote[4] as string,
        remote[6] as string,
      );
      // What `lazurio machine t3-link-pair` prints.
      return issued.kind === "issued"
        ? answer(
            `${JSON.stringify({ kind: "t3-link-pair", id: issued.id, credential: issued.credential })}\n`,
          )
        : answer(
            JSON.stringify({ kind: "t3-link-pair", reason: issued.reason }),
            1,
          );
    }
    return answer("", 127);
  };
  const sourceSeams = (): T3LinkSeams => ({
    run: sourceRun,
    now: () => w.now,
    home: w.sourceHome,
    uid,
    path: "/usr/bin",
    t3: "/opt/t3",
    node: "lazurio-bob",
    label: async () => "lazurio-bob",
    rpc: rpcOf("source"),
  });
  return {
    w,
    source: (machine: MachineBinding = bindings.personalAssigned) =>
      syncT3Links(sourceSeams(), machine),
    target: (machine?: MachineBinding) =>
      syncT3Links(targetSeams(), machine ?? w.targetBinding),
    sourceSeams,
    targetSeams,
  };
}

const linkSessions = (sessions: Session[]) =>
  sessions.filter((session) => session.subject === "mcp-client");

test("each end finds its role in its own handover only", () => {
  const source = t3LinkRole(bindings.personalAssigned);
  expect(source.kind).toBe("source");
  if (source.kind === "source")
    expect(source.targets.map((entry) => entry.environment)).toEqual([target]);
  expect(t3LinkRole(workWith("b", "a"))).toEqual({
    kind: "target",
    sources: ["a", "b"],
  });
  expect(t3LinkRole(bindings.organization)).toEqual({
    kind: "target",
    sources: [],
  });
  expect(t3LinkRole(null)).toEqual({ kind: "none" });
  expect(t3LinkOrigin(target)).toBe(origin);
  expect(t3LinkOrigin("bob;rm -rf ~")).toBeNull();
  expect(decodeLabel(encodeLabel("Example / lazurio-bob"))).toBe(
    "Example / lazurio-bob",
  );
  expect(decodeLabel("a b")).toBeUndefined();
  expect(decodeLabel(encodeLabel("a\nb"))).toBeUndefined();
});

test("the source links once through its server, and a second look changes nothing", async () => {
  const { w, source } = await world();
  const first = await source();
  expect(first).toMatchObject({
    role: "source",
    result: "synced",
    switch: "on",
    links: [{ environment: target, result: "linked", revoked: 0 }],
  });
  // Both switches were set by their servers; the person's members stay.
  expect(await settingsOf(w.sourceHome)).toEqual({
    theme: "dark",
    linkedEnvironmentsEnabled: true,
  });
  expect((await settingsOf(w.targetHome)).linkedEnvironmentsEnabled).toBe(true);
  expect(linkSessions(w.targetSessions)).toHaveLength(1);
  expect(await stateOf(w.sourceHome)).toEqual({
    ...emptyT3LinksState,
    enabledByLazurio: true,
    links: {
      [target]: {
        peerEnvironmentId: targetPeerId,
        expiresAt: new Date(start + 30 * day).toISOString(),
      },
    },
  });
  // The target recorded who paired and under which label, before the code.
  expect((await stateOf(w.targetHome)).inbound).toEqual({
    "lazurio-bob": "lazurio-bob",
  });
  // Each RPC session of a look is closed after it.
  expect(w.closed).toEqual(w.opened);

  w.commands.length = 0;
  w.requests.length = 0;
  w.now += day;
  expect(await source()).toMatchObject({
    switch: "kept",
    links: [{ environment: target, result: "current" }],
  });
  expect(w.commands).toHaveLength(0);
  expect(w.requests.map((request) => request.tag)).toEqual(["peerLinks.list"]);
});

test("the pairing code travels only in the RPC request that spends it", async () => {
  const { w, source } = await world();
  const report = await source();
  expect(w.issued).toHaveLength(1);
  const code = w.issued[0] as string;
  // No process of either end got it on its command line or environment.
  for (const entry of w.commands)
    expect(JSON.stringify(entry)).not.toContain(code);
  const carrying = w.requests.filter((request) =>
    JSON.stringify(request).includes(code),
  );
  expect(carrying.map((request) => request.tag)).toEqual(["peerLinks.link"]);
  expect(JSON.stringify(report)).not.toContain(code);
  for (const directory of [w.sourceHome, w.targetHome]) {
    expect(await readFile(t3LinksStatePath(directory), "utf8")).not.toContain(
      code,
    );
    expect(JSON.stringify(await settingsOf(directory))).not.toContain(code);
  }
});

test("the switch is the server's: a change the server writes meanwhile survives", async () => {
  const { w, source } = await world();
  // While Lazurio's request is under way, the person changes another
  // setting; only the server writes the file, so nothing of it is lost.
  w.duringSettings = async (side) => {
    if (side !== "source") return;
    const path = join(w.sourceHome, ".t3", "userdata", "settings.json");
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...current, theme: "light" }));
  };
  await source();
  expect(await settingsOf(w.sourceHome)).toEqual({
    theme: "light",
    linkedEnvironmentsEnabled: true,
  });
  expect(
    w.requests.filter((request) => request.tag === "server.updateSettings"),
  ).toEqual([
    {
      side: "source",
      tag: "server.updateSettings",
      payload: { patch: { linkedEnvironmentsEnabled: true } },
    },
    {
      side: "target",
      tag: "server.updateSettings",
      payload: { patch: { linkedEnvironmentsEnabled: true } },
    },
  ]);
});

test("renewal before seven days are left keeps exactly one session on the target", async () => {
  const { w, source } = await world();
  await source();
  const first = linkSessions(w.targetSessions)[0]?.sessionId;
  w.now += 30 * day - renewBeforeMs + 60_000;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "renewed", revoked: 1 }],
  });
  const sessions = linkSessions(w.targetSessions);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.sessionId).not.toBe(first);
  expect(w.targetSessions.some((s) => s.subject === "browser-session")).toBe(
    true,
  );
});

test("a failing link is linked again; an old session stays when the new one is not seen", async () => {
  const { w, source } = await world();
  await source();
  (w.links[0] as Link).lastError = "no longer accepts this link";
  w.sessionsVisible = false;
  w.now += day;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "renewed", revoked: 0 }],
  });
  expect(
    w.commands.some((entry) =>
      String(entry.command.at(-1)).includes("session revoke"),
    ),
  ).toBe(false);
});

test("a refused link revokes its unspent code and waits a quarter of an hour", async () => {
  const { w, source } = await world();
  w.linkRefuses = true;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "failed", cause: "link-refused" }],
  });
  expect(w.pairings.size).toBe(0);
  expect((await stateOf(w.sourceHome)).pending).toEqual({});
  w.commands.length = 0;
  w.now += retryAfterMs - 1000;
  expect(await source()).toMatchObject({
    links: [{ result: "waiting", cause: "link-refused" }],
  });
  expect(w.commands).toHaveLength(0);
  w.linkRefuses = false;
  w.now += 2000;
  expect(await source()).toMatchObject({ links: [{ result: "linked" }] });
});

test("an unreachable target, an unknown label or a stopped server pairs nothing", async () => {
  const one = await world();
  one.w.sshDown = true;
  expect(await one.source()).toMatchObject({
    links: [{ result: "failed", cause: "target-unreachable" }],
  });
  const two = await world();
  expect(
    await syncT3Links(
      { ...two.sourceSeams(), label: async () => undefined },
      bindings.personalAssigned,
    ),
  ).toMatchObject({ links: [{ result: "failed", cause: "label-unknown" }] });
  expect(two.w.commands).toHaveLength(0);
  const three = await world();
  three.w.serverDown.source = true;
  expect(await three.source()).toEqual({
    role: "source",
    result: "server-down",
  });
  expect(three.w.commands).toHaveLength(0);
});

test("the target issues a code only for a source its handover names", async () => {
  const { w, targetSeams } = await world();
  const seams = targetSeams();
  expect(
    await issueLinkPairing(
      seams,
      w.targetBinding,
      "lazurio-eve",
      encodeLabel("x"),
    ),
  ).toEqual({ kind: "refused", reason: "not-a-source" });
  expect(
    await issueLinkPairing(
      seams,
      bindings.personalAssigned,
      "lazurio-bob",
      "eA",
    ),
  ).toEqual({ kind: "refused", reason: "not-a-target" });
  expect(
    await issueLinkPairing(seams, w.targetBinding, "lazurio-bob", "a b"),
  ).toEqual({ kind: "refused", reason: "label-invalid" });
  await writeFile(t3LinksStatePath(w.targetHome), "{");
  expect(
    await issueLinkPairing(
      seams,
      w.targetBinding,
      "lazurio-bob",
      encodeLabel("x"),
    ),
  ).toEqual({ kind: "refused", reason: "state-unusable" });
  expect(w.issued).toHaveLength(0);
});

test("a link the person made to the same address is theirs: never renewed or forgotten", async () => {
  const { w, source } = await world();
  w.links.push({
    environmentId: targetPeerId,
    label: "Example / lazurio-bob",
    urls: [origin],
    access: "read-only",
    linkedAt: "2026-11-17T00:00:00.000Z",
    expiresAt: new Date(start + 2 * day).toISOString(),
    lastReachedAt: "2026-11-17T00:00:00.000Z",
    lastError: null,
    status: "reachable",
  });
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "person-link" }],
  });
  expect(w.issued).toHaveLength(0);
  expect(await source(bindings.personal)).toMatchObject({ unlinked: [] });
  expect(w.links.map((link) => link.access)).toEqual(["read-only"]);
});

test("when the edge goes the source forgets its own link and turns off only its own switch", async () => {
  const { w, source } = await world();
  await source();
  expect(await source(bindings.personal)).toMatchObject({
    unlinked: [target],
    switch: "off",
  });
  expect(w.links).toHaveLength(0);
  expect((await settingsOf(w.sourceHome)).linkedEnvironmentsEnabled).toBe(
    false,
  );
  w.requests.length = 0;
  expect(await source(bindings.personal)).toEqual({
    role: "source",
    result: "idle",
  });
  expect(w.requests).toHaveLength(0);

  // A switch the person had on stays on.
  const own = await world({ linkedEnvironmentsEnabled: true });
  await writeT3LinksState(own.w.sourceHome, emptyT3LinksState);
  await own.source();
  await own.source(bindings.personal);
  expect((await settingsOf(own.w.sourceHome)).linkedEnvironmentsEnabled).toBe(
    true,
  );
});

test("the target revokes exactly the sessions of the source whose edge went", async () => {
  const { w, source, target: targetLook } = await world();
  w.targetBinding = workWith("lazurio-bob", "lazurio-carol");
  await source();
  // Carol's link and the person's own link from their laptop.
  w.targetSessions.push(
    {
      sessionId: randomUUID(),
      subject: "mcp-client",
      client: { label: `${linkClientPrefix}lazurio-carol` },
    },
    {
      sessionId: randomUUID(),
      subject: "mcp-client",
      client: { label: `${linkClientPrefix}laptop` },
    },
  );
  await writeT3LinksState(w.targetHome, {
    ...(await stateOf(w.targetHome)),
    inbound: { "lazurio-bob": "lazurio-bob", "lazurio-carol": "lazurio-carol" },
  });
  expect(await targetLook()).toMatchObject({ switch: "kept", revoked: 0 });
  w.targetBinding = workWith("lazurio-carol");
  expect(await targetLook()).toMatchObject({
    sources: ["lazurio-carol"],
    revoked: 1,
  });
  expect(linkSessions(w.targetSessions).map((s) => s.client.label)).toEqual([
    `${linkClientPrefix}lazurio-carol`,
    `${linkClientPrefix}laptop`,
  ]);
  expect((await settingsOf(w.targetHome)).linkedEnvironmentsEnabled).toBe(true);
  // With the last edge, the switch Lazurio turned on goes off.
  w.targetBinding = workWith();
  expect(await targetLook()).toMatchObject({ switch: "off", revoked: 1 });
  expect((await settingsOf(w.targetHome)).linkedEnvironmentsEnabled).toBe(
    false,
  );
  expect(linkSessions(w.targetSessions).map((s) => s.client.label)).toEqual([
    `${linkClientPrefix}laptop`,
  ]);
  expect(await targetLook()).toEqual({ role: "target", result: "idle" });
});

test("a revocation that failed on the target is tried again", async () => {
  const { w, source, target: targetLook } = await world();
  await source();
  w.targetBinding = workWith();
  w.revokeFails = true;
  expect(await targetLook()).toMatchObject({ revoked: "failed" });
  expect((await stateOf(w.targetHome)).inbound).toEqual({
    "lazurio-bob": "lazurio-bob",
  });
  w.revokeFails = false;
  expect(await targetLook()).toMatchObject({ revoked: 1 });
  expect(linkSessions(w.targetSessions)).toHaveLength(0);
});

test("a look cut off after its intent: the next one finishes or undoes it", async () => {
  // The source recorded a pairing and was cut off after the link existed.
  const { w, source } = await world();
  await source();
  await writeT3LinksState(w.sourceHome, {
    ...(await stateOf(w.sourceHome)),
    links: {},
    pending: { [target]: new Date(start).toISOString() },
  });
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "current" }],
  });
  expect((await stateOf(w.sourceHome)).links[target]?.peerEnvironmentId).toBe(
    targetPeerId,
  );
  // ...so it is still Lazurio's to forget when the edge goes.
  expect(await source(bindings.personal)).toMatchObject({
    unlinked: [target],
  });

  // The switch's intent was written, then the look died before the server
  // answered: the switch stays off and the intent is undone with the edge.
  const cut = await world();
  cut.w.duringSettings = async () => {
    throw new Error("cut off");
  };
  await expect(cut.source()).rejects.toThrow("cut off");
  expect((await stateOf(cut.w.sourceHome)).enabledByLazurio).toBe(true);
  expect(
    (await settingsOf(cut.w.sourceHome)).linkedEnvironmentsEnabled,
  ).toBeUndefined();
  cut.w.duringSettings = async () => undefined;
  expect(await cut.source(bindings.personal)).toMatchObject({
    switch: "off",
  });
  expect((await stateOf(cut.w.sourceHome)).enabledByLazurio).toBe(false);

  // The target recorded its source before the code existed: a link made
  // from a code of a source whose look never confirmed is still revoked.
  const pair = await world();
  await pair.source();
  await writeT3LinksState(pair.w.sourceHome, emptyT3LinksState);
  pair.w.targetBinding = workWith();
  expect(await pair.target()).toMatchObject({ revoked: 1, switch: "off" });
});

test("a damaged state closes: the switch off and every linked session revoked, then a new state", async () => {
  const { w, source, target: targetLook } = await world();
  await source();
  w.targetSessions.push({
    sessionId: randomUUID(),
    subject: "mcp-client",
    client: { label: `${linkClientPrefix}laptop` },
  });
  await writeFile(t3LinksStatePath(w.targetHome), "not json");
  // Closing needs the server: until it answers, nothing is replaced.
  w.serverDown.target = true;
  expect(await targetLook()).toEqual({
    role: "target",
    result: "close-failed",
    state: "damaged",
  });
  expect(await readFile(t3LinksStatePath(w.targetHome), "utf8")).toBe(
    "not json",
  );
  expect(linkSessions(w.targetSessions)).toHaveLength(2);
  w.serverDown.target = false;
  expect(await targetLook()).toEqual({
    role: "target",
    result: "closed",
    state: "damaged",
  });
  expect(linkSessions(w.targetSessions)).toHaveLength(0);
  expect((await settingsOf(w.targetHome)).linkedEnvironmentsEnabled).toBe(
    false,
  );
  expect(await readT3LinksState(w.targetHome, uid)).toEqual({
    kind: "recorded",
    state: emptyT3LinksState,
  });
  // The next looks build it again from the handovers.
  expect(await targetLook()).toMatchObject({ switch: "on" });
  w.now += day;
  (w.links[0] as Link).lastError = "no longer accepts this link";
  expect(await source()).toMatchObject({ links: [{ result: "renewed" }] });

  // On the source a damaged state turns the switch off and forgets nothing.
  await writeFile(t3LinksStatePath(w.sourceHome), '{"version":2}');
  expect(await source()).toEqual({
    role: "source",
    result: "closed",
    state: "damaged",
  });
  expect((await settingsOf(w.sourceHome)).linkedEnvironmentsEnabled).toBe(
    false,
  );
  expect(w.links).toHaveLength(1);
});

test("a missing state closes only where something may be open", async () => {
  // A target with a linked session and no state: closed.
  const open = await world(undefined, { linkedEnvironmentsEnabled: true });
  open.w.targetSessions.push({
    sessionId: randomUUID(),
    subject: "mcp-client",
    client: { label: `${linkClientPrefix}lazurio-bob` },
  });
  expect(await open.target()).toEqual({
    role: "target",
    result: "closed",
    state: "missing",
  });
  expect(linkSessions(open.w.targetSessions)).toHaveLength(0);
  // A first look with nothing open starts a state and goes on.
  const fresh = await world();
  expect(await fresh.target()).toMatchObject({
    result: "synced",
    switch: "on",
  });
  // Without edges and without a state, idle only once it is shown that
  // nothing is open; the empty state then spares the next looks the check.
  const quiet = await world();
  expect(await quiet.target(workWith())).toEqual({
    role: "target",
    result: "idle",
  });
  expect(await readT3LinksState(quiet.w.targetHome, uid)).toEqual({
    kind: "recorded",
    state: emptyT3LinksState,
  });
  expect(quiet.w.requests).toHaveLength(0);
  quiet.w.commands.length = 0;
  expect(await quiet.target(workWith())).toEqual({
    role: "target",
    result: "idle",
  });
  expect(quiet.w.commands).toHaveLength(0);
});

test("a target whose state went missing closes when its last edge goes", async () => {
  const { w, source, target: targetLook } = await world();
  await source();
  expect(linkSessions(w.targetSessions)).toHaveLength(1);
  await rm(t3LinksStatePath(w.targetHome));
  w.targetBinding = workWith();
  // Not idle: the switch is on and a linked session exists.
  expect(await targetLook()).toEqual({
    role: "target",
    result: "closed",
    state: "missing",
  });
  expect(linkSessions(w.targetSessions)).toHaveLength(0);
  expect((await settingsOf(w.targetHome)).linkedEnvironmentsEnabled).toBe(
    false,
  );
  expect(await targetLook()).toEqual({ role: "target", result: "idle" });

  // The same on a source without an edge whose switch is still on.
  await rm(t3LinksStatePath(w.sourceHome));
  expect(await source(bindings.personal)).toEqual({
    role: "source",
    result: "closed",
    state: "missing",
  });
  expect((await settingsOf(w.sourceHome)).linkedEnvironmentsEnabled).toBe(
    false,
  );
});

test("a pairing over a missing state closes what is open before it issues a code", async () => {
  const { w, source, targetSeams } = await world();
  await source();
  const old = linkSessions(w.targetSessions)[0]?.sessionId;
  await rm(t3LinksStatePath(w.targetHome));
  w.commands.length = 0;
  const issued = await issueLinkPairing(
    targetSeams(),
    w.targetBinding,
    "lazurio-bob",
    encodeLabel("lazurio-bob"),
  );
  expect(issued.kind).toBe("issued");
  // The open session was revoked before the code existed.
  const steps = w.commands
    .filter((entry) => entry.side === "target")
    .map((entry) => entry.command.slice(1, 4).join(" "));
  expect(steps.indexOf("auth session revoke")).toBeGreaterThan(-1);
  expect(steps.indexOf("auth session revoke")).toBeLessThan(
    steps.indexOf("auth pairing create"),
  );
  expect(w.targetSessions.some((s) => s.sessionId === old)).toBe(false);
  // Then the new state records the source before the code, and the switch
  // is Lazurio's again.
  expect(await stateOf(w.targetHome)).toEqual({
    ...emptyT3LinksState,
    enabledByLazurio: true,
    inbound: { "lazurio-bob": "lazurio-bob" },
  });
  expect((await settingsOf(w.targetHome)).linkedEnvironmentsEnabled).toBe(true);

  // When it cannot close, no code is issued and nothing is written.
  const stuck = await world();
  await stuck.source();
  await rm(t3LinksStatePath(stuck.w.targetHome));
  stuck.w.revokeFails = true;
  const before = stuck.w.issued.length;
  expect(
    await issueLinkPairing(
      stuck.targetSeams(),
      stuck.w.targetBinding,
      "lazurio-bob",
      encodeLabel("lazurio-bob"),
    ),
  ).toEqual({ kind: "refused", reason: "close-failed" });
  expect(stuck.w.issued.length).toBe(before);
  expect(await readT3LinksState(stuck.w.targetHome, uid)).toEqual({
    kind: "missing",
  });
});

test("T3 Code's answers are taken only in their exact shapes", () => {
  expect(
    parsePairing(
      'warning\n{\n "id": "abc-1",\n "credential": "secret-code-1"\n}\n',
    ),
  ).toEqual({ id: "abc-1", credential: "secret-code-1" });
  expect(
    parsePairing('{"id":"a b","credential":"secret-code-1"}'),
  ).toBeUndefined();
  expect(
    parseSessions('[{"sessionId":"x; reboot","subject":"mcp-client"}]'),
  ).toBeUndefined();
  expect(
    parseT3LinksState({ ...emptyT3LinksState, links: { "bad id": {} } }),
  ).toBeNull();
  expect(parseT3LinksState({ ...emptyT3LinksState, version: 1 })).toBeNull();
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

test("`lazurio machine t3-links` takes no option, `t3-link-pair` exactly its two", () => {
  expect(parseMachineArguments(["t3-links"]).command).toBe("t3-links");
  expect(() => parseMachineArguments(["t3-links", "--preset", "x"])).toThrow(
    MachineUsageError,
  );
  expect(
    parseMachineArguments([
      "t3-link-pair",
      "--source",
      "lazurio-bob",
      "--label",
      "eA",
    ]),
  ).toMatchObject({
    command: "t3-link-pair",
    source: "lazurio-bob",
    label: "eA",
  });
  expect(() =>
    parseMachineArguments(["t3-link-pair", "--source", "lazurio-bob"]),
  ).toThrow(MachineUsageError);
  expect(() =>
    parseMachineArguments(["folder-refresh", "--source", "x"]),
  ).toThrow(MachineUsageError);
});
