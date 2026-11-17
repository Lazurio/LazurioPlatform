import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineBinding } from "../src/folder/machine-binding";
import { MachineUsageError, parseMachineArguments } from "../src/machine/cli";
import {
  emptyT3LinksState,
  issueLinkPairing,
  linkClientPrefix,
  pairingSettledAfterMs,
  parsePairing,
  parsePairingIds,
  parseSessions,
  parseT3LinksState,
  pendingSettledAfterMs,
  readT3LinksState,
  renewBeforeMs,
  retryAfterMs,
  runT3Links,
  settleLinkPairing,
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
// `src/t3-links/`), with the real code on every end. Each end's T3 Code is a
// fake that answers as T3 Code does: its CLI (`cli/auth.ts`,
// `cliAuthFormat.ts`) and its RPC (`peerLinks.*`, `server.updateSettings`),
// which alone writes its `settings.json`; it keeps one link per peer, as
// T3 Code does. SSH from a source runs the target's `t3` and the target's
// real `issueLinkPairing` and `settleLinkPairing`. Every fixture is
// synthetic.

const uid = process.getuid?.();
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const target = "lazurio-bob.lazurioexampleorganization";
const origin = `https://t3code.${target}.lazurio.io`;
const targetPeerId = "1a119ae1-ab2d-4e2b-90b9-354eb88cf486";
const minute = 60_000;
const day = 24 * 60 * minute;
const start = Date.parse("2026-11-18T00:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();

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
type Source = {
  home: string;
  /** The label its running Chat answers with, which T3 Code names its
   * session on the target by. */
  label: string;
  links: Link[];
};

/** A target and its sources as T3 Code would answer, and everything run. */
async function world(sourceSettings?: unknown, targetSettings?: unknown) {
  const w = {
    now: start,
    sources: {} as Record<string, Source>,
    targetHome: await home(targetSettings),
    targetBinding: workWith("lazurio-bob"),
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
    opened: 0,
    closed: 0,
    sshDown: false,
    linkRefuses: false,
    /** The link is made, but its answer is lost. */
    answerLost: false,
    /** The link is made, but T3 Code answers a refusal. */
    refusedAfterLink: false,
    revokeFails: false,
    serverDown: { source: false, target: false },
    duringSettings: async (_side: string): Promise<void> => undefined,
  };
  const addSource = async (node: string, label = node) => {
    w.sources[node] = { home: await home(sourceSettings), label, links: [] };
    return w.sources[node] as Source;
  };
  await addSource("lazurio-bob", "Buddy");
  const answer = (stdout: string, exitCode = 0) => ({
    exitCode,
    stdout,
    stderr: "",
  });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  // The target's own `t3`.
  const targetRun: ToolRunner = async (command, _timeout, env) => {
    w.commands.push({ side: "target", command, env });
    const verb = command.slice(1, 4).join(" ");
    const last = command.at(-1) as string;
    if (verb === "auth session list") return answer(json(w.targetSessions));
    if (verb === "auth session revoke") {
      if (w.revokeFails) return answer("", 1);
      w.targetSessions = w.targetSessions.filter((s) => s.sessionId !== last);
      return answer("Revoked.\n");
    }
    if (verb === "auth pairing list")
      return answer(json([...w.pairings.keys()].map((id) => ({ id }))));
    if (verb === "auth pairing create") {
      const id = randomUUID();
      const credential = `pc-${randomUUID()}`;
      w.pairings.set(id, credential);
      w.issued.push(credential);
      return answer(json({ id, credential, scopes: [] }));
    }
    if (verb === "auth pairing revoke") {
      w.pairings.delete(last);
      return answer("Revoked.\n");
    }
    return answer("", 1);
  };
  // What only a running server writes.
  const serverSets = async (directory: string, value: boolean) => {
    const path = join(directory, ".t3", "userdata", "settings.json");
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      json({ ...current, linkedEnvironmentsEnabled: value }),
    );
  };
  const on = async (directory: string) =>
    (await settingsOf(directory)).linkedEnvironmentsEnabled === true;
  const rpcOf = (side: string) => async () => {
    const isTarget = side === "target";
    if (w.serverDown[isTarget ? "target" : "source"])
      return "server-down" as const;
    w.opened += 1;
    const rpc: T3Rpc = {
      async request(tag, payload): Promise<RpcAnswer> {
        w.requests.push({ side, tag, payload });
        const source = w.sources[side];
        const directory = isTarget ? w.targetHome : (source as Source).home;
        if (tag === "server.updateSettings") {
          await w.duringSettings(side);
          const patch = (payload as { patch: Record<string, unknown> }).patch;
          await serverSets(directory, patch.linkedEnvironmentsEnabled === true);
          return { ok: true, value: {} };
        }
        if (source === undefined) return { ok: false, error: "unexpected" };
        if (tag === "peerLinks.list")
          return { ok: true, value: { links: source.links } };
        if (tag === "peerLinks.unlink") {
          const id = (payload as { environmentId: string }).environmentId;
          const removed = source.links.some((l) => l.environmentId === id);
          source.links = source.links.filter((l) => l.environmentId !== id);
          return { ok: true, value: { removed } };
        }
        if (tag === "peerLinks.link") {
          const input = payload as { url: string; pairingCode: string };
          const id = [...w.pairings].find(
            ([, code]) => code === input.pairingCode,
          )?.[0];
          if (
            w.linkRefuses ||
            id === undefined ||
            !(await on(source.home)) ||
            !(await on(w.targetHome))
          )
            return { ok: false, error: "PeerLinkError:pairing_rejected" };
          w.pairings.delete(id);
          w.targetSessions.push({
            sessionId: randomUUID(),
            subject: "mcp-client",
            client: { label: `${linkClientPrefix}${source.label}` },
          });
          const link: Link = {
            environmentId: targetPeerId,
            label: "Example / lazurio-bob",
            urls: [input.url],
            access: "full-access",
            linkedAt: iso(w.now),
            expiresAt: iso(w.now + 30 * day),
            lastReachedAt: iso(w.now),
            lastError: null,
            status: "reachable",
          };
          source.links = [
            ...source.links.filter((l) => l.environmentId !== targetPeerId),
            link,
          ];
          if (w.refusedAfterLink)
            return { ok: false, error: "PeerLinkError:unreachable" };
          return w.answerLost
            ? { ok: false, error: "timeout" }
            : { ok: true, value: link };
        }
        return { ok: false, error: "unknown" };
      },
      async close() {
        w.closed += 1;
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
    rpc: rpcOf("target"),
  });
  // A source's SSH reaches the target's `t3` and its Lazurio.
  const sourceRun =
    (node: string): ToolRunner =>
    async (command, timeout, env) => {
      w.commands.push({ side: node, command, env });
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
        expect(remote[3]).toBe("--source");
        if (remote[2] === "t3-link-settle")
          return answer(
            json({
              kind: "t3-link-settle",
              result: await settleLinkPairing(
                targetSeams(),
                w.targetBinding,
                remote[4] as string,
              ),
            }),
          );
        expect(remote.slice(1, 3)).toEqual(["machine", "t3-link-pair"]);
        const issued = await issueLinkPairing(
          targetSeams(),
          w.targetBinding,
          remote[4] as string,
        );
        // What `lazurio machine t3-link-pair` prints.
        return issued.kind === "issued"
          ? answer(
              json({
                kind: "t3-link-pair",
                id: issued.id,
                credential: issued.credential,
              }),
            )
          : answer(json({ kind: "t3-link-pair", reason: issued.reason }), 1);
      }
      return answer("", 127);
    };
  const sourceSeams = (node = "lazurio-bob"): T3LinkSeams => ({
    run: sourceRun(node),
    now: () => w.now,
    home: (w.sources[node] as Source).home,
    uid,
    path: "/usr/bin",
    t3: "/opt/t3",
    node,
    rpc: rpcOf(node),
  });
  const bob = () => w.sources["lazurio-bob"] as Source;
  return {
    w,
    bob,
    addSource,
    source: (
      machine: MachineBinding = bindings.personalAssigned,
      node = "lazurio-bob",
    ) => syncT3Links(sourceSeams(node), machine),
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
});

test("the source links once through its server, and a second look changes nothing", async () => {
  const { w, bob, source } = await world();
  expect(await source()).toMatchObject({
    role: "source",
    result: "synced",
    switch: "on",
    links: [{ environment: target, result: "linked" }],
  });
  expect(await settingsOf(bob().home)).toEqual({
    theme: "dark",
    linkedEnvironmentsEnabled: true,
  });
  expect((await settingsOf(w.targetHome)).linkedEnvironmentsEnabled).toBe(true);
  expect(await stateOf(bob().home)).toEqual({
    ...emptyT3LinksState,
    enabledByLazurio: true,
    links: {
      [target]: {
        peerEnvironmentId: targetPeerId,
        linkedAt: iso(start),
        expiresAt: iso(start + 30 * day),
      },
    },
  });
  // The target settled its code right away: the new session is Bob's by id.
  const sessionId = linkSessions(w.targetSessions)[0]?.sessionId as string;
  expect((await stateOf(w.targetHome)).inbound).toEqual({
    "lazurio-bob": { sessions: [sessionId], pairing: null },
  });
  expect(w.closed).toBe(w.opened);

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
  const { w, bob, source } = await world();
  const report = await source();
  const code = w.issued[0] as string;
  expect(w.issued).toHaveLength(1);
  for (const entry of w.commands)
    expect(JSON.stringify(entry)).not.toContain(code);
  expect(
    w.requests
      .filter((request) => JSON.stringify(request).includes(code))
      .map((request) => request.tag),
  ).toEqual(["peerLinks.link"]);
  expect(JSON.stringify(report)).not.toContain(code);
  for (const directory of [bob().home, w.targetHome]) {
    expect(await readFile(t3LinksStatePath(directory), "utf8")).not.toContain(
      code,
    );
    expect(JSON.stringify(await settingsOf(directory))).not.toContain(code);
  }
});

test("the switch is the server's: a change the server writes meanwhile survives", async () => {
  const { w, bob, source } = await world();
  w.duringSettings = async (side) => {
    if (side !== "lazurio-bob") return;
    const path = join(bob().home, ".t3", "userdata", "settings.json");
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...current, theme: "light" }));
  };
  await source();
  expect(await settingsOf(bob().home)).toEqual({
    theme: "light",
    linkedEnvironmentsEnabled: true,
  });
  expect(
    w.requests
      .filter((request) => request.tag === "server.updateSettings")
      .map((request) => [request.side, request.payload]),
  ).toEqual([
    ["lazurio-bob", { patch: { linkedEnvironmentsEnabled: true } }],
    ["target", { patch: { linkedEnvironmentsEnabled: true } }],
  ]);
});

test("renewal keeps exactly one session, Bob's by id, even after his label changed", async () => {
  const { w, bob, source, target: targetLook } = await world();
  await source();
  const first = linkSessions(w.targetSessions)[0]?.sessionId;
  bob().label = "Buddy renamed";
  w.now += 30 * day - renewBeforeMs + minute;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "renewed" }],
  });
  const sessions = linkSessions(w.targetSessions);
  expect(sessions.map((s) => s.client.label)).toEqual([
    `${linkClientPrefix}Buddy renamed`,
  ]);
  expect(sessions[0]?.sessionId).not.toBe(first);
  expect(
    (await stateOf(w.targetHome)).inbound["lazurio-bob"]?.sessions,
  ).toEqual([sessions[0]?.sessionId as string]);
  // Then the edge goes: the session Bob owns goes, whatever its label.
  w.targetBinding = workWith();
  expect(await targetLook()).toMatchObject({ revoked: 1, switch: "off" });
  expect(linkSessions(w.targetSessions)).toHaveLength(0);
  expect(w.targetSessions.some((s) => s.subject === "browser-session")).toBe(
    true,
  );
});

test("two sources with the same label and the person's own link keep each other's sessions", async () => {
  const { w, addSource, source, target: targetLook } = await world();
  w.targetBinding = workWith("lazurio-bob", "lazurio-carol");
  await addSource("lazurio-carol", "Buddy");
  await source();
  w.now += minute;
  await source(bindings.personalAssigned, "lazurio-carol");
  // The person links from elsewhere under the same label, outside Lazurio.
  const personal = {
    sessionId: randomUUID(),
    subject: "mcp-client",
    client: { label: `${linkClientPrefix}Buddy` },
  };
  w.targetSessions.push(personal);
  const inbound = (await stateOf(w.targetHome)).inbound;
  const bobs = inbound["lazurio-bob"]?.sessions ?? [];
  const carols = inbound["lazurio-carol"]?.sessions ?? [];
  expect(bobs).toHaveLength(1);
  expect(carols).toHaveLength(1);
  expect(bobs[0]).not.toBe(carols[0]);
  // Bob's edge goes: only his session.
  w.targetBinding = workWith("lazurio-carol");
  expect(await targetLook()).toMatchObject({ revoked: 1 });
  expect(linkSessions(w.targetSessions).map((s) => s.sessionId)).toEqual([
    carols[0] as string,
    personal.sessionId,
  ]);
  // Carol renews: her earlier session goes, nobody else's.
  w.now += 30 * day;
  expect(
    await source(bindings.personalAssigned, "lazurio-carol"),
  ).toMatchObject({ links: [{ result: "renewed" }] });
  const left = linkSessions(w.targetSessions).map((s) => s.sessionId);
  expect(left).not.toContain(carols[0]);
  expect(left).toContain(personal.sessionId);
  expect(left).toHaveLength(2);
});

test("the target issues one code at a time, only for a source its handover names", async () => {
  const { w, targetSeams } = await world();
  w.targetBinding = workWith("lazurio-bob", "lazurio-carol");
  const seams = targetSeams();
  expect(await issueLinkPairing(seams, w.targetBinding, "lazurio-eve")).toEqual(
    { kind: "refused", reason: "not-a-source" },
  );
  expect(
    await issueLinkPairing(seams, bindings.personalAssigned, "lazurio-bob"),
  ).toEqual({ kind: "refused", reason: "not-a-target" });
  expect(
    (await issueLinkPairing(seams, w.targetBinding, "lazurio-bob")).kind,
  ).toBe("issued");
  // Bob's code is out: Carol waits until it is settled.
  expect(
    await issueLinkPairing(seams, w.targetBinding, "lazurio-carol"),
  ).toEqual({ kind: "refused", reason: "busy" });
  // Bob asking again revokes his own code; until it has certainly expired
  // without a session, nothing new is issued.
  expect(await issueLinkPairing(seams, w.targetBinding, "lazurio-bob")).toEqual(
    { kind: "refused", reason: "busy" },
  );
  expect(w.pairings.size).toBe(0);
  w.now += pairingSettledAfterMs;
  expect(
    (await issueLinkPairing(seams, w.targetBinding, "lazurio-carol")).kind,
  ).toBe("issued");
  await writeFile(t3LinksStatePath(w.targetHome), "{");
  expect(await issueLinkPairing(seams, w.targetBinding, "lazurio-bob")).toEqual(
    { kind: "refused", reason: "state-unusable" },
  );
});

test("a link made whose answer was lost is settled as Lazurio's, not taken for the person's", async () => {
  const { w, bob, source } = await world();
  w.answerLost = true;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "uncertain" }],
  });
  expect((await stateOf(bob().home)).pending).toEqual({
    [target]: iso(start),
  });
  w.answerLost = false;
  w.now += minute;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "current" }],
  });
  expect((await stateOf(bob().home)).links[target]?.peerEnvironmentId).toBe(
    targetPeerId,
  );
  expect((await stateOf(bob().home)).pending).toEqual({});
  // Still Lazurio's to forget.
  expect(await source(bindings.personal)).toMatchObject({
    unlinked: [target],
  });
  expect(bob().links).toHaveLength(0);
});

test("even a refusal is checked against T3 Code's list: a link made anyway is Lazurio's", async () => {
  const { w, bob, source } = await world();
  w.refusedAfterLink = true;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "linked" }],
  });
  expect((await stateOf(bob().home)).links[target]?.peerEnvironmentId).toBe(
    targetPeerId,
  );
  expect((await stateOf(bob().home)).attempts).toEqual({});
  w.refusedAfterLink = false;
  expect(await source(bindings.personal)).toMatchObject({
    unlinked: [target],
  });
});

test("an uncertain pairing that made no link ends once its code has certainly expired", async () => {
  const { w, bob, source } = await world();
  await writeT3LinksState(bob().home, {
    ...emptyT3LinksState,
    enabledByLazurio: true,
    pending: { [target]: iso(start) },
  });
  w.now += minute;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "uncertain" }],
  });
  expect(w.issued).toHaveLength(0);
  w.now = start + pendingSettledAfterMs;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "linked" }],
  });
});

test("a pairing cut off before its edge went is settled, and its link forgotten", async () => {
  const { w, bob, source, target: targetLook } = await world();
  // The link was made, then the look stopped before it recorded it.
  w.answerLost = true;
  await source();
  w.answerLost = false;
  expect(bob().links).toHaveLength(1);
  // The edge goes before the next look.
  w.now += minute;
  expect(await source(bindings.personal)).toMatchObject({
    unlinked: [target],
    switch: "off",
  });
  expect(bob().links).toHaveLength(0);
  expect((await stateOf(bob().home)).pending).toEqual({});
  // And when the edge comes back, Lazurio links again: no orphan is left
  // that looks like the person's.
  w.now += minute;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "linked" }],
  });
  // The target's side of the same edge: its sessions go with the edge.
  w.targetBinding = workWith();
  expect(await targetLook()).toMatchObject({ switch: "off" });
  expect(linkSessions(w.targetSessions)).toHaveLength(0);
});

test("a failing link is linked again", async () => {
  const { bob, w, source } = await world();
  await source();
  (bob().links[0] as Link).lastError = "no longer accepts this link";
  w.now += day;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "renewed" }],
  });
  expect(linkSessions(w.targetSessions)).toHaveLength(1);
});

test("a refused link revokes its unspent code and waits a quarter of an hour", async () => {
  const { w, bob, source } = await world();
  w.linkRefuses = true;
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "failed", cause: "link-refused" }],
  });
  expect(w.pairings.size).toBe(0);
  expect((await stateOf(bob().home)).pending).toEqual({});
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

test("an unreachable target, an unknown node or a stopped server pairs nothing", async () => {
  const one = await world();
  one.w.sshDown = true;
  expect(await one.source()).toMatchObject({
    links: [{ result: "failed", cause: "target-unreachable" }],
  });
  expect((await stateOf(one.bob().home)).pending).toEqual({});
  const two = await world();
  expect(
    await syncT3Links(
      { ...two.sourceSeams(), node: null },
      bindings.personalAssigned,
    ),
  ).toMatchObject({ links: [{ result: "failed", cause: "node-unknown" }] });
  expect(two.w.commands).toHaveLength(0);
  const three = await world();
  three.w.serverDown.source = true;
  expect(await three.source()).toEqual({
    role: "source",
    result: "server-down",
  });
  expect(three.w.commands).toHaveLength(0);
});

test("a link the person made to the same address, or over Lazurio's, is theirs", async () => {
  const { w, bob, source } = await world();
  bob().links.push({
    environmentId: targetPeerId,
    label: "Example / lazurio-bob",
    urls: [origin],
    access: "read-only",
    linkedAt: "2026-11-17T00:00:00.000Z",
    expiresAt: iso(start + 2 * day),
    lastReachedAt: "2026-11-17T00:00:00.000Z",
    lastError: null,
    status: "reachable",
  });
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "person-link" }],
  });
  expect(w.issued).toHaveLength(0);
  expect(await source(bindings.personal)).toMatchObject({ unlinked: [] });
  expect(bob().links.map((link) => link.access)).toEqual(["read-only"]);

  // Lazurio's link, then the person links the same peer over it.
  const over = await world();
  await over.source();
  (over.bob().links[0] as Link).linkedAt = iso(start + 1000);
  over.w.now += day;
  expect(await over.source()).toMatchObject({
    links: [{ result: "person-link" }],
  });
  expect(await over.source(bindings.personal)).toMatchObject({ unlinked: [] });
  expect(over.bob().links).toHaveLength(1);
});

test("an expired link the person made stays theirs: no pairing over it, no change of its access, no removal with the edge", async () => {
  const { w, bob, source } = await world();
  bob().links.push({
    environmentId: targetPeerId,
    label: "Example / lazurio-bob",
    urls: [origin],
    access: "read-only",
    linkedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: iso(start - day),
    lastReachedAt: "2026-11-01T00:00:00.000Z",
    lastError: null,
    status: "expired",
  });
  expect(await source()).toMatchObject({
    links: [{ environment: target, result: "person-link" }],
  });
  expect(w.issued).toHaveLength(0);
  expect(bob().links.map((link) => [link.access, link.status])).toEqual([
    ["read-only", "expired"],
  ]);
  expect(await source(bindings.personal)).toMatchObject({ unlinked: [] });
  expect(bob().links).toHaveLength(1);
});

test("when the edge goes the source forgets its own link and turns off only its own switch", async () => {
  const { w, bob, source } = await world();
  await source();
  expect(await source(bindings.personal)).toMatchObject({
    unlinked: [target],
    switch: "off",
  });
  expect(bob().links).toHaveLength(0);
  expect((await settingsOf(bob().home)).linkedEnvironmentsEnabled).toBe(false);
  w.requests.length = 0;
  expect(await source(bindings.personal)).toEqual({
    role: "source",
    result: "idle",
  });
  expect(w.requests).toHaveLength(0);

  const own = await world({ linkedEnvironmentsEnabled: true });
  await writeT3LinksState(own.bob().home, emptyT3LinksState);
  await own.source();
  await own.source(bindings.personal);
  expect((await settingsOf(own.bob().home)).linkedEnvironmentsEnabled).toBe(
    true,
  );
});

test("a revocation that failed on the target is tried again", async () => {
  const { w, source, target: targetLook } = await world();
  await source();
  w.targetBinding = workWith();
  w.revokeFails = true;
  expect(await targetLook()).toMatchObject({ revoked: "failed" });
  expect(
    (await stateOf(w.targetHome)).inbound["lazurio-bob"]?.sessions,
  ).toHaveLength(1);
  w.revokeFails = false;
  expect(await targetLook()).toMatchObject({ revoked: 1 });
  expect(linkSessions(w.targetSessions)).toHaveLength(0);
});

test("a code still out for a removed edge is revoked and settled before the source is let go", async () => {
  const { w, targetSeams, target: targetLook } = await world();
  await targetLook();
  expect(
    (await issueLinkPairing(targetSeams(), w.targetBinding, "lazurio-bob"))
      .kind,
  ).toBe("issued");
  w.targetBinding = workWith();
  expect(await targetLook()).toMatchObject({ settling: ["lazurio-bob"] });
  expect(w.pairings.size).toBe(0);
  w.now += pairingSettledAfterMs;
  expect(await targetLook()).toMatchObject({ settling: [] });
  expect((await stateOf(w.targetHome)).inbound).toEqual({});
});

test("a look cut off after its intent: the next one finishes or undoes it", async () => {
  const cut = await world();
  cut.w.duringSettings = async () => {
    throw new Error("cut off");
  };
  await expect(cut.source()).rejects.toThrow("cut off");
  expect((await stateOf(cut.bob().home)).enabledByLazurio).toBe(true);
  expect(
    (await settingsOf(cut.bob().home)).linkedEnvironmentsEnabled,
  ).toBeUndefined();
  cut.w.duringSettings = async () => undefined;
  expect(await cut.source(bindings.personal)).toMatchObject({ switch: "off" });
  expect((await stateOf(cut.bob().home)).enabledByLazurio).toBe(false);

  // The target recorded its code before it existed and never heard back:
  // its own look settles it, so the session is the source's and goes with
  // the edge.
  const pair = await world();
  await issueLinkPairing(
    pair.targetSeams(),
    pair.w.targetBinding,
    "lazurio-bob",
  );
  const code = pair.w.issued[0] as string;
  const pairingId = [...pair.w.pairings].find(([, c]) => c === code)?.[0];
  pair.w.pairings.delete(pairingId as string);
  pair.w.targetSessions.push({
    sessionId: randomUUID(),
    subject: "mcp-client",
    client: { label: `${linkClientPrefix}anything` },
  });
  pair.w.targetBinding = workWith();
  expect(await pair.target()).toMatchObject({ revoked: 1, settling: [] });
  expect(linkSessions(pair.w.targetSessions)).toHaveLength(0);
});

test("a damaged state closes: the switch off and every linked session revoked, then a new state", async () => {
  const { w, bob, source, target: targetLook } = await world();
  await source();
  w.targetSessions.push({
    sessionId: randomUUID(),
    subject: "mcp-client",
    client: { label: `${linkClientPrefix}laptop` },
  });
  await writeFile(t3LinksStatePath(w.targetHome), "not json");
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
  expect(await targetLook()).toMatchObject({ switch: "on" });
  w.now += day;
  (bob().links[0] as Link).lastError = "no longer accepts this link";
  expect(await source()).toMatchObject({ links: [{ result: "renewed" }] });

  await writeFile(t3LinksStatePath(bob().home), '{"version":3}');
  expect(await source()).toEqual({
    role: "source",
    result: "closed",
    state: "damaged",
  });
  expect((await settingsOf(bob().home)).linkedEnvironmentsEnabled).toBe(false);
  expect(bob().links).toHaveLength(1);
});

test("a missing state closes where something may be open, with or without an edge", async () => {
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

  // The last edge went after the state did.
  const gone = await world();
  await gone.source();
  await rm(t3LinksStatePath(gone.w.targetHome));
  gone.w.targetBinding = workWith();
  expect(await gone.target()).toEqual({
    role: "target",
    result: "closed",
    state: "missing",
  });
  expect(linkSessions(gone.w.targetSessions)).toHaveLength(0);
  expect((await settingsOf(gone.w.targetHome)).linkedEnvironmentsEnabled).toBe(
    false,
  );
  await rm(t3LinksStatePath(gone.bob().home));
  expect(await gone.source(bindings.personal)).toEqual({
    role: "source",
    result: "closed",
    state: "missing",
  });

  const fresh = await world();
  expect(await fresh.target()).toMatchObject({
    result: "synced",
    switch: "on",
  });
  const quiet = await world();
  expect(await quiet.target(workWith())).toEqual({
    role: "target",
    result: "idle",
  });
  expect(await readT3LinksState(quiet.w.targetHome, uid)).toEqual({
    kind: "recorded",
    state: emptyT3LinksState,
  });
  quiet.w.commands.length = 0;
  expect(await quiet.target(workWith())).toEqual({
    role: "target",
    result: "idle",
  });
  expect(quiet.w.commands).toHaveLength(0);
});

test("a pairing over a missing state closes what is open before it issues a code", async () => {
  const { w, source, targetSeams } = await world();
  await source();
  const old = linkSessions(w.targetSessions)[0]?.sessionId;
  await rm(t3LinksStatePath(w.targetHome));
  w.commands.length = 0;
  w.now += day;
  expect(
    (await issueLinkPairing(targetSeams(), w.targetBinding, "lazurio-bob"))
      .kind,
  ).toBe("issued");
  const steps = w.commands
    .filter((entry) => entry.side === "target")
    .map((entry) => entry.command.slice(1, 4).join(" "));
  expect(steps.indexOf("auth session revoke")).toBeGreaterThan(-1);
  expect(steps.indexOf("auth session revoke")).toBeLessThan(
    steps.indexOf("auth pairing create"),
  );
  expect(w.targetSessions.some((s) => s.sessionId === old)).toBe(false);

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
  expect(parsePairingIds('[{"id":"p-1"},{"id":"p-2"}]')).toEqual([
    "p-1",
    "p-2",
  ]);
  expect(parsePairingIds('[{"id":"a b"}]')).toBeUndefined();
  expect(
    parseT3LinksState({ ...emptyT3LinksState, links: { "bad id": {} } }),
  ).toBeNull();
  expect(parseT3LinksState({ ...emptyT3LinksState, version: 2 })).toBeNull();
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

test("`lazurio machine t3-links` takes no option, the target's two commands exactly --source", () => {
  expect(parseMachineArguments(["t3-links"]).command).toBe("t3-links");
  expect(() => parseMachineArguments(["t3-links", "--preset", "x"])).toThrow(
    MachineUsageError,
  );
  for (const command of ["t3-link-pair", "t3-link-settle"]) {
    expect(
      parseMachineArguments([command, "--source", "lazurio-bob"]),
    ).toMatchObject({ command, source: "lazurio-bob" });
    expect(() => parseMachineArguments([command])).toThrow(MachineUsageError);
  }
  expect(() =>
    parseMachineArguments(["folder-refresh", "--source", "x"]),
  ).toThrow(MachineUsageError);
});
