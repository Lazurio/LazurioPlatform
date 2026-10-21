import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  moduleCopy,
  moduleLink,
  moduleResultMessage,
  moduleSettling,
  moduleStatusView,
  offersDevelopment,
  parseModuleResult,
} from "../src/launchpad/module-view";
import type {
  ModuleAnswer,
  ModuleBlocked,
} from "../src/modules/module-operations";

// The module page's lifecycle (slice P5) as pure presentation: the dot, the
// sentence, the one primary action and Open.
const en = messages("en");
const cs = messages("cs");

const answer = (extra: Partial<ModuleAnswer> = {}): ModuleAnswer => ({
  kind: "module",
  operation: "status",
  organization: "alpha",
  module: "web",
  app: "app/package.json",
  runner: "systemd-user",
  survivesLaunchpadRestart: true,
  outcome: "status",
  state: "running",
  healthy: true,
  service: { unit: "lazurio-app-x.service", invocationId: "0".repeat(32) },
  runtime: { url: "https://web.workspace.example.lazurio.io/" },
  ...extra,
});
const refusal = (reason: string): ModuleBlocked => ({
  kind: "blocked",
  operation: "start",
  reason,
});

test("the answer is read only in its exact shape", () => {
  expect(parseModuleResult(answer())).toEqual(answer());
  expect(parseModuleResult(refusal("port-occupied"))).toEqual(
    refusal("port-occupied"),
  );
  for (const value of [
    null,
    [],
    "running",
    { error: "operation-failed" },
    { ...answer(), state: "exploded" },
    { ...answer(), healthy: "yes" },
    { ...answer(), runtime: "https://web.example" },
    { kind: "blocked", operation: "start" },
  ])
    expect(parseModuleResult(value)).toBeNull();
});

test("Open accepts only the root of an https hostname or of a loopback port", () => {
  for (const url of [
    "https://web.workspace.example.lazurio.io/",
    "http://127.0.0.1:4400/",
    "http://[::1]:4400/",
    "http://localhost:4400/",
  ])
    expect(moduleLink(url)).toBe(url);
  for (const url of [
    "http://web.workspace.example.lazurio.io/",
    "https://web.example.lazurio.io/path",
    "https://web.example.lazurio.io/?q=1",
    "https://user:secret@web.example.lazurio.io/",
    "http://127.0.0.1/",
    "javascript:alert(1)",
    "https://web.example.lazurio.io",
    1,
    null,
  ])
    expect(moduleLink(url)).toBeNull();
});

test("the page offers Start when stopped, Stop while it runs, and Open only with a link", () => {
  expect(
    moduleStatusView(
      answer({ state: "stopped", healthy: false, runtime: null }),
      en,
    ),
  ).toEqual({
    dot: "stopped",
    text: "Stopped",
    code: null,
    ownership: null,
    action: "start",
    link: null,
    noLink: null,
  });
  expect(moduleStatusView(answer(), en)).toEqual({
    dot: "running",
    text: "Running",
    code: null,
    ownership: en.moduleKeepsRunning,
    action: "stop",
    link: "https://web.workspace.example.lazurio.io/",
    noLink: null,
  });
  // A session app says it ends with the Launchpad.
  expect(
    moduleStatusView(answer({ survivesLaunchpadRestart: false }), cs),
  ).toMatchObject({ ownership: cs.moduleSessionBound, text: "Běží" });
  // Healthy without a link: no Open, and why, in words.
  expect(
    moduleStatusView(
      answer({ runtime: null, runtimeReason: "hosted-entry-missing" }),
      en,
    ),
  ).toMatchObject({ link: null, noLink: en.moduleNoLinkEntry, action: "stop" });
  expect(
    moduleStatusView(
      answer({ runtime: null, runtimeReason: "hosted-app-not-default" }),
      cs,
    ),
  ).toMatchObject({ link: null, noLink: cs.moduleNoLinkApp });
  // A link in any other form is not offered.
  expect(
    moduleStatusView(answer({ runtime: { url: "http://evil.example/" } }), en),
  ).toMatchObject({ link: null, noLink: "No link: link-invalid." });
  // Starting, not ready, stopping, ended.
  expect(
    moduleStatusView(
      answer({ state: "starting", healthy: false, runtime: null }),
      en,
    ),
  ).toMatchObject({
    dot: "starting",
    text: "Starting…",
    action: "stop",
    link: null,
  });
  expect(
    moduleStatusView(answer({ healthy: false, runtime: null }), en),
  ).toMatchObject({ dot: "starting", text: "Running, not ready yet" });
  expect(
    moduleStatusView(
      answer({ state: "stopping", healthy: false, runtime: null }),
      en,
    ),
  ).toMatchObject({ action: null });
  expect(
    moduleStatusView(
      answer({ state: "ended", healthy: false, runtime: null }),
      en,
    ),
  ).toMatchObject({ dot: "failed", action: "stop" });
  // Not read yet, or a refusal of the status: no action, no claim.
  expect(moduleStatusView(null, en)).toMatchObject({
    dot: "unknown",
    action: null,
  });
  expect(moduleStatusView(refusal("service-unrecognized"), en)).toMatchObject({
    dot: "unknown",
    code: "service-unrecognized",
    text: en.appServiceUnrecognized,
    action: null,
  });
});

test("the sentence after Start or Stop names what happened or why not", () => {
  expect(
    moduleResultMessage(
      answer({ operation: "start", outcome: "started", healthy: false }),
      en,
    ),
  ).toBe(en.moduleStarted);
  expect(
    moduleResultMessage(answer({ operation: "start", outcome: "started" }), cs),
  ).toBe(cs.moduleStartedHealthy);
  expect(moduleResultMessage(answer({ outcome: "already-managed" }), en)).toBe(
    en.moduleAlreadyRunning,
  );
  expect(moduleResultMessage(answer({ outcome: "group-stopped" }), en)).toBe(
    en.moduleStoppedDone,
  );
  expect(moduleResultMessage(answer({ outcome: "not-managed" }), en)).toBe(
    en.moduleNotRunning,
  );
  // A start or preparation still running at the route's deadline (F34).
  for (const copy of [en, cs]) {
    expect(
      moduleResultMessage(
        answer({ outcome: "start-pending", state: "stopped", healthy: false }),
        copy,
      ),
    ).toBe(copy.moduleStartPending);
    expect(
      moduleResultMessage(
        answer({
          operation: "prepare",
          outcome: "prepare-pending",
          state: "stopped",
          healthy: false,
        }),
        copy,
      ),
    ).toBe(copy.modulePreparePending);
  }
  expect(moduleResultMessage(refusal("toolchain-missing"), cs)).toBe(
    cs.moduleReasonToolchain,
  );
  expect(moduleResultMessage(refusal("port-occupied"), en)).toBe(
    en.moduleReasonPortOccupied,
  );
  // At a module's start the check failed after the start prepared the app
  // (decision F34).
  for (const copy of [en, cs])
    expect(moduleResultMessage(refusal("prerequisites-not-ready"), copy)).toBe(
      copy.modulePrerequisitesNotReady,
    );
  // A refused file of the module's checkout is named (decision F23), and a
  // refusal whose file is not text is not read at all.
  const refused: ModuleBlocked = {
    ...refusal("declaration-not-regular"),
    file: "app/dependency/package.json",
  };
  expect(parseModuleResult(refused)).toEqual(refused);
  expect(parseModuleResult({ ...refused, file: 7 })).toBeNull();
  for (const copy of [en, cs]) {
    const sentence = moduleResultMessage(refused, copy);
    expect(sentence).toContain("app/dependency/package.json");
    expect(sentence).not.toContain("{file}");
    expect(moduleStatusView(refused, copy).text).toBe(sentence);
    expect(moduleStatusView(refused, copy).code).toBe(
      "declaration-not-regular",
    );
  }
  // A refusal of the preparation (decision F25) names its file too.
  for (const [reason, file] of [
    ["preparation-lockfile-missing", "app/package.json"],
    ["preparation-lockfile-unused", "app/bun.lock"],
    ["preparation-install-failed", "app/bun.lock"],
    ["preparation-script-failed", "app/package.json"],
    ["preparation-toolchain-mismatch", "app/package.json"],
    // A required slot that is not there (root decision 0176 point 4) names
    // the slot, relative to the Organization root.
    ["required-slot-undeclared", "workspace/prices"],
    ["required-slot-planned", "workspace/prices"],
    ["required-slot-missing", "workspace/prices"],
    // A module's own data mount it could not provide (launchpad-parity B7)
    // names its slot too.
    ["data-mount-denied", "workspace/orders/db"],
    ["data-mount-occupied", "workspace/orders/db"],
    ["data-mount-unavailable", "workspace/orders/db"],
    ["data-mount-clone-failed", "workspace/orders/db"],
  ] as const)
    for (const copy of [en, cs]) {
      const sentence = moduleResultMessage({ ...refusal(reason), file }, copy);
      expect(sentence).toContain(file);
      expect(sentence).not.toContain("{file}");
      expect(sentence).not.toContain(reason);
    }
  // An unknown code is named, never guessed; a lost answer is unknown.
  expect(moduleResultMessage(refusal("something-new"), en)).toBe(
    "Refused: something-new.",
  );
  expect(moduleResultMessage(null, en)).toBe(en.appResultUnknown);
});

test("on a Team Environment a data mount GitHub refuses names the Team's access, never a person's account (#488)", () => {
  const denied = {
    ...refusal("data-mount-denied"),
    file: "workspace/orders/db",
  };
  for (const copy of [en, cs]) {
    const team = moduleResultMessage(denied, moduleCopy(copy, true));
    const own = moduleResultMessage(denied, moduleCopy(copy, false));
    expect(team).toContain("workspace/orders/db");
    expect(team).not.toBe(own);
    expect(own).toBe(moduleResultMessage(denied, copy));
    // Every other refusal reads the same on both.
    const unavailable = {
      ...refusal("data-mount-unavailable"),
      file: "workspace/orders/db",
    };
    expect(moduleResultMessage(unavailable, moduleCopy(copy, true))).toBe(
      moduleResultMessage(unavailable, copy),
    );
  }
  expect(moduleResultMessage(denied, moduleCopy(en, true))).not.toContain(
    "your GitHub account",
  );
  expect(moduleResultMessage(denied, moduleCopy(en, true))).toContain("Team");
  expect(moduleResultMessage(denied, moduleCopy(cs, true))).not.toContain(
    "váš účet",
  );
  expect(moduleResultMessage(denied, moduleCopy(cs, true))).toContain(
    "Týmové Prostředí",
  );
});

test("the page keeps reading the status only while a started app settles", () => {
  expect(moduleSettling(answer({ state: "starting", healthy: false }))).toBe(
    true,
  );
  expect(moduleSettling(answer({ healthy: false }))).toBe(true);
  expect(moduleSettling(answer())).toBe(false);
  expect(moduleSettling(answer({ state: "stopped", healthy: false }))).toBe(
    false,
  );
  expect(moduleSettling(refusal("port-occupied"))).toBe(false);
  expect(moduleSettling(null)).toBe(false);
});

test("a start refused for its runtime secrets names each one and why, and a start without optional ones says so, in both languages (decision F46)", () => {
  const refused: ModuleBlocked = {
    ...refusal("runtime-secret-unavailable"),
    secrets: [
      { name: "EXTERNAL_API_KEY", reason: "missing" },
      { name: "SECOND_KEY", reason: "missing" },
      { name: "THIRD_KEY", reason: "ambiguous" },
    ],
  };
  expect(parseModuleResult(refused)).toEqual(refused);
  expect(
    parseModuleResult({ ...refused, secrets: [{ name: "EXTERNAL_API_KEY" }] }),
  ).toBeNull();
  expect(moduleResultMessage(refused, en)).toBe(
    "The app was not started: it needs secrets that this Environment's vault did not give it. EXTERNAL_API_KEY, SECOND_KEY: no item of this name in this Environment's vault; THIRD_KEY: more than one item of this name in this Environment's vault. Values are never shown; add or fix the item named exactly like the secret in this Environment's vault and start again.",
  );
  const czech = moduleResultMessage(refused, cs);
  expect(czech).toContain("EXTERNAL_API_KEY, SECOND_KEY: v trezoru");
  expect(czech).toContain(
    "THIRD_KEY: v trezoru tohoto Prostředí je víc položek",
  );
  // In the Environment it is shown in, the vault is that kind's (F28's
  // addendum of 2026-10-18).
  expect(moduleResultMessage(refused, messages("cs", "team"))).toContain(
    "THIRD_KEY: v trezoru tohoto Týmového Prostředí je víc položek",
  );
  expect(moduleStatusView(refused, cs).code).toBe("runtime-secret-unavailable");
  for (const copy of [en, cs])
    for (const reason of [
      "personalspace",
      "workstation",
      "no-vault-identity",
      "other-organization",
      "not-connected",
      "locked",
      "busy",
      "unreachable",
      "vault-failed",
      "empty",
    ] as const) {
      const sentence = moduleResultMessage(
        { ...refused, secrets: [{ name: "EXTERNAL_API_KEY", reason }] },
        copy,
      );
      expect(sentence).toContain("EXTERNAL_API_KEY: ");
      // In words, never the bare code.
      expect(sentence).not.toContain(`EXTERNAL_API_KEY: ${reason}`);
      expect(sentence).not.toContain("{secrets}");
    }
  const started = answer({
    operation: "start",
    outcome: "started",
    secretsNotProvided: [{ name: "OPTIONAL_KEY", reason: "not-connected" }],
  });
  expect(parseModuleResult(started)).toEqual(started);
  expect(moduleResultMessage(started, en)).toBe(
    `${en.moduleStartedHealthy} Started without these optional secrets, so the capabilities that need them are off: OPTIONAL_KEY: the vault is not set up yet (Settings → Tools → bitwarden).`,
  );
  expect(moduleResultMessage(started, cs)).toContain(
    "Spuštěno bez těchto volitelných tajných údajů",
  );
});

test("a static app's build (decision F58): building before it runs, its outcomes, and a build that failed offers the development version, in both languages", () => {
  const build = {
    mode: null,
    served: null,
    current: null,
    building: {
      commit: "a".repeat(40),
      at: "2026-10-20T08:00:00.000Z",
      queued: false,
    },
    failure: null,
  } as const;
  const building = moduleStatusView(
    answer({ state: "stopped", healthy: false, runtime: null, build }),
    cs,
  );
  expect(building).toMatchObject({
    dot: "starting",
    text: "Sestavuje se…",
    action: null,
  });
  // A build waiting for its turn behind another app's reads the same.
  expect(
    moduleStatusView(
      answer({
        state: "stopped",
        healthy: false,
        runtime: null,
        build: {
          ...build,
          building: {
            commit: null,
            at: "2026-10-20T08:00:00.000Z",
            queued: true,
          },
        },
      }),
      en,
    ),
  ).toMatchObject({ dot: "starting", text: "Building…", action: null });
  for (const [outcome, english] of [
    ["build-pending", en.moduleBuildPending],
    ["built", en.moduleBuilt],
    ["current", en.moduleBuildCurrent],
  ] as const)
    expect(moduleResultMessage(answer({ outcome }), en)).toBe(english);
  const failed: ModuleBlocked = {
    ...refusal("build-script-failed"),
    build: {
      mode: null,
      served: null,
      current: null,
      building: null,
      failure: {
        commit: "b".repeat(40),
        at: "2026-10-20T08:01:00.000Z",
        reason: "build-script-failed",
        log: "~/.cache/lazurio/builds/alpha/web/web-0123/logs/b.log",
      },
    },
  };
  // Plain words, never the log's path (that is for the CLI and the agent).
  expect(moduleResultMessage(failed, cs)).toBe(
    "Aplikaci se nepodařilo sestavit.",
  );
  expect(moduleResultMessage(failed, en)).toBe("The app could not be built.");
  // With an earlier build (an explicit build that failed), it keeps running.
  const withPrevious: ModuleBlocked = {
    ...failed,
    build: {
      ...(failed.build as NonNullable<ModuleBlocked["build"]>),
      current: {
        key: "e".repeat(40),
        commit: "e".repeat(40),
        at: "2026-10-20T07:00:00.000Z",
        dirty: false,
      },
    },
  };
  expect(moduleResultMessage(withPrevious, cs)).toBe(
    "Nejnovější verzi se nepodařilo sestavit. Dál běží předchozí verze.",
  );
  expect(moduleResultMessage(withPrevious, en)).toBe(
    "The newest version could not be built. The previous version keeps running.",
  );
  for (const result of [failed, withPrevious])
    for (const copy of [en, cs]) {
      expect(moduleResultMessage(result, copy)).not.toContain("/");
      expect(moduleStatusView(result, copy).text).not.toContain("/");
    }
  expect(offersDevelopment(failed)).toBe(true);
  expect(offersDevelopment(refusal("build-timed-out"))).toBe(true);
  // Other refusals and answers never offer it.
  expect(offersDevelopment(refusal("port-occupied"))).toBe(false);
  expect(offersDevelopment(refusal("build-busy"))).toBe(false);
  expect(offersDevelopment(answer())).toBe(false);
  expect(offersDevelopment(null)).toBe(false);
  for (const reason of [
    "build-timed-out",
    "build-output-missing",
    "build-output-unservable",
    "build-busy",
    "checkout-changing",
  ])
    for (const copy of [en, cs])
      expect(moduleResultMessage(refusal(reason), copy)).not.toContain(reason);
});

test("a running built app whose newest build failed says so in plain words; one that runs its development version does not; a built run that ended offers its development version (decision F58)", () => {
  const failure = {
    commit: "d".repeat(40),
    at: "2026-10-20T08:02:00.000Z",
    reason: "build-script-failed",
    log: "~/.cache/lazurio/builds/alpha/web/web-0123/logs/d.log",
  };
  const build = {
    mode: "built" as const,
    served: { key: "e".repeat(40), commit: "e".repeat(40) },
    current: {
      key: "e".repeat(40),
      commit: "e".repeat(40),
      at: "2026-10-20T08:00:00.000Z",
      dirty: false,
    },
    building: null,
    failure,
  };
  expect(moduleStatusView(answer({ build }), cs).buildNote).toBe(
    "Nejnovější verzi se nepodařilo sestavit. Dál běží předchozí verze.",
  );
  expect(
    moduleStatusView(answer({ build: { ...build, failure: null } }), en)
      .buildNote,
  ).toBeUndefined();
  expect(
    moduleStatusView(
      answer({ build: { ...build, mode: "dev", served: null } }),
      en,
    ).buildNote,
  ).toBeUndefined();
  // A built run that ended by itself (an app's own server whose new commit
  // does not start, the addendum of 2026-10-21) offers the development
  // version; a development run that ended does not.
  const ended = { state: "ended" as const, healthy: false, runtime: null };
  expect(
    moduleStatusView(
      answer({ ...ended, build: { ...build, failure: null } }),
      cs,
    ),
  ).toMatchObject({
    dot: "failed",
    text: cs.moduleEnded,
    action: "stop",
    development: true,
  });
  expect(
    moduleStatusView(
      answer({ ...ended, build: { ...build, mode: "dev", served: null } }),
      cs,
    ).development,
  ).toBeUndefined();
  expect(moduleStatusView(answer(ended), cs).development).toBeUndefined();
});
