import {
  type AccountLanguage,
  cachedAccountFor,
  readShellAccount,
  rememberAccount,
  type Store,
} from "./account";
import {
  type AccountVisit,
  type Shell,
  type ShellAccount,
  type ShellSignedOut,
  shellSignedOutSchema,
} from "./contract";
import { accountLastBySpace, mergeAccount } from "./merge";
import type { ShellApp } from "./view";

// What the shell elements draw, shared by every element of a page (decision
// F36, F37 and F36's addendum of 2026-10-05): the page's own document
// (`provideShell`), the person's account, the two merged (merge.ts) and the
// account's last visit per space. Kept apart from the elements, which need a
// DOM, so that who reads, remembers and reports the account is tested
// without one.
//
// The page's own document is one of two (F36's addendum of 2026-10-06):
// `lazurio.shell.v1` while a person is signed in, or, on a host's page with
// nobody signed in, `lazurio.shell-signed-out.v1`. `provideShell` takes
// either, and the later replaces the earlier. Signed out there is no person
// to merge an account into, remember or report: `drawn` is null, so the
// column head draws nothing, and the rail draws the signed-out document
// alone (`signedOut`). The account is left as it was; the host provides it
// as always (none, while nobody is signed in).
//
// The account has one of two sources, decided once per page:
// - This origin (the default: the Launchpad page and the forks). The
//   elements share one bounded account read cycle, draw at once from
//   the account this origin remembered for its operator and keep the fresh
//   answer for the next page load (account.ts), and report the last
//   Environment (`PUT /.lazurio/account/last`, last.ts).
// - The host (`<html data-lazurio-account="host">`): a page that has the
//   person's account itself, the Dashboard, which is no Environment and
//   whose origin relays no account. It provides the parsed document with
//   `provideAccount` (null: none). The elements then never request the
//   account, never read or write the remembered one (`lazurio.account.v1`
//   in `localStorage`) and never report a last Environment.
//
// On this origin the read waits for the page's document, a person's or the
// signed-out one, and asks in its language (F37's addendum of 2026-11-03):
// the Dashboard words `name` and `who` by `Accept-Language`, and only an
// answer in the document's language names the Environments (merge.ts). The
// account is drawn only merged into that document, so the wait delays
// nothing that could be drawn sooner; where the host hands the document over
// before the elements connect (the Launchpad's boot document), the read
// starts at once. Where the page's first read of its document ends without one
// (`documentUnavailable`: a refusal such as a session the gateway no longer
// admits, an invalid answer, the retries spent), the account is read anyway,
// without a language (the browser's own header), as before: its `401` is what
// re-enters the Environment to sign in again (F37's addendum of 2026-10-12),
// and a page that waited for a document that never comes would never recover.

/** Who provides the person's account on a page. */
export type AccountSource = "host" | "origin";

/** The source `<html data-lazurio-account>` names: the host only for exactly
 * `host`; anything else, or no attribute, is this origin. */
export const accountSourceOf = (
  marker: string | null | undefined,
): AccountSource => (marker === "host" ? "host" : "origin");

export type ShellStateOptions = Readonly<{
  /** Asked once, when first needed (the elements read the document's
   * marker as they connect), and kept for the page's life. */
  source: () => AccountSource;
  /** The account document's JSON of this page (`pageAccountJson`), asked
   * in the language of the page's document; null (the browser's own
   * header) where the page has none (`documentUnavailable`). */
  read: (language: AccountLanguage | null) => Promise<unknown>;
  /** The report of the last Environment (`reportLast`). */
  report: (shell: Shell, app: ShellApp | null, space: string | null) => void;
  /** This origin's memory of the account; the browser's when absent. */
  store?: Store | null;
  /** The offline guide's registration (decision F41, `registerGuide`),
   * asked with every person's document; it acts once per page. */
  guide?: (shell: Shell) => void;
  /** The browser tab's icon (F36's addendum of 2026-10-08, `applyTabIcon`),
   * asked with every person's document. */
  tabIcon?: (shell: Shell) => void;
  /** The Environment theme in the page's document (F36's addendum of
   * 2026-10-18, theme.ts), asked with every person's document. */
  theme?: (shell: Shell) => void;
  log?: (message: string) => void;
}>;

export function createShellState(options: ShellStateOptions) {
  // The page's own document: a person's, or the signed-out one; never both.
  let local: Shell | null = null;
  let signedOut: ShellSignedOut | null = null;
  let account: ShellAccount | null = null;
  let drawn: Shell | null = null;
  let lastBySpace: ReadonlyMap<string, AccountVisit> = new Map();
  const listeners = new Set<() => void>();
  const log = options.log ?? ((message: string) => console.debug(message));
  let source: AccountSource | null = null;
  const sourceNow = (): AccountSource => {
    source ??= options.source();
    return source;
  };

  /** The rail at once from the account this origin remembered, then the
   * fresh answer (account.ts, `accountCacheKey`). Both directions need the
   * document's operator, so they wait for the document: the remembered
   * account is used only when it is the operator's own, and the fresh one is
   * kept only then (a Team Environment, which names no operator, does
   * neither). A host's page does neither. */
  let rememberedUsed = false;
  function useRemembered(): void {
    if (rememberedUsed || account !== null || local === null) return;
    if (sourceNow() === "host") return;
    rememberedUsed = true;
    const remembered = cachedAccountFor(local.operator.login, options.store);
    if (remembered === null) return;
    account = remembered;
  }

  /** This page's fresh answer, once read (only ever on this origin), and
   * whether it was offered to this origin's memory (once, as soon as the
   * document names the operator). */
  let fresh: ShellAccount | null = null;
  let freshOffered = false;
  function keepFresh(): void {
    if (fresh === null || freshOffered || local === null) return;
    freshOffered = true;
    rememberAccount(fresh, local.operator.login, options.store);
  }

  function redraw(): void {
    useRemembered();
    keepFresh();
    drawn = local === null ? null : mergeAccount(local, account);
    lastBySpace =
      drawn === null ? new Map() : accountLastBySpace(drawn, account);
    for (const listener of listeners) listener();
  }

  let requested = false;
  let reading = false;
  /** The page's first read of its document ended without one. */
  let documentMissing = false;

  /** What this page's account read on its own origin answered: still
   * `pending`, an `account`, or `none` (no relay yet, which is `404` on
   * today's gateways; a refusal; a slow or failed answer). The last
   * Environment is reported through the same relay, so only after the read
   * answered with an account: where it found none the write could only fail
   * (a `405` without the relay), and the browser would show that failure. A
   * report asked before the read answered waits for it. */
  let freshRead: "pending" | "account" | "none" = "pending";
  let pendingReport: Readonly<{
    app: ShellApp | null;
    space: string | null;
  }> | null = null;
  function flushReport(): void {
    const asked = pendingReport;
    pendingReport = null;
    if (asked === null || freshRead !== "account" || drawn === null) return;
    options.report(drawn, asked.app, asked.space);
  }

  /** The page's one read on this origin, once requested and once the
   * page's document names its language, or without one once the page's
   * read of its document ended without a document; never on a host's
   * page. */
  function startRead(): void {
    if (!requested || reading) return;
    const language =
      (signedOut ?? local)?.locale ?? (documentMissing ? null : undefined);
    if (language === undefined || sourceNow() === "host") return;
    reading = true;
    void readShellAccount(() => options.read(language), log).then((read) => {
      if (read !== null) {
        fresh = read;
        account = read;
        // The elements report as they redraw; while the read still counts
        // as pending their reports join the queue, so the first one asked
        // with an app is the one sent, once.
        redraw();
        freshRead = "account";
        flushReport();
        return;
      }
      freshRead = "none";
      pendingReport = null;
      // Without a fresh answer, the remembered one stays only while this
      // origin still keeps it: a final refusal removed it, and a `401`
      // that re-enters the Environment kept it, so the rail does not
      // shrink while the page reloads (F37's addendum of 2026-10-12).
      const next =
        local === null
          ? null
          : cachedAccountFor(local.operator.login, options.store);
      if (next === account) return;
      account = next;
      redraw();
    });
  }

  return {
    /** The page's document as provided, before the merge: a person's, or
     * the signed-out one. */
    local: (): Shell | ShellSignedOut | null => signedOut ?? local,
    /** What the elements draw while a person is signed in: the document
     * merged with the account; null before a document and signed out. */
    drawn: (): Shell | null => drawn,
    /** The page's signed-out document while nobody is signed in (a host's
     * page); null otherwise. The rail draws the logo and the sign-in key
     * from it. */
    signedOut: (): ShellSignedOut | null => signedOut,
    /** The account's last visit per space of the drawn document. */
    lastBySpace: (): ReadonlyMap<string, AccountVisit> => lastBySpace,
    /** Calls `listener` after every change; returns its removal. */
    listen(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Gives the elements the page's document, which replaces the one
     * before; they redraw. A person's is merged with their account once
     * there is one; the signed-out one is drawn alone. */
    provideShell(shell: Shell | ShellSignedOut): void {
      if (shell.schema === shellSignedOutSchema) {
        local = null;
        signedOut = shell;
      } else {
        signedOut = null;
        local = shell;
        options.guide?.(shell);
        options.tabIcon?.(shell);
        options.theme?.(shell);
      }
      redraw();
      startRead();
    },
    /** The host's account (parsed by `parseShellAccount`; null: none), only
     * on a page marked `<html data-lazurio-account="host">`. Elsewhere the
     * elements read the account on their own origin, and this is ignored
     * with one debug line rather than raced against that read. */
    provideAccount(provided: ShellAccount | null): void {
      if (sourceNow() !== "host") {
        log(
          'Lazurio shell: provideAccount needs <html data-lazurio-account="host">; this page reads the account on its own origin.',
        );
        return;
      }
      account = provided;
      redraw();
    },
    /** Reads the account on this origin once per page; nothing on a host's
     * page, which provides it. */
    requestAccount(): void {
      if (requested) return;
      requested = true;
      startRead();
    },
    /** The page's own read of its document ended without one (a refusal,
     * an invalid answer, the retries spent) while it has none: the account
     * is read without a language, so its refusal can still re-enter the
     * Environment. Nothing once the page has a document. */
    documentUnavailable(): void {
      if (local !== null || signedOut !== null) return;
      documentMissing = true;
      startRead();
    },
    /** The report of the last Environment for an element that names its
     * app; never on a host's page (no `PUT /.lazurio/account/last`), and
     * `lastVisit` sends nothing from a page that is no Environment's. On
     * this origin only once the account read answered with an account: one
     * asked before then waits for the answer, and none is sent when the
     * read found no account. */
    report(app: ShellApp | null, space: string | null): void {
      if (sourceNow() === "host" || freshRead === "none") return;
      if (freshRead === "pending") {
        if (
          pendingReport === null ||
          (pendingReport.app === null && app !== null)
        )
          pendingReport = { app, space };
        return;
      }
      if (drawn === null) return;
      options.report(drawn, app, space);
    },
  };
}

export type ShellState = ReturnType<typeof createShellState>;
