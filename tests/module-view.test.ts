import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  moduleLink,
  moduleResultMessage,
  moduleSettling,
  moduleStatusView,
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
  expect(moduleResultMessage(refusal("toolchain-missing"), cs)).toBe(
    cs.moduleReasonToolchain,
  );
  expect(moduleResultMessage(refusal("port-occupied"), en)).toBe(
    en.moduleReasonPortOccupied,
  );
  expect(moduleResultMessage(refusal("prerequisites-not-ready"), en)).toBe(
    en.appPrerequisitesNotReady,
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
  // An unknown code is named, never guessed; a lost answer is unknown.
  expect(moduleResultMessage(refusal("something-new"), en)).toBe(
    "Refused: something-new.",
  );
  expect(moduleResultMessage(null, en)).toBe(en.appResultUnknown);
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
