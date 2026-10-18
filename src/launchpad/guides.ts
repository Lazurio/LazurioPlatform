import type { ShellEnvironmentKind } from "../shell/contract";
import type { VaultEnvironmentKind } from "../vault/context";
import type { VaultStatus } from "../vault/flow";
import type { GuideVideoName } from "./guide-video";
import { integrationsHelp } from "./integrations-view";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";
import type { VaultPagePerson } from "./vault-page-view";

type Copy = Readonly<Record<MessageKey, string>>;

// The Launchpad's part in the shell's guide (decision F56 and its addendum
// of 2026-10-18): which explanation the "?" right after a page's heading
// plays, and the explanations of the page shown that the Launchpad hands
// over (`provideGuides`), since they point at its own elements by their
// `data-guide` marks. Every page of the Apps column and of Settings has its
// "?" (plan DEV-6612, PRs 4 and 5), and the page keeps no sentence that only
// explained it: Apps plays the shell's principle "environment", Soubory
// "files", Integrace "integrations" with its documentation in the card,
// where Composio is allowed the Launchpad's "integrations-composio" and on
// Vlastní its "integrations-custom"; Trezor plays what is true of this
// Environment's vault (`vaultHelp`). A variant is chosen only from facts the
// page knows: the Environment's kind from the shell's document, the vault
// core's answer and the person's place in the vault as Apps → Trezor reads
// them, and whether Composio is allowed as Integrace read it; never from an
// Organization's name or slug (Lazurio/LazurioPlatform#499). Pure: ui.ts
// hands the result to the shell.

/** One step as `provideGuides` takes it. */
export type PageGuideStep = Readonly<{
  text: string;
  sub?: string;
  at: string;
}>;

/** An explanation as `provideGuides` takes it. */
export type PageGuideInput = Readonly<{
  id: string;
  title: string;
  steps: readonly PageGuideStep[];
  /** The documentation behind it, a link in the card at its last step. */
  docs?: string;
}>;

export type PageGuide = Readonly<{
  /** The id of the explanation the page's "?" plays in the guide; null
   * where it plays none. */
  help: string | null;
  /** The guide video the page's "?" opens in place instead (Trezor's
   * approved video, where its words are true); null where it opens none.
   * Never both: with neither the page has no "?" (yet). */
  video: GuideVideoName | null;
  /** The explanations of this page the Launchpad hands over. */
  guides: readonly PageGuideInput[];
}>;

/** What Trezor's "?" plays (#499): the shell's principle `vault`, which a
 * Personal Environment hears as its own Bitwarden with the agents' own
 * account in it; the Launchpad's `vault-agents`, where nobody who enters is
 * added to the vault and so nobody shares into it from their own Bitwarden
 * (a Team or Automated Environment, a network whose vault takes no Lazurio
 * sign-in yet), and while that is not known; or the approved video of how a
 * vault works in an Organization (`video`), where the person is added to
 * the vault and can share into it, or where this Environment has no vault
 * (and where the core answers a fault: the video is true there too). Null
 * until the page read the vault's state: the "?" waits. */
export type VaultHelp = "vault" | "vault-agents" | "video" | null;

/** The facts Trezor's variant is chosen from, as Apps → Trezor reads them:
 * the vault core's answer (`GET /api/vault`, `vaultAnswer` through the
 * status) and where the person stands in the vault (`POST
 * /api/vault/membership`); each null until read. */
export type VaultGuideFacts = Readonly<{
  vault: Readonly<{
    status: VaultStatus;
    environment: VaultEnvironmentKind | null;
  }> | null;
  person: VaultPagePerson | null;
}>;

/** What Trezor's "?" plays in an Environment of `kind` (#499). */
export function vaultHelp(
  kind: ShellEnvironmentKind | null,
  facts: VaultGuideFacts,
): VaultHelp {
  // A Personal Environment: the person's own Bitwarden, the agents' own
  // account in it (the shell plays the principle's adaptation by the kind).
  if (kind === "personal") return "vault";
  const read = facts.vault;
  if (read === null) return null;
  const { status, environment } = read;
  if (
    environment === "personal" ||
    status.state === "needs-connection" ||
    (status.state === "unsupported" &&
      status.reason === "connection-unreadable") ||
    ("region" in status && status.region !== undefined)
  )
    return "vault";
  // No vault here (none yet, none by design, this computer): how a vault
  // works in an Organization.
  if (status.state === "unsupported") return "video";
  // The vault adds the people who enter: they share into it from their own
  // Bitwarden.
  if (facts.person?.kind === "known") return "video";
  // Nobody is added (a Team or Automated Environment, a vault that takes no
  // Lazurio sign-in yet), or that is not known yet: only what is true
  // without it.
  return "vault-agents";
}

/** The Files page of a Team Environment: the folder is the Team's. */
export const filesTeamGuide = (copy: Copy): PageGuideInput => ({
  id: "files-team",
  title: copy.filesTitle,
  steps: [
    { text: copy.guideFilesTeamDrag, at: "tab-chat" },
    { text: copy.guideFilesTeamShow, at: "files-list" },
    { text: copy.guideFilesTeamShared, at: "files-list" },
  ],
});

/** Integrace where Composio is allowed (root decision 0162's addenda of
 * 2026-10-13 and 2026-10-17, the prototype's `integrations-composio`): the
 * person's own account, one Composio organization per Organization with
 * nobody else in it, what the agents use, another account for other
 * accounts. */
export const integrationsComposioGuide = (
  copy: Copy,
  locale: "cs" | "en",
): PageGuideInput => ({
  id: "integrations-composio",
  title: copy.guideComposioTitle,
  steps: [
    {
      text: copy.guideComposioAccount,
      sub: copy.guideComposioAccountSub,
      at: "integration-connect",
    },
    {
      text: copy.guideComposioOrganization,
      sub: copy.guideComposioOrganizationSub,
      at: "composio-apps",
    },
    {
      text: copy.guideComposioAgents,
      sub: copy.guideComposioAgentsSub,
      at: "integration-on",
    },
    {
      text: copy.guideComposioOther,
      sub: copy.guideComposioOtherSub,
      at: "composio-apps",
    },
  ],
  docs: integrationsHelp(locale),
});

/** Integrace → Vlastní (the prototype's `integrations-custom`). */
export const integrationsCustomGuide = (
  copy: Copy,
  locale: "cs" | "en",
): PageGuideInput => ({
  id: "integrations-custom",
  title: copy.guideCustomTitle,
  steps: [
    { text: copy.guideCustomWho, at: "mcp-list" },
    { text: copy.guideCustomHow, at: "mcp-add" },
    { text: copy.guideCustomUse, at: "mcp-list" },
  ],
  docs: integrationsHelp(locale),
});

/** Trezor where nobody who enters is added to the vault (#499): what the
 * vault is, what the agents do with it, and that everyone in this
 * Environment has its passwords; never "your Bitwarden", and nobody is
 * asked to store a password of their own there. */
export const vaultAgentsGuide = (copy: Copy): PageGuideInput => ({
  id: "vault-agents",
  title: copy.vaultPageTitle,
  steps: [
    { text: copy.guideVaultAgentsOwn, at: "vault-row" },
    { text: copy.guideVaultAgentsUse, at: "vault-row" },
    { text: copy.guideVaultAgentsSee, at: "vault-row" },
  ],
});

/** Settings → Začínáme where it has the basics (`firstRun`'s person
 * presets, not a public Environment): the steps that prepare the
 * Environment, the AI first, GitHub, the optional ones. */
export const startGuide = (copy: Copy): PageGuideInput => ({
  id: "settings-start",
  title: copy.startTitle,
  steps: [
    { text: copy.guideStartSteps, at: "start-steps" },
    { text: copy.guideStartAi, at: "start-ai" },
    { text: copy.guideStartGithub, at: "start-github" },
    { text: copy.guideStartOptional, at: "start-optional" },
  ],
});

/** Settings → Obecné: the language, how agents explain and coordinate,
 * and the preview before a change. */
export const generalGuide = (copy: Copy): PageGuideInput => ({
  id: "settings-general",
  title: copy.settingsGeneral,
  steps: [
    { text: copy.guideGeneralLanguage, at: "general-language" },
    { text: copy.guideGeneralDetail, at: "general-detail" },
    {
      text: copy.guideGeneralCoordination,
      sub: copy.guideGeneralCoordinationSub,
      at: "general-coordination",
    },
    { text: copy.guideGeneralApply, at: "general-apply" },
  ],
});

/** Settings → Komunikace agentů; in a Team Environment its one voice for
 * everyone. */
export const voiceGuide = (copy: Copy, team: boolean): PageGuideInput => ({
  id: team ? "settings-communication-team" : "settings-communication",
  title: copy.voiceTitle,
  steps: [
    {
      text: copy.guideVoiceHow,
      ...(team ? { sub: copy.guideVoiceTeam } : {}),
      at: "voice-text",
    },
    { text: copy.guideVoiceWhere, at: "voice-text" },
    { text: copy.guideVoiceNew, at: "voice-save" },
  ],
});

/** Settings → Toto <kind> Prostředí: what it is, whose it is, the details
 * for support; on your computer its own words, never the agents' virtual
 * computer. */
export const machineGuide = (
  copy: Copy,
  computer: boolean,
): PageGuideInput => ({
  id: "settings-machine",
  title: copy.machineTitle,
  steps: [
    {
      text: computer ? copy.guideMachineComputer : copy.guideMachineWhat,
      at: "machine-facts",
    },
    {
      text: computer ? copy.guideMachineWhoComputer : copy.guideMachineWho,
      at: "machine-facts",
    },
    { text: copy.guideMachineSupport, at: "machine-support" },
  ],
});

/** Settings → Nástroje; in a Team Environment its team accounts, which the
 * whole Team uses. */
export const toolsGuide = (copy: Copy, team: boolean): PageGuideInput => ({
  id: team ? "settings-tools-team" : "settings-tools",
  title: copy.toolsTitle,
  steps: team
    ? [
        { text: copy.guideToolsTeamShared, at: "tools" },
        { text: copy.guideToolsTeamAccounts, at: "tool-connect" },
        { text: copy.guideToolsTeamUse, at: "tool-connect" },
        { text: copy.guideToolsSwitch, at: "tool-agents" },
      ]
    : [
        { text: copy.guideToolsWhich, at: "tools" },
        { text: copy.guideToolsConnect, at: "tool-connect" },
        { text: copy.guideToolsReach, at: "tool-connect" },
        { text: copy.guideToolsSwitch, at: "tool-agents" },
      ],
});

/** Settings → the devices that connect from a terminal: the prompt for the
 * person's own agent, a key per device, removed here; in a Team
 * Environment the whole Team's devices. Its words never name the protocol
 * or the network (the rules of a text). */
export const devicesGuide = (copy: Copy, team: boolean): PageGuideInput => ({
  id: team ? "settings-ssh-team" : "settings-ssh",
  title: copy.sshDevicesTitle,
  steps: [
    { text: copy.guideDevicesPrompt, at: "ssh-prompt" },
    { text: copy.guideDevicesSignIn, at: "ssh-prompt" },
    { text: copy.guideDevicesKey, at: "ssh-devices" },
    {
      text: team ? copy.guideDevicesTeam : copy.guideDevicesRemove,
      at: "ssh-devices",
    },
  ],
});

/** Settings → Obnova: Lazurio checks itself, what fails shows, an agent
 * repairs it. */
export const recoveryGuide = (copy: Copy): PageGuideInput => ({
  id: "settings-recovery",
  title: copy.recoveryTitle,
  steps: [
    { text: copy.guideRecoveryChecks, at: "recovery-result" },
    { text: copy.guideRecoveryFails, at: "recovery-checks" },
    {
      text: copy.guideRecoveryRepair,
      sub: copy.guideRecoveryRepairSub,
      at: "recovery-checks",
    },
  ],
});

/** The "?" of a route's page, by its id in index.html: right after the
 * heading in the header (Settings, Soubory, Trezor), in the Apps home's
 * head (catalog-panel.ts keeps it beside the heading it draws) and in
 * Integrace's head; none on a module's overview and the Marketplace, which
 * have no explaining sentence to take over. */
export type PageHelpId =
  | "page-help"
  | "catalog-help"
  | "integrations-page-help";

export function pageHelpOf(route: PageRoute): PageHelpId | null {
  switch (route.view) {
    case "home":
    case "organization":
      return "catalog-help";
    case "integrations":
      return "integrations-page-help";
    case "settings":
    case "files":
    case "vault":
      return "page-help";
    default:
      return null;
  }
}

/** The marks a step may name that a panel draws once its data is read, not
 * the page as served: Integrace's first connected app and first Connect
 * (integrations-panel.ts), and Vlastní's list and its way to add one;
 * Začínáme's AI and GitHub steps (start-panel.ts); the first sign-in and
 * the first "Používají agenti" of Nástroje (tools-panel.ts); Obnova's result and its
 * checks (recovery-panel.ts). A mark that is not there points at nothing:
 * the card stands in the middle. */
export const drawnMarks = Object.freeze([
  "integration-on",
  "integration-connect",
  "mcp-list",
  "mcp-add",
  "start-ai",
  "start-github",
  "tool-connect",
  "tool-agents",
  "recovery-result",
  "recovery-checks",
] as const);

/** What the page knows that a variant may be chosen by. */
export type PageGuideFacts = Readonly<{
  /** The current Environment's kind in the shell's document; null while it
   * is not known. An automated Environment is a work one. */
  kind: ShellEnvironmentKind | null;
  locale: "cs" | "en";
  /** Whether Composio is allowed here, as Integrace last read it; null
   * until read. */
  composio: boolean | null;
  vault: VaultGuideFacts;
  /** What Settings → Začínáme shows here: the basics (`basics`, where the
   * Environment signs in as its person), the public demo (`demo`, F55), or
   * nothing to set up (`none`, a Team or Automated Environment); null until
   * the profile is read. Only the basics have something to explain. */
  start: "basics" | "demo" | "none" | null;
}>;

const none: PageGuide = Object.freeze({ help: null, video: null, guides: [] });
const plays = (
  help: string,
  guides: readonly PageGuideInput[] = [],
): PageGuide => ({ help, video: null, guides });

/** The guide of a route, from what the page knows. */
export function pageGuide(
  route: PageRoute,
  facts: PageGuideFacts,
  copy: Copy,
): PageGuide {
  switch (route.view) {
    case "home":
    case "organization":
      return plays("environment");
    case "files":
      return facts.kind === "team"
        ? plays("files-team", [filesTeamGuide(copy)])
        : plays("files");
    case "integrations": {
      const custom = integrationsCustomGuide(copy, facts.locale);
      if (route.tab === "custom" || route.form !== undefined)
        return plays(custom.id, [custom]);
      if (facts.composio === true) {
        const composio = integrationsComposioGuide(copy, facts.locale);
        return plays(composio.id, [composio, custom]);
      }
      return plays("integrations", [custom]);
    }
    case "vault": {
      // One agent's request is a page of its own, without a "?".
      if (route.request !== undefined) return none;
      const help = vaultHelp(facts.kind, facts.vault);
      if (help === "video")
        return { help: null, video: "vault-overview", guides: [] };
      if (help === "vault-agents") return plays(help, [vaultAgentsGuide(copy)]);
      return help === null ? none : plays(help);
    }
    case "settings": {
      const team = facts.kind === "team";
      switch (route.section) {
        case "start":
          return facts.start === "basics"
            ? plays("settings-start", [startGuide(copy)])
            : none;
        case "general":
          return plays("settings-general", [generalGuide(copy)]);
        case "communication": {
          const guide = voiceGuide(copy, team);
          return plays(guide.id, [guide]);
        }
        case "machine":
          return plays("settings-machine", [
            machineGuide(copy, facts.kind === "workstation"),
          ]);
        case "tools": {
          const guide = toolsGuide(copy, team);
          return plays(guide.id, [guide]);
        }
        case "ssh": {
          const guide = devicesGuide(copy, team);
          return plays(guide.id, [guide]);
        }
        case "recovery":
          return plays("settings-recovery", [recoveryGuide(copy)]);
      }
      return none;
    }
    default:
      return none;
  }
}
