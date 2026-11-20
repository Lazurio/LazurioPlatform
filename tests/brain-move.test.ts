import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrainHttp } from "../src/brain/admin";
import { runBrainCommand } from "../src/brain/cli";
import { readBrainState, writeBrainState } from "../src/brain/keys";
import {
  brainPaths,
  brainPin,
  brainRefreshService,
  brainRefreshTimer,
  brainUnit,
  releaseCommand,
} from "../src/brain/pin";
import { brainSetup, type SetupHost } from "../src/brain/setup";
import { brainStatus } from "../src/brain/status";
import { interimRelease, interimUnitsCopy } from "../src/brain/takeover";
import { writeBrainUnits } from "../src/brain/units";
import { acquireFileLock } from "../src/platform/flock";
import type { ToolRunner } from "../src/tools/status";
import type { ProcessRunner } from "../src/update/self-check";
import { unitMarker } from "../src/update/service-control";
import {
  interimRefreshService,
  interimRefreshTimer,
  interimServerUnit,
} from "./fixtures/brain-interim-units";
import { userManager, userRuntime } from "./fixtures/user-manager";

// The interim installer's brain taken over in place and moved to the pin
// (plan LZD-0033 R11a, part B; the move of HumanAndMachine-ai/Machines#1337),
// against stand-ins: systemd runs whatever release the unit names, that
// release answers with its version over a function in place of HTTP, and
// the pin "migrates" the brain when it starts. Fictional data and tokens.

const interimCommit = "ed90fd9d207d8acd18f27eeea3b03cf092cea4eb";
const interimVersion = "0.60.315.0";
const interimUnit = `[Unit]
Description=gbrain MCP server

[Service]
ExecStart=/bin/bash -c 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$$(cat %h/.gbrain/serve/admin-token)" exec %h/.bun/bin/gbrain serve --http --bind 127.0.0.1 --port 3131 --public-url http://127.0.0.1:3131'

[Install]
WantedBy=default.target
`;

type Options = Readonly<{
  consent?: boolean;
  idle?: boolean;
  /** The pin answers with another page count. */
  pinLosesPages?: boolean;
  /** systemd never confirms the server stopped. */
  neverStops?: boolean;
  /** The interim installer's three units exactly as it writes them, its
   * server unit's credential check before the start included. */
  installedUnits?: boolean;
  /** The interim installer named the fork by its release tag, as its
   * earlier runs did: Bun's lockfile and `.bun-tag` hold the commit it
   * resolved (as `bun add --global github:Lazurio/gbrain#v0.60.315.0-
   * lazurio.1` leaves them). `lock` and `bunTag` replace either; null
   * leaves it out. */
  tagged?: Readonly<{
    lock?: string | null;
    bunTag?: string | null;
    tag?: string;
  }>;
  /** Room left on the disk (64 GiB where not given). */
  freeBytes?: number | null;
}>;

async function stand(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "brain-move-"));
  const paths = brainPaths(join(root, "home"));
  const now = new Date("2026-11-18T23:40:00Z");
  // The interim installer's layout.
  await mkdir(paths.units, { recursive: true });
  if (options.installedUnits) {
    await writeFile(join(paths.units, brainUnit), interimServerUnit);
    await writeFile(
      join(paths.units, brainRefreshService),
      interimRefreshService,
    );
    await writeFile(join(paths.units, brainRefreshTimer), interimRefreshTimer);
  } else {
    await writeFile(join(paths.units, brainUnit), interimUnit);
    await writeFile(
      join(paths.units, brainRefreshTimer),
      "[Timer]\nOnUnitActiveSec=15min\n",
    );
  }
  const global = join(paths.home, ".bun", "install", "global");
  await mkdir(join(global, "node_modules", "gbrain"), { recursive: true });
  const tagged = options.tagged;
  await writeFile(
    join(global, "package.json"),
    JSON.stringify({
      dependencies: {
        gbrain: `github:Lazurio/gbrain#${
          tagged === undefined
            ? interimCommit
            : (tagged.tag ?? `v${interimVersion}-lazurio.1`)
        }`,
      },
    }),
  );
  await writeFile(
    join(global, "node_modules", "gbrain", "package.json"),
    JSON.stringify({ version: interimVersion }),
  );
  if (tagged !== undefined) {
    // The shapes Bun writes, from a real install of that tag.
    const lock = tagged.lock === undefined ? "5586fb4" : tagged.lock;
    const bunTag = tagged.bunTag === undefined ? "5586fb4" : tagged.bunTag;
    if (lock !== null)
      await writeFile(
        join(global, "bun.lock"),
        `{\n  "lockfileVersion": 1,\n  "packages": {\n    "gbrain": ["gbrain@github:Lazurio/gbrain#${lock}", { "bin": { "gbrain": "src/cli.ts" } }, "Lazurio-gbrain-${lock}", "sha512-x"],\n  }\n}\n`,
      );
    if (bunTag !== null)
      await writeFile(
        join(global, "node_modules", "gbrain", ".bun-tag"),
        `Lazurio-gbrain-${bunTag}`,
      );
  }
  await mkdir(join(paths.home, ".bun", "bin"), { recursive: true });
  await writeFile(paths.interimCommand, "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(join(paths.home, ".local", "state", "lazurio", "buddy"), {
    recursive: true,
  });
  await writeFile(
    join(paths.home, ".local", "state", "lazurio", "buddy", "managed.json"),
    JSON.stringify({
      vault: {
        repo: "bob-example/bob-example-gbrain",
        on_commit: { repo: "bob-example/bob-example-gbrain", at: "2026-10-30" },
      },
    }),
  );
  // The brain with its credential and Lazurio's keys, all fictional.
  await mkdir(join(paths.brain, "serve"), { recursive: true });
  await writeFile(join(paths.brain, "config.json"), '{"brain":"before"}');
  await writeFile(paths.adminToken, "a".repeat(64));
  for (const [path, token] of [
    [paths.launchpadKey, "l".repeat(32)],
    [paths.executorKey, "e".repeat(32)],
    [paths.probeKey, "p".repeat(32)],
  ] as const)
    await writeFile(
      path,
      JSON.stringify({ url: "http://127.0.0.1:3131", token }),
    );
  await writeFile(join(root, "brain-handover"), "");
  const systemd = {
    server: true,
    timer: true,
    serverEnabled: true,
    timerEnabled: true,
    running: interimVersion as string | null,
  };
  const calls: string[][] = [];
  const pinCommand = releaseCommand(paths, brainPin.commit);
  const service: ProcessRunner = async (command) => {
    calls.push([...command]);
    const [, , verb, ...rest] = command;
    const done = (exitCode: number, stdout = "") => ({
      exitCode,
      stdout,
      stderr: "",
    });
    const names = rest.filter((a) => !a.startsWith("-"));
    if (verb === "is-active") {
      const on = names[0] === brainUnit ? systemd.server : systemd.timer;
      return done(on ? 0 : 3, on ? "active\n" : "inactive\n");
    }
    if (verb === "is-enabled") {
      const on =
        names[0] === brainUnit ? systemd.serverEnabled : systemd.timerEnabled;
      return done(on ? 0 : 1, on ? "enabled\n" : "disabled\n");
    }
    for (const name of names) {
      const server = name === brainUnit;
      if (verb === "stop" || (verb === "disable" && rest.includes("--now"))) {
        if (server && options.neverStops) continue;
        if (server) {
          systemd.server = false;
          systemd.running = null;
        } else systemd.timer = false;
      }
      if (verb === "disable") {
        if (server) systemd.serverEnabled = false;
        else systemd.timerEnabled = false;
      }
      if (verb === "enable") {
        if (server) systemd.serverEnabled = true;
        else systemd.timerEnabled = true;
        if (rest.includes("--now") && !server) systemd.timer = true;
      }
      if (verb === "start") {
        if (!server) {
          systemd.timer = true;
          continue;
        }
        const unit = await readFile(join(paths.units, brainUnit), "utf8");
        systemd.server = true;
        if (unit.includes(pinCommand)) {
          systemd.running = brainPin.version;
          // The pin's migrations reach the brain it starts on.
          await writeFile(join(paths.brain, "config.json"), '{"brain":"pin"}');
        } else systemd.running = interimVersion;
      }
    }
    return done(0);
  };
  const run: ToolRunner = async (command, _timeout, env) => {
    calls.push([...command]);
    if (command[1] === "add") {
      const dir = env.BUN_INSTALL as string;
      const pkg = join(dir, "install", "global", "node_modules", "gbrain");
      await mkdir(pkg, { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({ version: brainPin.version }),
      );
      await mkdir(join(dir, "bin"), { recursive: true });
      await writeFile(join(dir, "bin", "gbrain"), "#!/bin/sh\n", {
        mode: 0o755,
      });
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const tokens = ["l", "e", "p"].map((c) => c.repeat(32));
  const http: BrainHttp = async (method, url, body, headers) => {
    if (systemd.running === null) return null;
    const path = new URL(url).pathname;
    if (path === "/health")
      return {
        status: 200,
        body: JSON.stringify({ status: "ok", version: systemd.running }),
      };
    if (path === "/mcp" && method === "POST") {
      const token = (headers?.authorization ?? "").replace("Bearer ", "");
      if (!tokens.includes(token)) return { status: 401, body: "{}" };
      const call = body as { method: string };
      if (call.method !== "tools/call") return { status: 200, body: "{}" };
      const pages =
        options.pinLosesPages && systemd.running === brainPin.version ? 3 : 46;
      return {
        status: 200,
        body: JSON.stringify({
          result: {
            content: [{ text: JSON.stringify({ page_count: pages }) }],
          },
        }),
      };
    }
    return { status: 404, body: "{}" };
  };
  const host: SetupHost = {
    // The owner's consent, for the runs of this host (as `take-over` gives
    // it for its own run).
    ...(options.consent ? { consent: now } : {}),
    async context() {
      return { kind: "supported" };
    },
    paths,
    globalUnits: join(root, "etc-systemd-user"),
    handover: join(root, "brain-handover"),
    async health() {
      return systemd.running;
    },
    run,
    service: userManager(service),
    http,
    bun: "/fake/bun",
    env: { HOME: paths.home, PATH: "/usr/bin:/bin", ...userRuntime },
    base: "http://127.0.0.1:3131",
    idle: async () => options.idle ?? true,
    freeBytes: async () =>
      options.freeBytes === undefined ? 64 * 1024 ** 3 : options.freeBytes,
    now: () => now,
    tries: 2,
    waitMs: 1,
  };
  return { host, paths, calls, systemd, pinCommand, root };
}

const unitText = (paths: ReturnType<typeof brainPaths>) =>
  readFile(join(paths.units, brainUnit), "utf8");

/** The same host for an ordinary run: the Launchpad's start, `lazurio
 * update`, a `lazurio brain setup` (no consent given for it). */
const withoutConsent = (host: SetupHost): SetupHost => {
  const { consent: _none, ...rest } = host;
  return rest;
};

describe("a consent counts only for the run that gave it", () => {
  test("a consent an earlier release recorded (after its refusal) never takes the brain over in an ordinary run", async () => {
    const { host, paths, calls } = await stand({ tagged: {} });
    // What 0.1.24-rc.6 left after `refused:release-unknown`.
    await writeBrainState(paths, {
      takeover: { consent: "2026-11-20T16:35:06.129Z" },
    });
    const before = await unitText(paths);
    const result = await brainSetup(host);
    expect(result).toMatchObject({
      server: "waits-takeover",
      takeover: "waits-consent",
    });
    expect(await unitText(paths)).toBe(before);
    expect(calls.some((c) => c[2] === "stop" || c[2] === "daemon-reload")).toBe(
      false,
    );
  });

  test("a consent given while Machines have not marked the handover, or with a foreign unit, does not wait for a later run", async () => {
    const { host, paths, root } = await stand({ consent: true, tagged: {} });
    await rm(join(root, "brain-handover"));
    expect((await brainSetup(host)).server).toBe("waits-machines");
    await writeFile(join(root, "brain-handover"), "");
    const later = await brainSetup(withoutConsent(host));
    expect(later).toMatchObject({ takeover: "waits-consent" });
    expect(await unitText(paths)).toBe(interimUnit);
    // A refresh unit nobody of these wrote blocks the run that consented;
    // once it is gone, an ordinary run still only reports.
    const foreign = join(paths.units, brainRefreshService);
    await writeFile(foreign, "[Service]\nExecStart=/opt/other\n");
    expect((await brainSetup(host)).server).toBe("foreign");
    await rm(foreign);
    expect((await brainSetup(withoutConsent(host))).takeover).toBe(
      "waits-consent",
    );
  });

  test("lazurio brain take-over gives its consent for its own run: an ordinary run after it does not take over", async () => {
    const { host, paths } = await stand({
      tagged: { lock: null, bunTag: null },
    });
    const context = {
      identity: {} as never,
      platform: "linux",
      env: {},
      executable: "lazurio",
      host,
    };
    // Refused: the release is not known for sure.
    const refused = await runBrainCommand(["take-over", "--json"], context);
    expect(JSON.parse(refused.stdout as string)).toMatchObject({
      takeover: "refused:release-unknown",
    });
    // The release becomes known (as a newer Lazurio would read it).
    await writeFile(
      join(
        paths.home,
        ".bun",
        "install",
        "global",
        "node_modules",
        "gbrain",
        ".bun-tag",
      ),
      "Lazurio-gbrain-5586fb4",
    );
    const ordinary = await runBrainCommand(["setup", "--json"], context);
    expect(JSON.parse(ordinary.stdout as string)).toMatchObject({
      server: "waits-takeover",
      takeover: "waits-consent",
    });
  });
});

describe("the interim installer's brain installed from a release tag", () => {
  test("its release is the commit Bun resolved the tag to: taken over and moved", async () => {
    const { host, paths } = await stand({ consent: true, tagged: {} });
    expect(await interimRelease(paths)).toEqual({
      commit: "5586fb4",
      version: interimVersion,
    });
    // Its owner sees it before consenting, read only.
    expect(await brainStatus(host)).toMatchObject({
      state: "adoptable",
      interimRelease: { commit: "5586fb4", version: interimVersion },
    });
    const result = await brainSetup(host);
    expect(result).toMatchObject({ takeover: "taken-over" });
    expect((await readBrainState(paths)).move?.previous).toMatchObject({
      commit: "5586fb4",
      version: interimVersion,
    });
  });

  test("only the lockfile or only .bun-tag is enough", async () => {
    for (const tagged of [{ bunTag: null }, { lock: null }]) {
      const { paths } = await stand({ tagged });
      expect((await interimRelease(paths))?.commit).toBe("5586fb4");
    }
  });

  test("a release not known for sure is refused, changes nothing and withdraws the consent", async () => {
    for (const tagged of [
      // Neither records the commit.
      { lock: null, bunTag: null },
      // They disagree.
      { bunTag: "1111111" },
      // The tag names another version than the package.
      { tag: "v0.60.316.0-lazurio.1" },
      // Not a release tag of the fork.
      { tag: "main" },
    ]) {
      const { host, paths, calls } = await stand({ consent: true, tagged });
      // The status says so before anyone consents.
      expect(await brainStatus(host)).toMatchObject({
        state: "adoptable",
        interimRelease: null,
      });
      const before = await unitText(paths);
      const result = await brainSetup(host);
      expect(result).toMatchObject({
        server: "takeover-refused",
        takeover: "refused:release-unknown",
      });
      expect(await unitText(paths)).toBe(before);
      expect(calls.some((c) => c[2] === "stop")).toBe(false);
      const takeover = (await readBrainState(paths)).takeover;
      expect(takeover?.consent).toBeUndefined();
      expect(takeover?.state).toBe("refused-release-unknown");
      // An ordinary later run (no consent of its own) only reports it.
      expect((await brainSetup(withoutConsent(host))).takeover).toBe(
        "waits-consent",
      );
    }
  });
});

describe("the check before a takeover tells what a consented run would meet", () => {
  test("with nothing in the way the check is empty, gives the sizes, and the takeover goes through", async () => {
    const { host, paths } = await stand({ consent: true, tagged: {} });
    const status = await brainStatus(host);
    expect(status).toMatchObject({
      state: "adoptable",
      interimRelease: { commit: "5586fb4", version: interimVersion },
      takeoverBlockers: [],
    });
    const room = status.state === "unsupported" ? undefined : status.brainRoom;
    // config.json, the admin token and the three keys, by their sizes.
    expect(room?.brainFiles).toBe(5);
    const mib = 1024 * 1024;
    expect(room?.neededBytes).toBe(
      3 * (room?.brainBytes as number) + 640 * mib + 768 * mib + 1024 * mib,
    );
    expect(room?.freeBytes).toBe(64 * 1024 ** 3);
    expect(await brainSetup(host)).toMatchObject({ takeover: "taken-over" });
    expect((await readBrainState(paths)).move?.result).toBe("done");
  });

  // Each blocker the check names, and what the consented run then does.
  const cases: ReadonlyArray<{
    blocker: string;
    options?: Options;
    arrange?: (s: Awaited<ReturnType<typeof stand>>) => Promise<void> | void;
    result: Record<string, unknown>;
    unitsKept: boolean;
  }> = [
    {
      blocker: "release-unknown",
      options: { tagged: { lock: null, bunTag: null } },
      result: { takeover: "refused:release-unknown" },
      unitsKept: true,
    },
    {
      blocker: "not-running",
      arrange: (s) => {
        s.systemd.running = null;
      },
      result: { takeover: "refused:not-running" },
      unitsKept: true,
    },
    {
      blocker: "other-version",
      arrange: (s) => {
        s.systemd.running = "0.60.316.0";
      },
      result: { takeover: "refused:other-version" },
      unitsKept: true,
    },
    {
      blocker: "command-missing",
      arrange: (s) => rm(s.paths.interimCommand),
      result: { takeover: "refused:command-missing" },
      unitsKept: true,
    },
    {
      blocker: "disk",
      options: { freeBytes: 1024 ** 3 },
      result: { takeover: "refused:disk" },
      unitsKept: true,
    },
    {
      blocker: "waits-machines",
      arrange: (s) => rm(join(s.root, "brain-handover")),
      result: { server: "waits-machines" },
      unitsKept: true,
    },
    {
      blocker: "restore-failed",
      arrange: (s) =>
        writeBrainState(s.paths, {
          takeover: { state: "restore-failed-reload", at: "2026-11-18" },
        }),
      result: { takeover: "restore-failed:reload" },
      unitsKept: true,
    },
    {
      blocker: "held",
      arrange: (s) =>
        writeBrainState(s.paths, {
          move: {
            to: brainPin.commit,
            from: interimVersion,
            at: "2026-11-18",
            result: "held",
          },
        } as never),
      // Taken over, and not moved: the pin was given up before.
      result: { server: "held", takeover: "taken-over" },
      unitsKept: false,
    },
  ];
  for (const c of cases)
    test(`${c.blocker}: named before, and the consented run meets it`, async () => {
      const s = await stand({ consent: true, tagged: {}, ...c.options });
      await c.arrange?.(s);
      expect(await brainStatus(withoutConsent(s.host))).toMatchObject({
        state: "adoptable",
        takeoverBlockers: [c.blocker],
      });
      const before = await unitText(s.paths);
      expect(await brainSetup(s.host)).toMatchObject(c.result);
      if (c.unitsKept) {
        expect(await unitText(s.paths)).toBe(before);
        expect(s.calls.some((call) => call[2] === "stop")).toBe(false);
      }
    });

  test("room that cannot be told counts as too little", async () => {
    const { host } = await stand({
      consent: true,
      tagged: {},
      freeBytes: null,
    });
    expect(await brainStatus(host)).toMatchObject({
      takeoverBlockers: ["disk"],
    });
    expect(await brainSetup(host)).toMatchObject({ takeover: "refused:disk" });
  });
});

describe("the interim installer's brain, its units exactly as it writes them", () => {
  test("is adoptable; with consent it is taken over in place and moved to the pin", async () => {
    const without = await stand({ installedUnits: true });
    expect(await brainStatus(without.host)).toMatchObject({
      state: "adoptable",
      owner: "interim",
    });
    const { host, paths } = await stand({
      installedUnits: true,
      consent: true,
    });
    const result = await brainSetup(host);
    expect(result).toMatchObject({ takeover: "taken-over" });
    expect(["moved", "waits-move"]).toContain(result.server);
    // The way back keeps all three units as the installer wrote them.
    const copy = interimUnitsCopy(paths);
    expect(await readFile(join(copy, brainUnit), "utf8")).toBe(
      interimServerUnit,
    );
    expect(await readFile(join(copy, brainRefreshService), "utf8")).toBe(
      interimRefreshService,
    );
    expect(await readFile(join(copy, brainRefreshTimer), "utf8")).toBe(
      interimRefreshTimer,
    );
  });

  test("a credential check before the start other than the installer's makes it foreign", async () => {
    const { host, paths } = await stand({ installedUnits: true });
    await writeFile(
      join(paths.units, brainUnit),
      interimServerUnit.replace(
        "ExecStartPre=/usr/bin/test -r %h/.gbrain/serve/admin-token",
        "ExecStartPre=/opt/other/check",
      ),
    );
    expect(await brainStatus(host)).toMatchObject({ owner: "foreign" });
    await writeFile(
      join(paths.units, brainUnit),
      interimServerUnit.replace(
        "Restart=on-failure",
        "ExecStartPost=/opt/other/after\nRestart=on-failure",
      ),
    );
    expect(await brainStatus(host)).toMatchObject({ owner: "foreign" });
  });
});

describe("the interim installer's brain", () => {
  test("without its owner's consent it is only reported, nothing is touched", async () => {
    const { host, paths, calls } = await stand();
    const result = await brainSetup(host);
    expect(result).toMatchObject({
      server: "waits-takeover",
      takeover: "waits-consent",
    });
    expect(calls).toEqual([]);
    expect(await unitText(paths)).toBe(interimUnit);
  });

  test("with consent it is taken over in place and moved to the pin with a copy", async () => {
    const { host, paths, calls, systemd, pinCommand } = await stand({
      consent: true,
    });
    const result = await brainSetup(host);
    expect(result).toMatchObject({
      server: "moved",
      takeover: "taken-over",
      move: "moved",
      keys: { launchpad: "kept", executor: "kept", probe: "kept" },
    });
    // The interim installer's units are kept for the way back.
    expect(
      await readFile(join(interimUnitsCopy(paths), brainUnit), "utf8"),
    ).toBe(interimUnit);
    // Lazurio's unit names the pin now; the brain before is in the copy.
    const unit = await unitText(paths);
    expect(unit.startsWith(unitMarker)).toBe(true);
    expect(unit).toContain(`exec ${pinCommand} serve --http`);
    expect(
      await readFile(
        join(paths.home, ".gbrain.bak-move-20261118T234000Z", "config.json"),
        "utf8",
      ),
    ).toBe('{"brain":"before"}');
    expect(systemd).toMatchObject({
      running: brainPin.version,
      timer: true,
    });
    // Nothing moved before systemd confirmed the server stopped.
    const stop = calls.findIndex(
      (c) => c[2] === "is-active" && c[3] === brainUnit,
    );
    const copyTaken = calls.findIndex((c) => c[2] === "daemon-reload");
    expect(stop).toBeGreaterThan(-1);
    expect(copyTaken).toBeGreaterThan(-1);
    const state = await readBrainState(paths);
    expect(state.release).toMatchObject({
      commit: brainPin.commit,
      source: "lazurio",
    });
    expect(state.move).toMatchObject({
      result: "done",
      pages: 46,
      previous: {
        command: paths.interimCommand,
        version: interimVersion,
        commit: interimCommit,
      },
    });
    // The vault the interim installer connected stays connected.
    expect(state.vault).toMatchObject({
      repo: "bob-example/bob-example-gbrain",
      onCommit: "2026-10-30",
    });
  });

  test("a pin that loses pages is refused: the copy and the previous release come back, and it is not tried again", async () => {
    const { host, paths, systemd } = await stand({
      consent: true,
      pinLosesPages: true,
    });
    const result = await brainSetup(host);
    expect(result).toMatchObject({ server: "held", move: "held" });
    expect(systemd.running).toBe(interimVersion);
    expect(await readFile(join(paths.brain, "config.json"), "utf8")).toBe(
      '{"brain":"before"}',
    );
    expect(await unitText(paths)).toContain(
      `exec ${paths.interimCommand} serve --http`,
    );
    const home = await readdir(paths.home);
    expect(home).toContain(".gbrain.failed-move-20261118T234000Z");
    expect((await readBrainState(paths)).move).toMatchObject({
      result: "held",
      reason: "page-count",
    });
    const again = await brainSetup(host);
    expect(again).toMatchObject({ server: "held", move: "held" });
    expect(systemd.running).toBe(interimVersion);
  });

  test("while Buddy works, it is taken over but not stopped", async () => {
    const { host, systemd, paths } = await stand({
      consent: true,
      idle: false,
    });
    const result = await brainSetup(host);
    expect(result).toMatchObject({
      server: "waits-move",
      takeover: "taken-over",
      move: "waits-idle",
    });
    expect(systemd.running).toBe(interimVersion);
    expect(await unitText(paths)).toContain(
      `exec ${paths.interimCommand} serve --http`,
    );
  });

  test("a server that does not stop is never copied or moved", async () => {
    const { host, paths } = await stand({ consent: true, neverStops: true });
    const result = await brainSetup(host);
    expect(result.move).toBe("waits:not-stopped");
    const home = await readdir(paths.home);
    expect(home.some((name) => name.startsWith(".gbrain.bak-move-"))).toBe(
      false,
    );
    expect(await unitText(paths)).toContain(
      `exec ${paths.interimCommand} serve --http`,
    );
    // The record names no copy, as none was taken; the server answers
    // again before the keys are converged, so none of them fails.
    expect((await readBrainState(paths)).move?.backup).toBeUndefined();
    expect(Object.values(result.keys ?? {})).not.toContain("failed");
  });

  test("a stop systemd does not confirm, then a server that does not answer again: setup stops before its keys and the vault", async () => {
    const { host, paths, calls, systemd } = await stand({ consent: true });
    const service = host.service;
    const down: SetupHost = {
      ...host,
      service: async (command, timeout, env) => {
        // systemd never confirms the stop, and the server stays down.
        if (command[2] === "is-active" && command.at(-1) === brainUnit)
          return { exitCode: 0, stdout: "active\n", stderr: "" };
        if (command[2] === "start" && command[3] === brainUnit)
          return { exitCode: 1, stdout: "", stderr: "" };
        return service(command, timeout, env);
      },
    };
    const result = await brainSetup(down);
    expect(result).toMatchObject({
      server: "failed",
      step: "answer",
      move: "waits:not-answering",
    });
    // Nothing asked the server that does not answer: no key, no vault.
    expect(result.keys).toBeUndefined();
    expect(result.vault).toBeUndefined();
    expect(systemd.running).toBeNull();
    expect((await readBrainState(paths)).move).toMatchObject({
      result: "waits:not-answering",
    });
    expect((await readBrainState(paths)).move?.backup).toBeUndefined();
    void calls;
    // The next run, whose start works, brings the server back (it is not
    // running, so setup starts it and converges its keys); the run after
    // moves it to the pin.
    const again = await brainSetup(host);
    expect(again.server).toBe("started");
    expect(Object.values(again.keys ?? {})).not.toContain("failed");
    expect(await brainSetup(host)).toMatchObject({
      server: "moved",
      move: "moved",
    });
  });

  test("the server stopped as systemd confirms through the person's user manager: moved", async () => {
    // A systemctl that, like the real one, reaches the user manager only
    // with XDG_RUNTIME_DIR in its environment: the stop is read back as
    // stopped, so the copy is taken and the pin reached (on an Environment
    // this read once got no environment and answered `waits:not-stopped`).
    const { host, paths } = await stand({ consent: true });
    const result = await brainSetup(host);
    expect(result).toMatchObject({ server: "moved", move: "moved" });
    const home = await readdir(paths.home);
    expect(home.some((name) => name.startsWith(".gbrain.bak-move-"))).toBe(
      true,
    );
  });
});

describe("a takeover interrupted or not put back", () => {
  test("a run that dies after the units are written is put back by the next, which takes over again", async () => {
    const { host, paths, systemd } = await stand({ consent: true });
    // What a run leaves when it dies right after writing the units: the
    // copy, the journal, and Lazurio's units naming the interim command.
    const copy = interimUnitsCopy(paths);
    await mkdir(copy, { recursive: true });
    for (const name of [brainUnit, brainRefreshTimer])
      await writeFile(
        join(copy, name),
        await readFile(join(paths.units, name)),
      );
    const before = await readBrainState(paths);
    await writeBrainState(paths, {
      ...before,
      takeover: {
        ...before.takeover,
        state: "taking-over",
        release: { commit: interimCommit, version: interimVersion },
        created: [brainRefreshService],
      },
    });
    await writeBrainUnits(paths, paths.interimCommand, false, {
      takeOver: true,
    });
    expect(await brainStatus(host)).toMatchObject({ owner: "lazurio" });
    // The units read as Lazurio's now; the journal stops the next run from
    // moving them as such: the interim installer's come back first, and the
    // takeover runs again (without it, the move would run and the takeover
    // would never be recorded done).
    // Taken over again, recorded, and moved.
    const result = await brainSetup(host);
    expect(result).toMatchObject({ server: "moved", takeover: "taken-over" });
    expect((await readBrainState(paths)).takeover).toMatchObject({
      state: "done",
      // The record of the consent this run took it over with.
      consent: "2026-11-18T23:40:00.000Z",
    });
    expect((await readBrainState(paths)).takeover?.created).toBeUndefined();
    expect(systemd.running).toBe(brainPin.version);
  });

  test("a way back that systemd does not reload is not called restored, and waits for a person", async () => {
    const { host, paths, calls } = await stand({ consent: true });
    const service = host.service;
    const broken: SetupHost = {
      ...host,
      service: async (command, timeout, env) =>
        command[2] === "daemon-reload"
          ? { exitCode: 1, stdout: "", stderr: "" }
          : service(command, timeout, env),
    };
    const result = await brainSetup(broken);
    expect(result).toMatchObject({
      server: "takeover-refused",
      takeover: "restore-failed:reload",
    });
    expect((await readBrainState(paths)).takeover?.state).toBe(
      "restore-failed-reload",
    );
    calls.length = 0;
    const again = await brainSetup(host);
    expect(again).toMatchObject({
      server: "takeover-refused",
      takeover: "restore-failed:reload",
    });
    expect(
      calls.some((c) => c[0] === "systemctl" && c[2] !== "is-active"),
    ).toBe(false);
  });
});

describe("the refresh timer after a move", () => {
  test("a timer that does not start again is reported failed, exit 1, and started by the next run", async () => {
    const { host, systemd } = await stand({ consent: true });
    const service = host.service;
    let timerStarts = false;
    const stuck: SetupHost = {
      ...host,
      service: async (command, timeout, env) =>
        !timerStarts &&
        command.includes(brainRefreshTimer) &&
        (command[2] === "start" ||
          (command[2] === "enable" && command.includes("--now")))
          ? { exitCode: 1, stdout: "", stderr: "" }
          : service(command, timeout, env),
    };
    const context = {
      identity: {} as never,
      platform: "linux",
      env: {},
      executable: "lazurio",
    };
    const first = await runBrainCommand(["setup", "--json"], {
      ...context,
      host: stuck,
    });
    expect(JSON.parse(first.stdout as string)).toMatchObject({
      server: "moved",
      timer: "failed",
    });
    expect(first.code).toBe(1);
    expect(systemd.timer).toBe(false);
    timerStarts = true;
    const again = await runBrainCommand(["setup", "--json"], {
      ...context,
      host: stuck,
    });
    expect(JSON.parse(again.stdout as string)).toMatchObject({
      server: "running",
      timer: "started",
    });
    expect(again.code).toBe(0);
    expect(systemd.timer).toBe(true);
  });
});

describe("one run at a time", () => {
  test("two runs at once: one does the work, the other changes nothing and says busy; the lock is released after", async () => {
    const { host, systemd } = await stand({ consent: true });
    const results = await Promise.all([brainSetup(host), brainSetup(host)]);
    expect(results.map((r) => r.server).sort()).toEqual(["busy", "moved"]);
    expect(systemd.running).toBe(brainPin.version);
    expect((await brainSetup(host)).server).toBe("running");
  });
});

describe("a move that stopped or was interrupted", () => {
  test("a stopped move keeps the server down and disabled, even on a later run", async () => {
    const { host, paths, calls, systemd } = await stand({ consent: true });
    await brainSetup(host);
    const state = await readBrainState(paths);
    await writeBrainState(paths, {
      ...state,
      move: {
        ...(state.move as NonNullable<typeof state.move>),
        result: "stopped:previous-no-answer",
      },
    });
    calls.length = 0;
    const result = await brainSetup(host);
    expect(result.server).toBe("stopped");
    expect(calls.some((c) => c[2] === "start")).toBe(false);
    expect(calls).toContainEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      brainUnit,
    ]);
    expect(systemd).toMatchObject({ server: false, serverEnabled: false });
  });

  test("a run that died while moving is finished: the pin is accepted once it answers as required", async () => {
    const { host, paths, systemd } = await stand({ consent: true });
    await brainSetup(host);
    const state = await readBrainState(paths);
    await writeBrainState(paths, {
      ...state,
      move: {
        ...(state.move as NonNullable<typeof state.move>),
        result: "moving",
      },
    });
    systemd.server = false;
    systemd.running = null;
    const result = await brainSetup(host);
    expect(result).toMatchObject({ server: "moved", move: "moved" });
    expect(systemd.running as string | null).toBe(brainPin.version);
  });
});

describe("lazurio brain take-over", () => {
  test("while another run holds the lock, the consent is not recorded and that run's journal stays as it wrote it", async () => {
    const { host, paths } = await stand();
    const journal = {
      move: {
        from: "0.60.315.0",
        to: brainPin.commit,
        result: "moving",
        at: "2026-11-19T00:00:00.000Z",
      },
    } as never;
    await writeBrainState(paths, journal);
    const before = await readFile(paths.state, "utf8");
    const lock = await acquireFileLock(
      join(dirname(paths.state), "setup.lock"),
      { timeoutMs: 0 },
    );
    try {
      const result = await runBrainCommand(["take-over"], {
        identity: {} as never,
        platform: "linux",
        env: {},
        executable: "lazurio",
        host,
      });
      expect(result.stdout?.split("\n")[0]).toBe("server busy");
      expect(result.code).toBe(2);
    } finally {
      await lock.release();
    }
    expect(await readFile(paths.state, "utf8")).toBe(before);
    expect((await readBrainState(paths)).takeover).toBeUndefined();
  });

  test("records the owner's consent, takes over and moves, and prints closed labels only, never a key", async () => {
    const { host, paths } = await stand();
    const context = {
      identity: {} as never,
      platform: "linux",
      env: {},
      executable: "lazurio",
      host,
    };
    const secrets = [
      "a".repeat(64),
      "l".repeat(32),
      "e".repeat(32),
      "p".repeat(32),
      paths.home,
    ];
    const text = await runBrainCommand(["take-over"], context);
    expect(text.code).toBe(0);
    expect(text.stderr).toBeUndefined();
    expect(text.stdout?.split("\n")).toEqual([
      "server moved",
      "key launchpad kept",
      "key executor kept",
      "key probe kept",
      "takeover taken-over",
      "move moved",
    ]);
    const json = await runBrainCommand(["setup", "--json"], context);
    expect(JSON.parse(json.stdout as string)).toMatchObject({
      server: "running",
    });
    for (const output of [text, json])
      for (const secret of secrets)
        expect(`${output.stdout}${output.stderr ?? ""}`).not.toContain(secret);
    expect((await readBrainState(paths)).takeover?.consent).toBeDefined();
  });
});
