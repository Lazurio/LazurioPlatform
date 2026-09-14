import { expect, test } from "bun:test";
import {
  applicationMessage,
  discoveredApplicationChoices,
  localApplicationLink,
} from "../src/launchpad/application-view";
import { messages } from "../src/launchpad/messages";

test("discovery presentation exposes only declared application choices, not conflicts or invalid runtime", () => {
  const good = {
    module: "web",
    kind: "module-observed",
    apps: [{ package: "app/package.json", kind: "runtime-declared" }],
  };
  expect(
    discoveredApplicationChoices({
      kind: "applications-observed",
      company: "Example",
      entries: [
        good,
        good,
        { ...good, kind: "declaration-conflict" },
        {
          ...good,
          module: "bad",
          apps: [{ package: "app/package.json", kind: "invalid-runtime" }],
        },
        {
          ...good,
          module: "unsafe",
          apps: [{ package: "../package.json", kind: "runtime-declared" }],
        },
      ],
    }),
  ).toEqual([
    { company: "Example", module: "web", package: "app/package.json" },
  ]);
  for (const input of [
    null,
    [],
    {},
    { kind: "unavailable" },
    { kind: "applications-observed", company: "Example", entries: null },
  ])
    expect(discoveredApplicationChoices(input)).toEqual([]);
});

test("application presentation distinguishes start, health, stop and failed preparation", () => {
  for (const locale of ["cs", "en"]) {
    const copy = messages(locale);
    for (const [value, key] of [
      [{ kind: "started" }, "appStarted"],
      [{ kind: "status", observedHealthy: true }, "appHealthy"],
      [{ kind: "status", observedHealthy: false }, "appNotReady"],
      [{ kind: "group-stopped" }, "appStopped"],
      [{ kind: "denied" }, "appDenied"],
      [{ error: "applications-unavailable" }, "appUnavailable"],
      [{ kind: "preparation-failed" }, "appFailure"],
      [{ kind: "prerequisites-not-ready" }, "appPrerequisitesNotReady"],
      [
        { kind: "preparation-preflight-failed" },
        "appPreparationPreflightFailed",
      ],
      [
        { kind: "preparation-cleanup-required" },
        "appPreparationCleanupRequired",
      ],
      [{ kind: "other-app-managed" }, "appOtherAppManaged"],
      [
        { kind: "application-cleanup-required" },
        "appPreparationCleanupRequired",
      ],
      [{ kind: "declaration-changed" }, "appDeclarationChanged"],
      [{ kind: "scope-changed" }, "appDeclarationChanged"],
    ] as const) {
      expect(applicationMessage(value, true)).toBe(key);
      expect(copy[key].length).toBeGreaterThan(0);
    }
  }
});

test("only explicit loopback web links can be shown, remote context is not local opening", () => {
  expect(localApplicationLink("http://localhost:12345/")).toBe(
    "http://localhost:12345/",
  );
  expect(
    localApplicationLink("http://localhost.example.invalid:12345/"),
  ).toBeNull();
  expect(localApplicationLink("http://127.0.0.1:12345/")).toBe(
    "http://127.0.0.1:12345/",
  );
  expect(localApplicationLink("http://[::1]:12345/")).toBe(
    "http://[::1]:12345/",
  );
  for (const url of [
    "javascript:alert(1)",
    "https://example.invalid/",
    "http://127.0.0.1/",
    "http://user:password@127.0.0.1:12345/",
    "http://127.0.0.1:12345/?token=private",
    "http://127.0.0.1:12345/health",
  ]) {
    expect(localApplicationLink(url)).toBeNull();
    expect(applicationMessage({ kind: "local-entrypoint", url }, true)).toBe(
      "appFailure",
    );
  }
  const value = { kind: "local-entrypoint", url: "http://127.0.0.1:12345/" };
  expect(applicationMessage(value, true)).toBe("appLinkReady");
  expect(applicationMessage(value, false)).toBe("appRemoteLink");
});
