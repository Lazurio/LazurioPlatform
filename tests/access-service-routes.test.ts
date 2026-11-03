import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnvironmentSsh } from "../src/machine/cli";
import {
  type AccessServiceFetch,
  accessServiceOf,
  askTargets,
  parseTargets,
  registerSourceKey,
} from "../src/ssh-access/access-service";
import {
  includeLine,
  legacyManagedHeader,
  managedHeader,
  recordedRoutes,
  writeEnvironmentRoutes,
  writeEnvironmentSsh,
} from "../src/ssh-access/environments";
import { syncEnvironmentRoutes } from "../src/ssh-access/routes";
import { ensureSourceKey } from "../src/ssh-access/source-key";
import { runTool } from "../src/tools/status";
import { bindings } from "./fixtures/machine-bindings";

// The source side of root decision 0224 (plan DEV-6687, M7 step 4): this
// Environment's one key, its registration with the home access service
// (`PUT /v1/source-key`) and its SSH config from the service's targets
// (`GET /v1/targets`, Machines ACCESS-SERVICE.md). The service is a fake
// `fetch`; `ssh-keygen` is the real one, in a temporary home. Every fixture
// is synthetic.

const uid = process.getuid?.();
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function home() {
  const path = await mkdtemp(join(tmpdir(), "lazurio-access-routes-"));
  homes.push(path);
  return path;
}
const paths = (path: string) => ({
  ssh: join(path, ".ssh"),
  key: join(path, ".ssh", "lazurio-environment-ed25519"),
  pub: join(path, ".ssh", "lazurio-environment-ed25519.pub"),
  conf: join(path, ".ssh", "config.d", "lazurio-environments.conf"),
  knownHosts: join(path, ".ssh", "known_hosts_lazurio_environments"),
  config: join(path, ".ssh", "config"),
});
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const service = {
  origin: "http://conglomerate-host.tailnet.example.invalid:8444",
};
// The live handover keeps declaring `service` (the commit guard of decision
// F70's amendment, point 5; its transitions are in
// environment-routes-loop.test.ts).
const still = async () => service;
const now = Date.parse("2026-11-03T12:00:00Z");
const keyA =
  "AAAAC3NzaC1lZDI1NTE5AAAAIOosFYFA3vTPDE3z8629wlmF0Qecl1enPwpEjCjOsnfj";
const keyB =
  "AAAAC3NzaC1lZDI1NTE5AAAAIIFygZVmr1cFYx//JrQ0yWhRLdAwCbc1XS4H6ktOFDTx";
const target = (overrides: Record<string, unknown> = {}) => ({
  environment: "alice.example",
  host: "example-alice-vm.tailnet.example.invalid",
  user: "alice",
  host_key: `ssh-ed25519 ${keyA}`,
  valid_until: "2026-11-03T12:03:30Z",
  ...overrides,
});
const answer = (...targets: unknown[]) => ({
  schema_version: "machines.access-targets.v1",
  targets,
});

type Call = { url: string; method: string; body?: string };
/** A fake service: each path answers a status and a body; `null` throws
 * as a refused connection does. */
function fakeService(
  routes: Record<string, { status: number; body?: unknown } | null>,
) {
  const calls: Call[] = [];
  const fetchImpl: AccessServiceFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    expect(init.redirect).toBe("error");
    const route = routes[new URL(url).pathname];
    if (route === null || route === undefined)
      throw new TypeError("connection refused");
    return new Response(
      route.body === undefined
        ? ""
        : typeof route.body === "string"
          ? route.body
          : JSON.stringify(route.body),
      { status: route.status },
    );
  };
  return { calls, fetchImpl };
}
const receipt = {
  status: 200,
  body: {
    schema_version: "machines.access-source-key-receipt.v1",
    changed: true,
  },
};

test("a handover without access_service declares no service, so no Environment derives one from a name", () => {
  for (const machine of [
    bindings.personal,
    bindings.personalAssigned,
    bindings.organization,
    null,
  ])
    expect(accessServiceOf(machine)).toBeNull();
});

test("a targets answer is taken exactly as the contract shapes it, expired targets are dropped, and anything else is no answer", () => {
  expect(parseTargets(answer(target()), now)).toEqual([
    {
      environment: "alice.example",
      host: "example-alice-vm.tailnet.example.invalid",
      user: "alice",
      hostKeys: [{ type: "ssh-ed25519", key: keyA }],
      validUntil: "2026-11-03T12:03:30Z",
    },
  ]);
  expect(parseTargets(answer(), now)).toEqual([]);
  // Expired (or ending this very second): dropped, the rest kept.
  expect(
    parseTargets(
      answer(
        target({ valid_until: "2026-11-03T12:00:00Z" }),
        target({ environment: "alice.other", host_key: `ssh-ed25519 ${keyB}` }),
      ),
      now,
    )?.map((entry) => entry.environment),
  ).toEqual(["alice.other"]);
  const malformed: unknown[] = [
    null,
    [],
    { schema_version: "machines.access-targets.v2", targets: [] },
    { ...answer(), extra: true },
    answer({ ...target(), extra: 1 }),
    answer(target({ environment: "Alice.Example" })),
    answer(target({ environment: "no-dot" })),
    answer(target({ host: "two words" })),
    answer(target({ host: "100.64.0.7" })),
    answer(target({ user: "root;" })),
    answer(target({ user: "Alice" })),
    answer(target({ host_key: keyA })),
    answer(target({ host_key: `ssh-rsa ${keyA}` })),
    answer(target({ host_key: `ssh-ed25519 ${keyA} comment` })),
    // An RSA blob of an ed25519 key's length.
    answer(
      target({ host_key: `ssh-ed25519 AAAAB3NzaC1yc2E${keyA.slice(15)}` }),
    ),
    answer(target({ valid_until: "2026-11-03 12:03:30" })),
    answer(target({ valid_until: "2026-11-03T12:03:30.000Z" })),
    answer(target({ valid_until: "2026-02-30T12:00:00Z" })),
    // One Environment id twice would make one alias mean two hosts.
    answer(target(), target({ user: "bob" })),
    answer(...Array.from({ length: 1025 }, () => target())),
  ];
  for (const [index, document] of malformed.entries())
    expect([index, parseTargets(document, now)]).toEqual([index, null]);
});

test("asking for targets names each outcome by itself: answered, not recognized, unavailable, unreachable, malformed", async () => {
  const ask = (route: { status: number; body?: unknown } | null) =>
    askTargets(
      service,
      () => now,
      fakeService({ "/v1/targets": route }).fetchImpl,
    );
  expect(await ask({ status: 200, body: answer(target()) })).toMatchObject({
    kind: "answered",
  });
  expect(await ask({ status: 403 })).toEqual({ kind: "not-recognized" });
  expect(await ask({ status: 503 })).toEqual({ kind: "unavailable" });
  expect(await ask(null)).toEqual({ kind: "unreachable" });
  for (const route of [
    { status: 500 },
    { status: 302 },
    { status: 200, body: "not json" },
    { status: 200, body: answer(target({ host_key: "x" })) },
  ])
    expect(await ask(route)).toEqual({ kind: "malformed" });
  // An origin that is not exactly http://<name>:<port> is never asked.
  const fake = fakeService({});
  for (const origin of [
    "https://host.example.invalid:8444",
    "http://host.example.invalid",
    "http://host.example.invalid:8444/",
    "http://user@host.example.invalid:8444",
  ])
    expect(await askTargets({ origin }, () => now, fake.fetchImpl)).toEqual({
      kind: "unreachable",
    });
  expect(fake.calls).toEqual([]);
});

test("an oversized or endless answer is cut at its limit and cancelled, never read whole", async () => {
  // An answer that would go on for ever: 64 KiB chunks until cancelled.
  let produced = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += 64 * 1024;
      controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl: AccessServiceFetch = async () =>
    new Response(endless, { status: 200 });
  expect(await askTargets(service, () => now, fetchImpl)).toEqual({
    kind: "malformed",
  });
  expect(cancelled).toBe(true);
  // Read up to the limit and no more than a few chunks past it.
  expect(produced).toBeLessThanOrEqual(1024 * 1024 + 4 * 64 * 1024);
  // An answer just under the limit is still read and judged.
  const padded = JSON.stringify(answer(target())).padEnd(1024 * 1024 - 1, " ");
  expect(
    await askTargets(
      service,
      () => now,
      async () => new Response(padded, { status: 200 }),
    ),
  ).toMatchObject({ kind: "answered" });
});

test("registration sends only the public line and reads the receipt or the named refusal", async () => {
  const line = `ssh-ed25519 ${keyA}`;
  const register = (route: { status: number; body?: unknown } | null) => {
    const fake = fakeService({ "/v1/source-key": route });
    return registerSourceKey(service, line, fake.fetchImpl).then((result) => ({
      result,
      calls: fake.calls,
    }));
  };
  const done = await register(receipt);
  expect(done.result).toEqual({ kind: "registered", changed: true });
  expect(done.calls).toEqual([
    {
      url: `${service.origin}/v1/source-key`,
      method: "PUT",
      body: JSON.stringify({ ssh_public_key: line }),
    },
  ]);
  for (const reason of ["source-key-forbidden", "source-key-taken"] as const)
    expect(
      (await register({ status: 409, body: { error: reason } })).result,
    ).toEqual({ kind: "refused", reason });
  expect((await register({ status: 403 })).result).toEqual({
    kind: "not-recognized",
  });
  expect((await register(null)).result).toEqual({ kind: "unreachable" });
  for (const route of [
    { status: 400, body: { error: "source-key-invalid" } },
    { status: 409, body: { error: "other" } },
    { status: 200, body: { changed: true } },
  ])
    expect((await register(route)).result).toEqual({ kind: "malformed" });
  // A line that is not one ed25519 key is never sent.
  const fake = fakeService({ "/v1/source-key": receipt });
  expect(
    await registerSourceKey(service, `ssh-rsa ${keyA}`, fake.fetchImpl),
  ).toEqual({ kind: "malformed" });
  expect(fake.calls).toEqual([]);
});

test("the source key is created here when missing, kept when present, and its private part is never read back into an answer", async () => {
  const path = await home();
  const at = paths(path);
  const created = await ensureSourceKey({ home: path, uid }, runTool);
  expect(created.kind).toBe("created");
  const pub = await readFile(at.pub, "utf8");
  const line = pub.split(" ").slice(0, 2).join(" ");
  expect(created).toEqual({ kind: "created", publicKey: line });
  expect(line).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI/);
  expect((await stat(at.key)).mode & 0o777).toBe(0o600);
  expect((await stat(at.ssh)).mode & 0o777).toBe(0o700);
  const secret = await readFile(at.key, "utf8");
  expect(JSON.stringify(created)).not.toContain(secret.split("\n")[1]);
  // A second run keeps the same pair.
  expect(await ensureSourceKey({ home: path, uid }, runTool)).toEqual({
    kind: "present",
    publicKey: line,
  });
  expect(await readFile(at.key, "utf8")).toBe(secret);
  // A lost .pub is derived again from the private key, which stays.
  await rm(at.pub);
  expect(await ensureSourceKey({ home: path, uid }, runTool)).toEqual({
    kind: "created",
    publicKey: line,
  });
  expect(await readFile(at.key, "utf8")).toBe(secret);
});

test("a key the Platform cannot vouch for is refused by path and left as it is", async () => {
  // A .pub without its private key: never replaced.
  const lone = await home();
  await mkdir(paths(lone).ssh, { mode: 0o700 });
  await writeFile(paths(lone).pub, `ssh-ed25519 ${keyA}\n`);
  expect(await ensureSourceKey({ home: lone, uid }, runTool)).toEqual({
    kind: "blocked",
    reason: "key-incomplete",
    path: "~/.ssh/lazurio-environment-ed25519.pub",
  });
  expect(await exists(paths(lone).key)).toBe(false);
  // A private key others may read, a .pub of another key, a link.
  const path = await home();
  const at = paths(path);
  await ensureSourceKey({ home: path, uid }, runTool);
  await chmod(at.key, 0o644);
  expect(await ensureSourceKey({ home: path, uid }, runTool)).toEqual({
    kind: "blocked",
    reason: "file-unsafe",
    path: "~/.ssh/lazurio-environment-ed25519",
  });
  await chmod(at.key, 0o600);
  await writeFile(at.pub, `ssh-ed25519 ${keyB} someone\n`);
  expect(await ensureSourceKey({ home: path, uid }, runTool)).toEqual({
    kind: "blocked",
    reason: "key-invalid",
    path: "~/.ssh/lazurio-environment-ed25519.pub",
  });
  expect(await readFile(at.pub, "utf8")).toBe(`ssh-ed25519 ${keyB} someone\n`);
  const linked = await home();
  await mkdir(paths(linked).ssh, { mode: 0o700 });
  await writeFile(join(linked, "elsewhere"), "secret");
  await symlink(join(linked, "elsewhere"), paths(linked).key);
  expect(await ensureSourceKey({ home: linked, uid }, runTool)).toEqual({
    kind: "blocked",
    reason: "file-unsafe",
    path: "~/.ssh/lazurio-environment-ed25519",
  });
});

test("one synchronization registers the key, writes the service's targets pinned with their deadlines, and a second one changes nothing", async () => {
  const path = await home();
  const at = paths(path);
  const fake = fakeService({
    "/v1/source-key": receipt,
    "/v1/targets": { status: 200, body: answer(target()) },
  });
  const seams = {
    run: runTool,
    current: still,
    now: () => now,
    fetch: fake.fetchImpl,
  };
  const first = await syncEnvironmentRoutes(
    { home: path, uid },
    service,
    seams,
  );
  expect(first.sourceKey.kind).toBe("created");
  expect(first.registration).toEqual({ kind: "registered", changed: true });
  expect(first.targets).toBe("answered");
  expect(first.ssh).toEqual({
    kind: "written",
    environments: ["alice.example"],
  });
  const pub = (await readFile(at.pub, "utf8")).split(" ").slice(0, 2).join(" ");
  expect(fake.calls[0]?.body).toBe(JSON.stringify({ ssh_public_key: pub }));
  expect(await readFile(at.conf, "utf8")).toBe(`${managedHeader}

Host alice.example
  # valid_until 2026-11-03T12:03:30Z
  HostName example-alice-vm.tailnet.example.invalid
  User alice
  HostKeyAlias alice.example
  UserKnownHostsFile ~/.ssh/known_hosts_lazurio_environments
  StrictHostKeyChecking yes
  IdentityFile ~/.ssh/lazurio-environment-ed25519
  IdentitiesOnly yes
  ForwardAgent no
  ProxyJump none
  ClearAllForwardings yes
`);
  expect(await readFile(at.knownHosts, "utf8")).toBe(
    `${managedHeader}\nalice.example ssh-ed25519 ${keyA}\n`,
  );
  expect(await readFile(at.config, "utf8")).toBe(`${includeLine}\n`);
  const second = await syncEnvironmentRoutes(
    { home: path, uid },
    service,
    seams,
  );
  expect(second.sourceKey.kind).toBe("present");
  expect(second.ssh).toEqual({
    kind: "unchanged",
    environments: ["alice.example"],
  });
  // What the files record reads back exactly.
  expect(await recordedRoutes({ home: path, uid })).toEqual([
    {
      environment: "alice.example",
      host: "example-alice-vm.tailnet.example.invalid",
      user: "alice",
      hostKeys: [{ type: "ssh-ed25519", key: keyA }],
      validUntil: "2026-11-03T12:03:30Z",
    },
  ]);
});

test("without a valid answer nothing is added: the recorded routes stay until their deadline, then go, and the failure is named as the service's", async () => {
  for (const route of [
    null,
    { status: 503 },
    { status: 403 },
    { status: 200, body: answer(target({ host_key: "x" })) },
  ]) {
    const path = await home();
    const at = paths(path);
    const location = { home: path, uid };
    await writeEnvironmentRoutes(location, [
      {
        environment: "alice.example",
        host: "example-alice-vm.tailnet.example.invalid",
        user: "alice",
        hostKeys: [{ type: "ssh-ed25519", key: keyA }],
        validUntil: "2026-11-03T12:03:30Z",
      },
      {
        environment: "alice.other",
        host: "other-alice-vm.tailnet.example.invalid",
        user: "alice",
        hostKeys: [{ type: "ssh-ed25519", key: keyB }],
        validUntil: "2026-11-03T11:59:59Z",
      },
    ]);
    const fake = fakeService({ "/v1/source-key": route, "/v1/targets": route });
    const result = await syncEnvironmentRoutes(location, service, {
      run: runTool,
      current: still,
      now: () => now,
      fetch: fake.fetchImpl,
    });
    expect(result.targets).not.toBe("answered");
    expect(result.ssh).toEqual({
      kind: "written",
      environments: ["alice.example"],
    });
    expect(await readFile(at.knownHosts, "utf8")).toBe(
      `${managedHeader}\nalice.example ssh-ed25519 ${keyA}\n`,
    );
    // A minute after the last deadline, nothing is left.
    const later = await syncEnvironmentRoutes(location, service, {
      run: runTool,
      current: still,
      now: () => Date.parse("2026-11-03T12:04:30Z"),
      fetch: fake.fetchImpl,
    });
    expect(later.ssh).toEqual({ kind: "removed" });
    expect(await exists(at.conf)).toBe(false);
    expect(await exists(at.knownHosts)).toBe(false);
  }
  // Routes written from the handover have no deadline: under the service
  // they are not its routes, and an unreachable service keeps none of them.
  const path = await home();
  await writeEnvironmentSsh({ home: path, uid }, bindings.personalAssigned);
  const result = await syncEnvironmentRoutes({ home: path, uid }, service, {
    run: runTool,
    current: still,
    now: () => now,
    fetch: fakeService({}).fetchImpl,
  });
  expect(result.targets).toBe("unreachable");
  expect(result.registration).toEqual({ kind: "unreachable" });
  expect(result.ssh).toEqual({ kind: "removed" });
});

test("a host key the service changes replaces the pin, and nothing ever learns a key from a connection", async () => {
  const path = await home();
  const at = paths(path);
  const sync = (hostKey: string) =>
    syncEnvironmentRoutes({ home: path, uid }, service, {
      run: runTool,
      current: still,
      now: () => now,
      fetch: fakeService({
        "/v1/source-key": receipt,
        "/v1/targets": {
          status: 200,
          body: answer(target({ host_key: `ssh-ed25519 ${hostKey}` })),
        },
      }).fetchImpl,
    });
  await sync(keyA);
  expect((await sync(keyB)).ssh.kind).toBe("written");
  expect(await readFile(at.knownHosts, "utf8")).toBe(
    `${managedHeader}\nalice.example ssh-ed25519 ${keyB}\n`,
  );
  const conf = await readFile(at.conf, "utf8");
  expect(conf).toContain("  StrictHostKeyChecking yes\n");
  expect(conf).not.toMatch(/accept-new|StrictHostKeyChecking no/);
  // The person's own known_hosts is never written.
  expect(await exists(join(at.ssh, "known_hosts"))).toBe(false);
});

test("the person's own Host blocks stay byte for byte below the Include, and their own file at the Platform's path is refused", async () => {
  const path = await home();
  const at = paths(path);
  await mkdir(at.ssh, { mode: 0o700 });
  const own =
    "Host alice.example work\n  HostName 100.64.0.9\n  ForwardAgent yes\n  ProxyJump bastion\nHost *\n  ForwardAgent yes\n";
  await writeFile(at.config, own, { mode: 0o600 });
  const fake = fakeService({
    "/v1/source-key": receipt,
    "/v1/targets": { status: 200, body: answer(target()) },
  });
  const seams = {
    run: runTool,
    current: still,
    now: () => now,
    fetch: fake.fetchImpl,
  };
  expect(
    (await syncEnvironmentRoutes({ home: path, uid }, service, seams)).ssh,
  ).toEqual({ kind: "written", environments: ["alice.example"] });
  // The Include comes first, so for alice.example OpenSSH takes the managed
  // values: its pinned host, no agent, no jump.
  expect(await readFile(at.config, "utf8")).toBe(`${includeLine}\n${own}`);
  // A file of the person's at the managed path: refused, nothing changed,
  // and the service's answer is still reported as an answer.
  await writeFile(at.conf, "Host mine\n");
  const refused = await syncEnvironmentRoutes(
    { home: path, uid },
    service,
    seams,
  );
  expect(refused.targets).toBe("answered");
  expect(refused.ssh).toEqual({
    kind: "blocked",
    reason: "file-foreign",
    path: "~/.ssh/config.d/lazurio-environments.conf",
  });
  expect(await readFile(at.conf, "utf8")).toBe("Host mine\n");
});

test("a file the first release wrote is still the Platform's and is rewritten", async () => {
  const path = await home();
  const at = paths(path);
  await mkdir(join(at.ssh, "config.d"), { recursive: true, mode: 0o700 });
  await writeFile(at.conf, `${legacyManagedHeader}\n`, { mode: 0o600 });
  await writeFile(at.knownHosts, `${legacyManagedHeader}\n`, { mode: 0o644 });
  expect(
    (await writeEnvironmentSsh({ home: path, uid }, bindings.personalAssigned))
      .kind,
  ).toBe("written");
  expect((await readFile(at.conf, "utf8")).split("\n")[0]).toBe(managedHeader);
});

test("the machine commands synchronize with a declared service on any Machine and report it as environmentRoutes", async () => {
  const path = await home();
  const fake = fakeService({
    "/v1/source-key": receipt,
    "/v1/targets": { status: 200, body: answer(target()) },
  });
  const seams = {
    run: runTool,
    current: still,
    now: () => now,
    fetch: fake.fetchImpl,
  };
  for (const machine of [bindings.organization, bindings.personal]) {
    const result = await withEnvironmentSsh(
      { kind: "refreshed", revision: 2 },
      machine,
      { home: path, uid },
      service,
      seams,
    );
    expect(result).toMatchObject({
      kind: "refreshed",
      environmentRoutes: {
        targets: "answered",
        registration: { kind: "registered" },
      },
    });
    expect(result).not.toHaveProperty("environmentSsh");
  }
  // A blocked or adopted answer still writes nothing and asks nothing.
  const quiet = fakeService({});
  expect<unknown>(
    await withEnvironmentSsh(
      { kind: "blocked" },
      bindings.organization,
      { home: await home(), uid },
      service,
      { ...seams, fetch: quiet.fetchImpl },
    ),
  ).toEqual({ kind: "blocked" });
  expect(quiet.calls).toEqual([]);
});
