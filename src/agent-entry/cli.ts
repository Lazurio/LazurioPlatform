import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { browserCommand } from "../browser/cli";
import { browserViewUrl, threadSession } from "../browser/contract/pure";
import { browserEntryOf } from "../browser/view";
import {
  BrowserWindowFailure,
  cdpSeams,
  openInThreadWindow,
  type WindowSeams,
} from "../browser/window";
import type { MachineBinding } from "../folder/machine-binding";
import {
  LaunchpadStartRefused,
  readStartState,
} from "../launchpad/start-check";
import {
  MachineContextError,
  type MachineContextSource,
  productionMachineContextSource,
  readMachineContext,
} from "../machine/context";
import {
  type RelayTransport,
  unixSocketTransport,
} from "../organization-settings/relay";
import type { AccountSharedApplication } from "../shell/contract";
import {
  type CliContext,
  type CommandOutput,
  operatorFolder,
} from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import { runProcess } from "../update/self-check";
import { createAgentEntryRelay, type RelayRefusalReason } from "./relay";
import { agentEntrySwitchPage } from "./switch-page";

/** `lazurio apps`: an agent's way into the applications colleagues share
 * with its user (Lazurio Auth docs/agent-application-entry.md, "The
 * Environment browser and the Folder"; root decisions 0231 and 0234; plan
 * LZD-0009 M9). */
export const appsHelp = `apps shared [--folder <absolute Folder>] [--json]
  The applications colleagues share with the user (decision 0231), read from
  the Dashboard through this Environment's relay as this Environment, never
  with the user's sign-in: each with its Organization, Module, name, the
  user's role there (admin: Application Admin, user: Application User), who
  shares it and the command that opens it. The list is for finding an
  application; Lazurio Auth and the hosting Environment decide every entry.
  --json prints {schema: "lazurio.folder.shared-applications.v1", kind:
  "shared-applications", agentEntry, sharedApplications, next_steps};
  agentEntry "off" means the user switched agents in colleagues'
  applications off for this Environment, and the list is empty.
apps open <module> --org <organization> [--host <login>] [--session <name>] [--folder <absolute Folder>] [--json]
  Opens one application of that list in the calling thread's window of the
  Environment browser, as the user with their application role: it asks
  Lazurio Auth through the relay for a one-time hand-over for the entry's
  application (--host chooses where several colleagues share a Module of
  that name) with this Environment's assignment generation, and opens the
  answered address unchanged in the window (a new one when the thread has
  none). It never composes an address, never opens the list's address
  itself, and opens nothing without Auth's 200. The hand-over is valid for
  60 s and once, and is never printed. The session is found as for lazurio
  browser window. --json prints {schema, kind: "shared-application-opened",
  organization, module, name, url, role, session, targetId, link, command};
  url is the application's origin, link the user's view of the tab.
Every refusal of either prints its code and what it means, with --json
{schema, kind: "blocked", reason, message, next_steps} (a browser failure
after the hand-over: kind "failed"). agent_entry_off: the user switched it
off for this Environment; only they switch it on, on the Dashboard page
next_steps names; never get around it. Exit status: 0 listed or opened, 2
usage or refused, 10 this Environment has no relay or no Environment
browser (nothing asked or opened), 1 failure.`;

const synopsis =
  "apps shared [--folder <absolute Folder>] [--json] | apps open <module> --org <organization> [--host <login>] [--session <name>] [--folder <absolute Folder>] [--json]";

/** The Folder's list and every answer of these commands. */
export const folderSharedApplicationsSchema =
  "lazurio.folder.shared-applications.v1";

/** Nothing is available here: no relay, no Environment browser. */
const exitUnavailable = 10;

export type AppsContext = CliContext &
  Readonly<{
    /** Tests only: the transport to the relay at the Folder's socket. */
    relayTransport?: ((socket: string) => RelayTransport) | undefined;
    /** Tests only: where the handover and its receipt are read. */
    machineSource?: MachineContextSource | undefined;
    /** Tests only: the browser and agent-browser behind the window. */
    windowSeams?: WindowSeams | undefined;
  }>;

type LocalReason =
  | "relay-absent"
  | "no-browser"
  | "no-session"
  | "not-shared"
  | "host-ambiguous"
  | "assignment-pending"
  | "assignment-released"
  | "machine-context-unreadable";
type FailureReason = BrowserWindowFailure["reason"];
type Reason = RelayRefusalReason | LocalReason | FailureReason;
type Locale = "cs" | "en";

/** What each refusal means, one or two sentences in the Folder's language,
 * for the agent and for the user it tells; never a path or a value. */
const meanings: Readonly<Record<Locale, Record<Reason, string>>> = {
  en: {
    "relay-absent":
      "This Environment has no relay to Lazurio (its handover names none). Only an Environment with its own identity at Lazurio Auth lists and opens colleagues' applications for its agents.",
    "relay-unreachable":
      "This Environment's relay did not answer, or Lazurio behind it did not.",
    "relay-unsupported":
      "This Environment's relay does not offer agents' entry into colleagues' applications yet; it comes with an update of the Environment.",
    "relay-answer-invalid":
      "The answer through the relay is not what Lazurio's contract says, so it was not used and nothing was opened.",
    refused:
      "Lazurio refused the request with a code this version of Lazurio does not know.",
    environment_identity_unavailable:
      "The relay has no token of this Environment's identity yet, so it cannot ask as this Environment.",
    bearer_missing:
      "The Dashboard did not get a token of this Environment from the relay.",
    token_expired:
      "The Dashboard did not accept the relay's token of this Environment: it had expired.",
    token_invalid:
      "The Dashboard did not accept the relay's token of this Environment.",
    scope_not_allowed_here:
      "The relay sent a token of another use for this read: a fault of this Environment's relay.",
    insufficient_scope:
      "The relay sent a token without the scope of this read: a fault of this Environment's relay.",
    environment_unknown:
      "The Dashboard does not know this Environment as one with its own identity at Lazurio Auth, so it lists nothing for it.",
    invalid_request:
      "Lazurio Auth refused the form of the request: a fault of this Environment's Lazurio, not of the application.",
    unauthorized:
      "Lazurio Auth did not accept this Environment as the one acting: it has no identity of its own there, or its token was refused.",
    not_found:
      "The application's address belongs to no registered Environment (any more).",
    agent_entry_identity_absent:
      "This Environment's registration at Lazurio Auth has no identity, so its agents cannot act in colleagues' applications.",
    environment_state_conflict:
      "This Environment is not assigned to a person right now (free, suspended or released), so its agents act for nobody.",
    assignment_generation_conflict:
      "This Environment's assignment changed since it last read it (for example a suspension and a resumption), so Lazurio Auth refused the request.",
    agent_entry_off:
      "The user switched agents in colleagues' applications off for this Environment.",
    agent_entry_own_environment:
      "The application runs on this Environment itself: its agents open it here directly, without a hand-over.",
    agent_entry_other_organization:
      "This Work Environment acts only in its own Organization, and the application belongs to another one.",
    agent_entry_not_member:
      "The user is not an enabled member of the application's Organization (any more).",
    application_record_inconsistent:
      "Lazurio Auth's records of the application's Organization are inconsistent, so nothing can be decided now.",
    agent_entry_no_role:
      "The user has no application role in this application now, or it is no longer available.",
    management_temporarily_unavailable: "Lazurio Auth is briefly unavailable.",
    "no-browser":
      "This Environment has no Environment browser, so there is no window to open the application in; nothing was asked.",
    "no-session":
      "No thread session to open the application in; nothing was asked.",
    "not-shared":
      "No colleague shares an application of that name in that Organization with the user.",
    "host-ambiguous":
      "More than one colleague shares an application of that name in that Organization; nothing was asked.",
    "assignment-pending":
      "This Environment is not assigned to anybody yet, so its agents act for nobody; nothing was asked.",
    "assignment-released":
      "This Environment's assignment was released, so its agents act for nobody any more; nothing was asked.",
    "machine-context-unreadable":
      "This Environment's handover could not be read, so its assignment is unknown; nothing was asked.",
    "browser-unreachable":
      "The Environment browser does not answer on loopback. The hand-over was not used and expires within a minute.",
    "window-create-failed":
      "The Environment browser did not open a window. The hand-over was not used and expires within a minute.",
    "bind-failed":
      "A window opened at the hand-over, but agent-browser did not bind the session to it.",
    "navigate-failed":
      "agent-browser did not open the hand-over in the thread's window. The hand-over expires within a minute.",
  },
  cs: {
    "relay-absent":
      "Toto Prostředí nemá relay do Lazuria (jeho předání žádný neuvádí). Aplikace kolegů pro své agenty vypíše a otevře jen Prostředí s vlastní identitou v Lazurio Auth.",
    "relay-unreachable":
      "Relay tohoto Prostředí neodpověděl, nebo neodpovědělo Lazurio za ním.",
    "relay-unsupported":
      "Relay tohoto Prostředí zatím vstup agentů do aplikací kolegů nenabízí; přijde s aktualizací Prostředí.",
    "relay-answer-invalid":
      "Odpověď přes relay neodpovídá kontraktu Lazuria, takže se nepoužila a nic se neotevřelo.",
    refused: "Lazurio žádost odmítlo kódem, který tato verze Lazuria nezná.",
    environment_identity_unavailable:
      "Relay zatím nemá token identity tohoto Prostředí, takže se za toto Prostředí zeptat nemůže.",
    bearer_missing: "Dashboard od relaye nedostal token tohoto Prostředí.",
    token_expired:
      "Dashboard token tohoto Prostředí od relaye nepřijal: vypršel.",
    token_invalid: "Dashboard token tohoto Prostředí od relaye nepřijal.",
    scope_not_allowed_here:
      "Relay pro toto čtení poslal token jiného použití: chyba relaye tohoto Prostředí.",
    insufficient_scope:
      "Relay pro toto čtení poslal token bez jeho rozsahu: chyba relaye tohoto Prostředí.",
    environment_unknown:
      "Dashboard toto Prostředí nezná jako Prostředí s vlastní identitou v Lazurio Auth, takže pro něj nic nevypíše.",
    invalid_request:
      "Lazurio Auth odmítlo tvar žádosti: chyba Lazuria v tomto Prostředí, ne aplikace.",
    unauthorized:
      "Lazurio Auth toto Prostředí jako jednající nepřijalo: nemá tam vlastní identitu, nebo jeho token odmítlo.",
    not_found: "Adresa aplikace nepatří (už) žádnému registrovanému Prostředí.",
    agent_entry_identity_absent:
      "Registrace tohoto Prostředí v Lazurio Auth nemá identitu, takže jeho agenti v aplikacích kolegů jednat nemohou.",
    environment_state_conflict:
      "Toto Prostředí teď není přidělené žádnému člověku (volné, pozastavené nebo uvolněné), takže jeho agenti nejednají za nikoho.",
    assignment_generation_conflict:
      "Přidělení tohoto Prostředí se od jeho posledního čtení změnilo (třeba pozastavení a obnovení), proto Lazurio Auth žádost odmítlo.",
    agent_entry_off:
      "Uživatel pro toto Prostředí vypnul agenty v aplikacích kolegů.",
    agent_entry_own_environment:
      "Aplikace běží přímo v tomto Prostředí: jeho agenti ji otevírají tady přímo, bez předání.",
    agent_entry_other_organization:
      "Toto Pracovní Prostředí jedná jen ve své Organizaci a aplikace patří jiné.",
    agent_entry_not_member:
      "Uživatel (už) není aktivním členem Organizace této aplikace.",
    application_record_inconsistent:
      "Záznamy Organizace této aplikace v Lazurio Auth si odporují, takže teď nejde nic rozhodnout.",
    agent_entry_no_role:
      "Uživatel teď v této aplikaci nemá roli aplikace, nebo už není dostupná.",
    management_temporarily_unavailable: "Lazurio Auth je chvíli nedostupné.",
    "no-browser":
      "Toto Prostředí nemá prohlížeč Prostředí, takže není okno, ve kterém by se aplikace otevřela; o nic se nežádalo.",
    "no-session":
      "Chybí sezení vlákna, ve kterém by se aplikace otevřela; o nic se nežádalo.",
    "not-shared":
      "Aplikaci tohoto jména v této Organizaci uživateli žádný kolega nezpřístupnil.",
    "host-ambiguous":
      "Aplikaci tohoto jména v této Organizaci zpřístupňuje víc kolegů; o nic se nežádalo.",
    "assignment-pending":
      "Toto Prostředí zatím není nikomu přidělené, takže jeho agenti nejednají za nikoho; o nic se nežádalo.",
    "assignment-released":
      "Přidělení tohoto Prostředí bylo uvolněno, takže jeho agenti už nejednají za nikoho; o nic se nežádalo.",
    "machine-context-unreadable":
      "Předání tohoto Prostředí nejde přečíst, takže jeho přidělení není známé; o nic se nežádalo.",
    "browser-unreachable":
      "Prohlížeč Prostředí na loopbacku neodpovídá. Předání se nepoužilo a do minuty vyprší.",
    "window-create-failed":
      "Prohlížeč Prostředí neotevřel okno. Předání se nepoužilo a do minuty vyprší.",
    "bind-failed":
      "Okno s předáním se otevřelo, ale agent-browser k němu sezení nepřipojil.",
    "navigate-failed":
      "agent-browser předání v okně vlákna neotevřel. Předání do minuty vyprší.",
  },
};

/** The next step of each refusal, for the agent (Czech in the singular). */
function nextSteps(
  reason: Reason,
  locale: Locale,
  input: Readonly<{ switchPage: string; choices?: readonly string[] }>,
): string[] {
  const cs = locale === "cs";
  const again = cs
    ? "Spusť příkaz za chvíli znovu; když to vydrží, spusť lazurio doctor."
    : "Run the command again in a moment; if it stays so, run lazurio doctor.";
  const unavailable = cs
    ? "Řekni uživateli, že agenti tohoto Prostředí teď aplikace kolegů otevřít nemohou; uživatel je otevře ve svém prohlížeči v Apps. Jinou cestu dovnitř nehledej a nikdy se v aplikaci nepřihlašuj."
    : "Tell the user that agents of this Environment cannot open colleagues' applications now; the user opens them in their own browser from Apps. Do not look for another way in and never sign in to the application.";
  const report = cs
    ? "Spusť lazurio update status a lazurio doctor a nález nahlas jako issue Lazuria."
    : "Run lazurio update status and lazurio doctor, and report the finding as an issue of Lazurio.";
  const listAgain = cs
    ? "Přečti seznam znovu příkazem lazurio apps shared a použij jeho přesný příkaz."
    : "Read the list again with lazurio apps shared and use its exact command.";
  switch (reason) {
    case "relay-unreachable":
    case "environment_identity_unavailable":
    case "bearer_missing":
    case "token_expired":
    case "token_invalid":
    case "assignment_generation_conflict":
    case "management_temporarily_unavailable":
    case "browser-unreachable":
    case "window-create-failed":
    case "bind-failed":
    case "navigate-failed":
      return [again];
    case "relay-answer-invalid":
    case "refused":
    case "scope_not_allowed_here":
    case "insufficient_scope":
    case "invalid_request":
    case "machine-context-unreadable":
      return [report];
    case "relay-absent":
    case "relay-unsupported":
    case "environment_unknown":
    case "unauthorized":
    case "agent_entry_identity_absent":
    case "environment_state_conflict":
    case "assignment-pending":
    case "assignment-released":
    case "no-browser":
      return [unavailable];
    case "agent_entry_off":
      return [
        cs
          ? `Řekni uživateli, kde to zapne: v Lazuriu, v Dashboardu na stránce svého Prostředí ${input.switchPage}. Zapnout to smí jen on sám; nikdy to neobcházej.`
          : `Tell the user where to switch it on: in Lazurio, on their Environment's page in the Dashboard, ${input.switchPage}. Only the user can; never get around it.`,
      ];
    case "agent_entry_own_environment":
      return [
        cs
          ? "Otevři ji tady přímo: její modul a runtime.url najdeš v lazurio module list."
          : "Open it here directly: lazurio module list gives its module and runtime.url.",
      ];
    case "agent_entry_other_organization":
      return [
        cs
          ? "Řekni uživateli, ať ji otevře z Prostředí v té Organizaci, nebo ze svého Osobního Prostředí."
          : "Tell the user to open it from their Environment in that Organization, or from their Personal Environment.",
      ];
    case "agent_entry_not_member":
      return [
        cs
          ? "Řekni uživateli, že o členství rozhoduje Admin Organizace té aplikace."
          : "Tell the user that the Organization Admin of that application's Organization decides membership.",
      ];
    case "application_record_inconsistent":
      return [
        cs
          ? "Zkus to později; nesoulad vidí Admin Organizace."
          : "Try again later; the Organization Admin sees the inconsistency.",
      ];
    case "agent_entry_no_role":
    case "not_found":
      return [
        listAgain,
        cs
          ? "O roli rozhoduje kolega, který aplikaci zpřístupňuje, s Adminem aplikace."
          : "The colleague who shares it decides roles with the application's Admin.",
      ];
    case "not-shared":
      return [listAgain];
    case "host-ambiguous":
      return [
        ...(input.choices ?? []),
        cs
          ? "Vyber kolegu podle uživatele a spusť příkaz s jeho --host."
          : "Choose the colleague the user means and run the command with their --host.",
      ];
    case "no-session":
      return [
        cs
          ? "Spusť příkaz z vlákna T3 Code, Codexu nebo Claude Code, nebo zadej --session <jméno>."
          : "Run it from a thread of T3 Code, Codex or Claude Code, or pass --session <name>.",
      ];
  }
}

const roleNames: Readonly<
  Record<Locale, Record<AccountSharedApplication["role"], string>>
> = {
  en: { admin: "Application Admin", user: "Application User" },
  cs: { admin: "Admin aplikace", user: "Uživatel aplikace" },
};

const same = (left: string | null | undefined, right: string) =>
  typeof left === "string" && left.toLowerCase() === right.toLowerCase();

/** The command that opens `entry`, with `--host` where another entry of the
 * list has the same Organization and Module. */
function openCommand(
  entry: AccountSharedApplication,
  list: readonly AccountSharedApplication[],
): string {
  const shared = list.filter(
    (other) =>
      same(other.organization, entry.organization) &&
      same(other.module, entry.module),
  );
  const base = `lazurio apps open ${entry.module} --org ${entry.organization}`;
  return shared.length > 1 && entry.host.login !== null
    ? `${base} --host ${entry.host.login}`
    : base;
}

function hostLine(entry: AccountSharedApplication, locale: Locale): string {
  const { login, name } = entry.host;
  const who =
    name !== undefined && login !== null
      ? `${name} (${login})`
      : (name ?? login);
  return who === null
    ? ""
    : locale === "cs"
      ? `, sdílí ${who}`
      : `, shared by ${who}`;
}

function listText(
  list: readonly AccountSharedApplication[],
  agentEntry: "on" | "off",
  locale: Locale,
  switchPage: string,
): string {
  const cs = locale === "cs";
  if (agentEntry === "off")
    return cs
      ? `Agenti v aplikacích kolegů jsou pro toto Prostředí vypnutí. Zapnout je může jen uživatel, v Lazuriu na stránce svého Prostředí: ${switchPage}`
      : `Agents in colleagues' applications are switched off for this Environment. Only the user can switch them on, in Lazurio on their Environment's page: ${switchPage}`;
  if (list.length === 0)
    return cs
      ? "Uživateli teď žádný kolega aplikaci nezpřístupnil."
      : "No colleague shares an application with the user right now.";
  return [
    cs
      ? "Aplikace, které kolegové uživateli zpřístupnili:"
      : "Applications colleagues share with the user:",
    ...list.flatMap((entry) => [
      `  ${entry.name} (${entry.module}, ${entry.organization}) — ${roleNames[locale][entry.role]}${hostLine(entry, locale)}`,
      `    ${openCommand(entry, list)}`,
    ]),
  ].join("\n");
}

type Parsed =
  | Readonly<{
      action: "shared";
      json: boolean;
      folder: string | undefined;
    }>
  | Readonly<{
      action: "open";
      json: boolean;
      folder: string | undefined;
      module: string;
      organization: string;
      host: string | undefined;
      session: string | undefined;
    }>;

function parse(args: readonly string[]): Parsed | null {
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        folder: { type: "string" },
        org: { type: "string" },
        host: { type: "string" },
        session: { type: "string" },
      },
    });
    const { values, positionals } = parsed;
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (
      new Set(names).size !== names.length ||
      (values.folder !== undefined &&
        (!isAbsolute(values.folder) ||
          resolve(values.folder) !== values.folder))
    )
      return null;
    const common = { json: values.json === true, folder: values.folder };
    if (positionals[0] === "shared") {
      if (
        positionals.length !== 1 ||
        values.org !== undefined ||
        values.host !== undefined ||
        values.session !== undefined
      )
        return null;
      return { action: "shared", ...common };
    }
    if (
      positionals[0] === "open" &&
      positionals.length === 2 &&
      positionals[1] !== "" &&
      values.org !== undefined &&
      values.org !== "" &&
      values.host !== ""
    )
      return {
        action: "open",
        ...common,
        module: positionals[1] as string,
        organization: values.org,
        host: values.host,
        session: values.session,
      };
    return null;
  } catch {
    return null;
  }
}

export async function runAppsCommand(
  args: readonly string[],
  context: AppsContext,
): Promise<CommandOutput> {
  const request = parse(args);
  if (request === null)
    return Object.freeze({ code: exitUsage, stderr: `Usage: ${synopsis}` });
  const { json } = request;
  let locale: Locale = "en";
  let machine: MachineBinding | null = null;
  let ownerKey: string | null = null;
  const switchPage = () => agentEntrySwitchPage(machine, ownerKey);

  const blocked = (
    reason: Reason,
    code: number,
    extra: Readonly<{
      choices?: readonly string[];
      detail?: string | null;
    }> = {},
    kind: "blocked" | "failed" = "blocked",
  ): CommandOutput => {
    const message = meanings[locale][reason];
    const steps = nextSteps(reason, locale, {
      switchPage: switchPage(),
      ...(extra.choices === undefined ? {} : { choices: extra.choices }),
    });
    return Object.freeze({
      code,
      ...(json
        ? {
            stdout: JSON.stringify({
              schema: folderSharedApplicationsSchema,
              kind,
              reason,
              ...(extra.detail == null ? {} : { detail: extra.detail }),
              message,
              next_steps: steps,
            }),
          }
        : {
            stderr: [
              `${request.action === "shared" ? "Apps shared" : "Apps open"} ${kind === "blocked" ? "refused" : "failed"} (${reason}): ${message}${extra.detail == null ? "" : ` [${extra.detail}]`}`,
              ...steps.map((step) => `- ${step}`),
            ].join("\n"),
          }),
    });
  };

  try {
    const folder = request.folder ?? (await operatorFolder(context));
    const state =
      folder === undefined
        ? null
        : await readStartState(folder, { locked: false });
    locale = state?.preferences.profile.locale === "cs" ? "cs" : "en";
    machine = state?.preferences.machine ?? null;
    const entry = state?.entry ?? null;
    const socket = entry?.environmentRelaySocket;
    if (socket === undefined) return blocked("relay-absent", exitUnavailable);
    const relay = createAgentEntryRelay(
      (context.relayTransport ?? unixSocketTransport)(socket),
    );

    if (request.action === "shared") {
      const read = await relay.sharedApplications();
      if (read.kind === "refused")
        return blocked(read.reason, exitUsage, { detail: read.detail });
      if (read.agentEntry === "off") ownerKey = await liveOwnerKey(context);
      const steps =
        read.agentEntry === "off"
          ? nextSteps("agent_entry_off", locale, { switchPage: switchPage() })
          : [];
      return Object.freeze({
        code: exitOk,
        stdout: json
          ? JSON.stringify({
              schema: folderSharedApplicationsSchema,
              kind: "shared-applications",
              agentEntry: read.agentEntry,
              sharedApplications: read.sharedApplications,
              next_steps: steps,
            })
          : listText(
              read.sharedApplications,
              read.agentEntry,
              locale,
              switchPage(),
            ),
      });
    }

    // Nothing is asked that could not be opened: the browser, the thread's
    // session and the person the Environment acts for come first.
    const browser = browserEntryOf(entry);
    if (browser === undefined) return blocked("no-browser", exitUnavailable);
    const session = threadSession(request.session, context.env);
    if (session === null) return blocked("no-session", exitUsage);
    let generation: number | null;
    try {
      const read = await readMachineContext(
        context.machineSource ?? productionMachineContextSource,
      );
      generation = read.generation;
      const { owner } = read.context;
      ownerKey =
        owner.kind === "organization" ? (owner.organization_key ?? null) : null;
    } catch (error) {
      const code = error instanceof MachineContextError ? error.code : null;
      return blocked(
        code === "machine-assignment-pending"
          ? "assignment-pending"
          : code === "machine-assignment-released"
            ? "assignment-released"
            : "machine-context-unreadable",
        exitUsage,
        { detail: code },
      );
    }

    const read = await relay.sharedApplications();
    if (read.kind === "refused")
      return blocked(read.reason, exitUsage, { detail: read.detail });
    if (read.agentEntry === "off") return blocked("agent_entry_off", exitUsage);
    const named = read.sharedApplications.filter(
      (candidate) =>
        same(candidate.organization, request.organization) &&
        same(candidate.module, request.module),
    );
    const chosen =
      request.host === undefined
        ? named
        : named.filter((candidate) =>
            same(candidate.host.login, request.host as string),
          );
    if (chosen.length === 0) return blocked("not-shared", exitUsage);
    if (chosen.length > 1)
      return blocked("host-ambiguous", exitUsage, {
        choices: chosen.flatMap((candidate) =>
          candidate.host.login === null
            ? []
            : [
                `lazurio apps open ${candidate.module} --org ${candidate.organization} --host ${candidate.host.login}`,
              ],
        ),
      });
    const application = chosen[0] as AccountSharedApplication;

    // The list's address is only the input of the hand-over: what is opened
    // is Auth's answer, exactly.
    const handOver = await relay.handOver(application.url, generation);
    if (handOver.kind === "refused")
      return blocked(handOver.reason, exitUsage, { detail: handOver.detail });
    let window: Awaited<ReturnType<typeof openInThreadWindow>>;
    try {
      window = await openInThreadWindow(
        session,
        handOver.url,
        context.windowSeams ?? cdpSeams(context.env, context.run ?? runProcess),
      );
    } catch (error) {
      if (error instanceof BrowserWindowFailure)
        return blocked(error.reason, exitFailure, {}, "failed");
      throw error;
    }
    const link = browserViewUrl(browser.origin, window.targetId);
    const command = browserCommand(session);
    const role = roleNames[locale][application.role];
    return Object.freeze({
      code: exitOk,
      stdout: json
        ? JSON.stringify({
            schema: folderSharedApplicationsSchema,
            kind: "shared-application-opened",
            organization: application.organization,
            module: application.module,
            name: application.name,
            url: application.url,
            role: application.role,
            session,
            targetId: window.targetId,
            link,
            command,
          })
        : (locale === "cs"
            ? [
                `Otevřeno ve tvém okně: ${application.name} (${application.organization}), jako uživatel s rolí ${role}.`,
                `Tady s tebou uživatel pracuje ve stejné záložce: ${link}`,
                `Ve svém okně pracuj příkazem: ${command} <command>`,
                "Kde stránka nabízí nástroje WebMCP, používej je. Publikaci nikdy nedokončíš bez výslovného pokynu uživatele.",
              ]
            : [
                `Opened in your window: ${application.name} (${application.organization}), as the user with the role ${role}.`,
                `The user works with you in this tab: ${link}`,
                `Work in your window with: ${command} <command>`,
                "Use the page's WebMCP tools where it offers them. Never complete a Publication without the user's explicit word.",
              ]
          ).join("\n"),
    });
  } catch (error) {
    return Object.freeze({
      code: exitFailure,
      stderr:
        error instanceof LaunchpadStartRefused
          ? `lazurio apps failed: the Folder could not be read (${error.reason})`
          : "lazurio apps failed",
    });
  }
}

/** The owning Organization's own slug from the live handover, for the
 * Dashboard page of the switch; none where it cannot be read. */
async function liveOwnerKey(context: AppsContext): Promise<string | null> {
  try {
    const { owner } = (
      await readMachineContext(
        context.machineSource ?? productionMachineContextSource,
      )
    ).context;
    return owner.kind === "organization"
      ? (owner.organization_key ?? null)
      : null;
  } catch {
    return null;
  }
}
