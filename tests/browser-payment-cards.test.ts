import { expect, test } from "bun:test";
import {
  observePaymentCards,
  paymentCardsReasons,
  paymentCardsVerdict,
} from "../src/browser/payment-cards";
import type { CdpConnection } from "../src/browser/people/cdp";
import {
  browserExtensionIdOf,
  browserExtensionWorker,
} from "../src/browser/people/extension";
import type { EnvironmentBrowserObservation } from "../src/browser/units";
import {
  doctorCheckIds,
  doctorGroupOf,
  doctorReasons,
} from "../src/doctor/doctor";

// F39's addendum of 2026-11-15, Pablo's review of #994: whether Chrome's
// saving and filling of payment cards is really off in the Environment
// browser is read from Chrome itself, through the Lazurio extension's worker
// over DevTools on loopback. A protection that does not hold, or cannot be
// read, is never reported as holding; doctor warns and never fails.

const directory = "/home/person/.local/share/lazurio-browser/extension";
const id = browserExtensionIdOf(directory);
const workerUrl = `chrome-extension://${id}/${browserExtensionWorker}`;
const browserOk: EnvironmentBrowserObservation = { outcome: "ok" };

type Answer = Readonly<{ value?: unknown; levelOfControl?: unknown }>;

/** A scripted DevTools peer of the Environment browser: its targets, a
 * worker that is running or stopped, what `startWorker` does, and what the
 * worker answers. Every call is recorded. */
function peer(
  options: Readonly<{
    running?: boolean;
    wakes?: boolean;
    answer?: Answer | "throws";
    targets?: readonly Record<string, unknown>[];
    otherWorker?: boolean;
  }> = {},
) {
  const calls: {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }[] = [];
  let running = options.running ?? true;
  let closed = false;
  const sessions = new Map<string, string>();
  let next = 1;
  const others = options.targets ?? [
    {
      targetId: "UI",
      type: "browser_ui",
      url: "chrome://omnibox-popup.top-chrome/",
    },
    { targetId: "TAB", type: "page", url: "https://shop.example/checkout" },
  ];
  const connection: CdpConnection = {
    send: async (method, params = {}, sessionId) => {
      calls.push({
        method,
        params: { ...params },
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      switch (method) {
        case "Target.getTargets":
          return {
            targetInfos: [
              ...others,
              ...(options.otherWorker
                ? [
                    {
                      targetId: "OTHER",
                      type: "service_worker",
                      url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js",
                    },
                  ]
                : []),
              ...(running
                ? [
                    {
                      targetId: "WORKER",
                      type: "service_worker",
                      url: workerUrl,
                    },
                  ]
                : []),
            ],
          };
        case "Target.attachToTarget": {
          const session = `S${next++}`;
          sessions.set(session, String(params.targetId));
          return { sessionId: session };
        }
        case "Target.detachFromTarget":
          return {};
        case "ServiceWorker.enable":
        case "ServiceWorker.disable":
          return {};
        case "ServiceWorker.startWorker":
          if (options.wakes ?? true) running = true;
          return {};
        case "Runtime.evaluate": {
          if (sessions.get(String(sessionId)) !== "WORKER")
            throw new Error("not the worker");
          const answer = options.answer ?? {
            value: false,
            levelOfControl: "controlled_by_this_extension",
          };
          if (answer === "throws")
            return {
              result: { type: "object" },
              exceptionDetails: { text: "Uncaught" },
            };
          return { result: { type: "object", value: answer } };
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    onEvent: () => {},
    onClose: () => {},
    close: () => {
      closed = true;
    },
  };
  return { connection, calls, closed: () => closed };
}

const observe = (
  p: ReturnType<typeof peer>,
  browser: EnvironmentBrowserObservation = browserOk,
) =>
  observePaymentCards({
    browser,
    directory,
    connect: async () => p.connection,
    realpath: async (path) => path,
    sleep: async () => {},
  });

test("the card protection holds only when Chrome says the setting is off and held by the Lazurio extension, or off by a policy", () => {
  expect(
    paymentCardsVerdict({
      value: false,
      levelOfControl: "controlled_by_this_extension",
    }),
  ).toEqual({ outcome: "ok" });
  // A Chrome policy that turns it off holds even against the settings page.
  expect(
    paymentCardsVerdict({ value: false, levelOfControl: "not_controllable" }),
  ).toEqual({
    outcome: "ok",
    context: { cardControl: "not_controllable" },
  });
  // On: a policy, another extension, or the person's own choice turned it on.
  for (const levelOfControl of [
    "not_controllable",
    "controlled_by_other_extensions",
    "controllable_by_this_extension",
    "controlled_by_this_extension",
  ])
    expect(paymentCardsVerdict({ value: true, levelOfControl })).toEqual({
      outcome: "warn",
      reason: "payment-cards-unprotected",
      context: { cardControl: levelOfControl },
    });
  // Off now, but not held: the settings page or another extension can turn
  // it on, and Chrome then offers "Save card?" outside the page.
  for (const levelOfControl of [
    "controlled_by_other_extensions",
    "controllable_by_this_extension",
  ])
    expect(paymentCardsVerdict({ value: false, levelOfControl })).toEqual({
      outcome: "warn",
      reason: "payment-cards-not-held",
      context: { cardControl: levelOfControl },
    });
  // Anything else is an answer nobody can trust.
  for (const answer of [
    undefined,
    null,
    {},
    { value: "false" },
    { value: false },
    { value: false, levelOfControl: "maybe" },
  ])
    expect(paymentCardsVerdict(answer)).toEqual({
      outcome: "warn",
      reason: "payment-cards-unverified",
      context: { cardCause: "unexpected-answer" },
    });
});

test("doctor reads the setting from the running worker of the Lazurio extension, read only", async () => {
  const p = peer();
  expect(await observe(p)).toEqual({ outcome: "ok" });
  const worker = p.calls.find(
    (call) => call.method === "Target.attachToTarget",
  );
  expect(worker?.params).toEqual({ targetId: "WORKER", flatten: true });
  const evaluate = p.calls.find((call) => call.method === "Runtime.evaluate");
  const expression = String(evaluate?.params.expression);
  // It reads Chrome's setting and never sets or clears it.
  expect(expression).toContain(
    "chrome.privacy.services.autofillCreditCardEnabled.get(",
  );
  expect(expression).not.toMatch(/\.(set|clear)\(/);
  expect(evaluate?.params).toMatchObject({
    awaitPromise: true,
    returnByValue: true,
  });
  // No tab, window or worker is opened, closed or stopped, nothing is woken
  // when the worker runs, and the connection is closed.
  expect(p.calls.map((call) => call.method)).toEqual([
    "Target.getTargets",
    "Target.attachToTarget",
    "Runtime.evaluate",
    "Target.detachFromTarget",
  ]);
  expect(p.closed()).toBe(true);
});

test("a stopped worker is started over DevTools from Chrome's own interface, never a person's tab, then read", async () => {
  const p = peer({ running: false });
  expect(await observe(p)).toEqual({ outcome: "ok" });
  const methods = p.calls.map((call) => call.method);
  expect(methods.slice(0, 7)).toEqual([
    "Target.getTargets",
    "Target.attachToTarget",
    "ServiceWorker.enable",
    "ServiceWorker.startWorker",
    "ServiceWorker.disable",
    "Target.detachFromTarget",
    "Target.getTargets",
  ]);
  expect(p.calls[1]?.params).toEqual({ targetId: "UI", flatten: true });
  expect(p.calls[3]?.params).toEqual({ scopeURL: `chrome-extension://${id}/` });
  expect(methods).not.toContain("Target.createTarget");
  expect(methods).not.toContain("Target.closeTarget");
  expect(methods).not.toContain("ServiceWorker.stopWorker");
  // Without Chrome's interface targets, a page's session starts it.
  const pageOnly = peer({
    running: false,
    targets: [{ targetId: "TAB", type: "page", url: "https://shop.example/" }],
  });
  expect(await observe(pageOnly)).toEqual({ outcome: "ok" });
  expect(pageOnly.calls[1]?.params).toEqual({ targetId: "TAB", flatten: true });
});

test("a protection that does not hold or cannot be read is a warning, never ok and never fail", async () => {
  // A policy or another extension turned card saving on.
  expect(
    await observe(
      peer({ answer: { value: true, levelOfControl: "not_controllable" } }),
    ),
  ).toEqual({
    outcome: "warn",
    reason: "payment-cards-unprotected",
    context: { cardControl: "not_controllable" },
  });
  // Another extension holds it.
  expect(
    await observe(
      peer({
        answer: {
          value: false,
          levelOfControl: "controlled_by_other_extensions",
        },
      }),
    ),
  ).toEqual({
    outcome: "warn",
    reason: "payment-cards-not-held",
    context: { cardControl: "controlled_by_other_extensions" },
  });
  // The extension is turned off or not loaded: no worker of it starts. Another
  // extension's worker is never read instead.
  const off = peer({ running: false, wakes: false, otherWorker: true });
  expect(await observe(off)).toEqual({
    outcome: "warn",
    reason: "payment-cards-unverified",
    context: { cardCause: "extension-not-running" },
  });
  expect(off.calls.some((call) => call.method === "Runtime.evaluate")).toBe(
    false,
  );
  expect(off.closed()).toBe(true);
  // The worker cannot answer (no privacy permission, an older worker).
  expect(await observe(peer({ answer: "throws" }))).toEqual({
    outcome: "warn",
    reason: "payment-cards-unverified",
    context: { cardCause: "worker-unreadable" },
  });
  // No interface or page target to start the worker from.
  expect(await observe(peer({ running: false, targets: [] }))).toEqual({
    outcome: "warn",
    reason: "payment-cards-unverified",
    context: { cardCause: "extension-not-running" },
  });
  // DevTools does not answer.
  expect(
    await observePaymentCards({
      browser: browserOk,
      directory,
      connect: async () => {
        throw new Error("refused");
      },
      realpath: async (path) => path,
      sleep: async () => {},
    }),
  ).toEqual({
    outcome: "warn",
    reason: "payment-cards-unverified",
    context: { cardCause: "browser-unreachable" },
  });
});

test("without a running Environment browser the check is skipped, as the browser's own", async () => {
  const p = peer();
  expect(
    await observe(p, { outcome: "skipped", reason: "not-hosted" }),
  ).toEqual({
    outcome: "skipped",
    reason: "not-hosted",
  });
  for (const reason of [
    "browser-unit-not-loaded",
    "browser-unit-failed",
    "browser-unit-inactive",
    "browser-not-answering",
  ])
    expect(await observe(p, { outcome: "warn", reason })).toEqual({
      outcome: "skipped",
      reason: "browser-not-running",
    });
  expect(p.calls).toEqual([]);
  // The view not answering leaves the browser itself to be read.
  expect(
    await observe(p, { outcome: "warn", reason: "browser-view-not-answering" }),
  ).toEqual({ outcome: "ok" });
});

test("the extension's id is Chrome's id of an unpacked extension: from the real path of its directory", async () => {
  // Chrome for Testing 156 loaded this repository's extension from
  // ~/.local/share/lazurio-browser/extension of a home at this path under
  // the id it reported over DevTools (F39's addendum of 2026-11-15).
  expect(
    browserExtensionIdOf(
      "/home/station-01/.local/share/lazurio-browser/extension",
    ),
  ).toBe("oegabammdcoeeggajigofdobfdemknpo");
  expect(id).toMatch(/^[a-p]{32}$/);
  // The directory's real path names the id, as Chrome resolves it.
  const p = peer({ running: false });
  await observePaymentCards({
    browser: browserOk,
    directory: "/home/link/extension",
    connect: async () => p.connection,
    realpath: async () => directory,
    sleep: async () => {},
  });
  expect(
    p.calls.find((call) => call.method === "ServiceWorker.startWorker")?.params,
  ).toEqual({
    scopeURL: `chrome-extension://${id}/`,
  });
});

test("doctor carries the check in the Machine group with its reasons", () => {
  expect(doctorCheckIds).toContain("browser-payment-cards");
  expect(doctorGroupOf["browser-payment-cards"]).toBe("machine");
  for (const reason of paymentCardsReasons)
    expect(doctorReasons).toContain(reason);
});
