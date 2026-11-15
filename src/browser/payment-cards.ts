import { realpath as fsRealpath } from "node:fs/promises";
import type { CdpConnection } from "./people/cdp";
import { browserExtensionIdOf } from "./people/extension";
import type { EnvironmentBrowserObservation } from "./units";

/** Whether Chrome's saving and filling of payment cards is really off in the
 * Environment browser (decision F39's addendum of 2026-11-15, Pablo's review
 * of LazurioPlatform#994), for `lazurio doctor` (check `browser-payment-cards`).
 *
 * The Lazurio extension asks Chrome to keep "Save and fill payment methods"
 * off, but a Chrome policy or another extension can win over it, Chrome can
 * refuse it, and a person can turn the extension off. Only Chrome knows what
 * applies, so doctor asks Chrome: over DevTools on loopback (the browser's own
 * port), in the extension's worker, it reads
 * `chrome.privacy.services.autofillCreditCardEnabled.get({})`. The protection
 * holds when the value is off and held by the extension, or off by a policy;
 * everything else is a warning, never `ok`, and never `fail`: an Environment
 * works without its browser, and the Machines preflight stops on any `fail`.
 *
 * Read only: no tab or window is opened or closed and nothing is set. Chrome
 * stops an idle extension worker after about 30 s; doctor then starts it
 * (`ServiceWorker.startWorker`) from a session on one of Chrome's own
 * interface targets, or on a page when there is none, as a new tab starts it.
 * A worker that starts runs as on every start, so it asks Chrome for the
 * setting again; doctor waits for that (`lazurioPaymentCards`) and then reads
 * Chrome's answer itself. Nothing is retried and nothing is repaired. */

export const paymentCardsReasons = [
  "payment-cards-unprotected",
  "payment-cards-not-held",
  "payment-cards-unverified",
  "browser-not-running",
] as const;

export type PaymentCardsObservation = Readonly<{
  outcome: "ok" | "warn" | "skipped";
  reason?: string;
  context?: Readonly<Record<string, string>>;
}>;

const levels = [
  "not_controllable",
  "controlled_by_other_extensions",
  "controllable_by_this_extension",
  "controlled_by_this_extension",
] as const;
type Level = (typeof levels)[number];

/** The causes of `payment-cards-unverified`, in doctor's context. */
export const paymentCardsCauses = [
  "browser-unreachable",
  "extension-not-running",
  "worker-unreadable",
  "unexpected-answer",
] as const;
type Cause = (typeof paymentCardsCauses)[number];

const unverified = (cause: Cause): PaymentCardsObservation =>
  Object.freeze({
    outcome: "warn",
    reason: "payment-cards-unverified",
    context: Object.freeze({ cardCause: cause }),
  });

/** What Chrome's answer (`{value, levelOfControl}`) means for a payment. */
export function paymentCardsVerdict(answer: unknown): PaymentCardsObservation {
  const { value, levelOfControl } = (answer ?? {}) as Record<string, unknown>;
  if (typeof value !== "boolean" || !levels.includes(levelOfControl as Level))
    return unverified("unexpected-answer");
  const context = Object.freeze({ cardControl: levelOfControl as Level });
  if (value)
    return Object.freeze({
      outcome: "warn",
      reason: "payment-cards-unprotected",
      context,
    });
  if (levelOfControl === "controlled_by_this_extension")
    return Object.freeze({ outcome: "ok" });
  // A Chrome policy keeps it off, also against the settings page.
  if (levelOfControl === "not_controllable")
    return Object.freeze({ outcome: "ok", context });
  // Off now, but the settings page or another extension can turn it on.
  return Object.freeze({
    outcome: "warn",
    reason: "payment-cards-not-held",
    context,
  });
}

/** The browser check's warnings that mean no browser to ask. */
const notRunning = new Set([
  "browser-unit-not-loaded",
  "browser-unit-failed",
  "browser-unit-inactive",
  "browser-not-answering",
]);

const readExpression = `(async () => {
  try { await globalThis.lazurioPaymentCards; } catch {}
  const setting = await chrome.privacy.services.autofillCreditCardEnabled.get({});
  return { value: setting.value, levelOfControl: setting.levelOfControl };
})()`;

type Target = Readonly<{ targetId: string; type: string; url: string }>;

const workerOf = (targets: readonly Target[], id: string) =>
  targets.find(
    (target) =>
      target.type === "service_worker" &&
      target.url.startsWith(`chrome-extension://${id}/`) &&
      /\/background(?:-[0-9a-f]{12})?\.js$/.test(target.url),
  );

export async function observePaymentCards(
  input: Readonly<{
    /** The `environment-browser` check of the same run. */
    browser: EnvironmentBrowserObservation;
    /** The extension's directory (`browserExtensionDirectory(home)`). */
    directory: string;
    /** A DevTools connection to the Environment browser on loopback. */
    connect: () => Promise<CdpConnection>;
    realpath?: (path: string) => Promise<string>;
    sleep?: (ms: number) => Promise<void>;
  }>,
): Promise<PaymentCardsObservation> {
  if (input.browser.outcome === "skipped")
    return Object.freeze({
      outcome: "skipped",
      reason: input.browser.reason ?? "browser-not-running",
    });
  if (
    input.browser.outcome === "warn" &&
    notRunning.has(input.browser.reason ?? "")
  )
    return Object.freeze({ outcome: "skipped", reason: "browser-not-running" });
  const directory = await (input.realpath ?? fsRealpath)(input.directory).catch(
    () => input.directory,
  );
  const id = browserExtensionIdOf(directory);
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let cdp: CdpConnection;
  try {
    cdp = await input.connect();
  } catch {
    return unverified("browser-unreachable");
  }
  try {
    const targets = async () =>
      ((await cdp.send("Target.getTargets")).targetInfos ?? []) as Target[];
    const attach = async (targetId: string) =>
      String(
        (await cdp.send("Target.attachToTarget", { targetId, flatten: true }))
          .sessionId,
      );
    let worker: Target | undefined;
    try {
      const listed = await targets();
      worker = workerOf(listed, id);
      if (worker === undefined) {
        // Started from Chrome's own interface, never a person's tab, unless
        // there is no such target.
        const from =
          listed.find((target) => target.type === "browser_ui") ??
          listed.find((target) => target.type === "page");
        if (from === undefined) return unverified("extension-not-running");
        const session = await attach(from.targetId);
        try {
          await cdp.send("ServiceWorker.enable", {}, session);
          await cdp.send(
            "ServiceWorker.startWorker",
            { scopeURL: `chrome-extension://${id}/` },
            session,
          );
          await cdp.send("ServiceWorker.disable", {}, session).catch(() => {});
        } finally {
          await cdp
            .send("Target.detachFromTarget", { sessionId: session })
            .catch(() => {});
        }
        // Chrome answers startWorker at once, also for an extension it does
        // not run; the worker is there once it lists it.
        for (let attempt = 0; attempt < 10 && worker === undefined; attempt++) {
          if (attempt > 0) await sleep(300);
          worker = workerOf(await targets(), id);
        }
        if (worker === undefined) return unverified("extension-not-running");
      }
    } catch {
      return unverified("browser-unreachable");
    }
    let session: string;
    try {
      session = await attach(worker.targetId);
    } catch {
      return unverified("worker-unreadable");
    }
    try {
      const answer = await cdp.send(
        "Runtime.evaluate",
        { expression: readExpression, awaitPromise: true, returnByValue: true },
        session,
      );
      if (answer.exceptionDetails !== undefined)
        return unverified("worker-unreadable");
      return paymentCardsVerdict(
        (answer.result as { value?: unknown } | undefined)?.value,
      );
    } catch {
      return unverified("worker-unreadable");
    } finally {
      await cdp
        .send("Target.detachFromTarget", { sessionId: session })
        .catch(() => {});
    }
  } finally {
    cdp.close();
  }
}
