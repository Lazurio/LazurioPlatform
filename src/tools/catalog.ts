import { executorPin } from "../executor/pin";
import type { PresetName } from "../folder/presets";
import { bitwardenPin } from "../vault/pin";
import { toolNoteProblem } from "./note";

// The operator's tools that `lazurio tools` reports and, on instruction, updates
// (decision 0161 / F17, docs/environment-tools.md). A thin orchestration of each
// tool's OFFICIAL update path: the tool's own updater where it has one, the
// vendor's installer script where that is the documented path, and only a
// report with the official source where neither exists. Nothing here pins,
// downgrades or chooses a package manager.
export type ToolUpdater =
  | Readonly<{ kind: "self"; argv: readonly string[] }>
  | Readonly<{ kind: "installer"; posix: string; windows: string }>
  | Readonly<{ kind: "none" }>;

// What makes a catalog tool part of an Environment's agent instructions
// (root decision 0162, F18). `required` tools are always on; `recommended` and
// `optional` ones are on when the operator enabled them in the Lazurio Folder.
// Both texts are rendered into the generated files: `purpose` is one sentence
// on what the tool is for, `usage` tells an agent when and how to use it and
// names the command that reports its sign-in. Enabling is context: it grants
// no access, installs nothing and pins no version.
export type ToolTier = "required" | "recommended" | "optional";
export type ToolText = Readonly<{ cs: string; en: string }>;
// Who sets a tool up (decision F18). `launchpad`: installation and login
// have a curated flow in the CLI and the Launchpad (decision F19,
// src/tools/install.ts and login.ts). `agent`: the Launchpad only shows
// status and hands the prepared prompt to an agent, who installs the tool
// and guides the sign-in. `installation` describes the TARGET STATE an
// installation must reach; it is the body of that prompt, and for a
// `launchpad` tool what a fallback agent follows when the curated installer
// fails. Nothing in this catalog installs anything.
export type ToolSetup = "launchpad" | "agent";
// How the Launchpad and `lazurio tools list --sign-in` ask a tool whether it
// is signed in, and as whom (decision F18, addendum 2026-09-27). The probe is
// the command the usage text names; it runs only on request, because a tool
// may contact its provider to verify the sign-in. Signed in means: the
// command exits 0, `signedOut` does not match its output, and the `account`
// rules below hold. Only the extracted label ever leaves the probe.
export type SignInAccount =
  | Readonly<{
      kind: "json";
      /** Candidate paths of the account label in the JSON object the tool
       * prints (the whole output or one line of it); the first non-empty
       * string wins. A numeric segment indexes an array. */
      paths: readonly (readonly string[])[];
      /** Where the organization label is, when the tool names one. */
      organization?: readonly string[];
      /** Signed in only when a label was found. */
      requireAccount?: boolean;
      /** Signed in only when this path holds `true`. */
      flag?: readonly string[];
      /** Candidate paths of the list of signed-in accounts (`[]` is the
       * whole document). An empty list is signed out; the label paths are
       * then read from its first entry. When no candidate is a list the
       * shape is unknown: signed in by the exit code, without a label. */
      list?: readonly (readonly string[])[];
    }>
  | Readonly<{
      kind: "regex";
      /** Capture group 1 is the account label; searched in stdout and
       * stderr. No match leaves a signed-in probe without a label. */
      pattern: string;
    }>;
export type SignInProbe = Readonly<{
  argv: readonly string[];
  account?: SignInAccount;
  /** Output that means signed out whatever the exit code. */
  signedOut?: string;
}>;
export type ToolActivation = Readonly<{
  tier: ToolTier;
  setup: ToolSetup;
  purpose: ToolText;
  usage: ToolText;
  installation: ToolText;
  /** The target state on a Team Environment (`hosted-organization-team`),
   * where it replaces `installation` and the prompt guides no sign-in. */
  team?: ToolText;
  signInProbe?: SignInProbe;
  /** The prompt's task and its first step, for a tool whose setup is not
   * an installation and a person's sign-in (the Environment vault, decision
   * F43): it replaces the two generic paragraphs. */
  task?: ToolText;
  /** Where Lazurio offers the tool (`toolOffered`): `hosted-linux` only in a
   * Remote Environment on Linux (the Environment vault, decision F43, and
   * Executor, F44; this computer is their second wave); `personal` only in
   * a person's own Environment, their computer or personal Remote
   * Environment, never a work one of an Organization (gogcli, root decision
   * 0162 addendum 2026-10-09 point 5). Absent: everywhere. Where a tool is
   * not offered it is not rendered into the Folder, cannot be enabled, and
   * doctor does not count it as missing; a stored selection naming it stays
   * readable and can turn it off. */
  offered?: ToolOffer;
}>;

export type ToolOffer = "hosted-linux" | "personal";

export type ToolEntry = Readonly<{
  name: string;
  command: string;
  versionArgs: readonly string[];
  source: string;
  updater: ToolUpdater;
  activation?: ToolActivation;
  /** The variable that names the tool's data directory, when the tool
   * writes its store on every start, even for `--version` (bw): the version
   * command then runs with a private temporary directory there, so no probe
   * ever touches a profile (decision F43). */
  isolatedData?: string;
}>;
export type ActivatableTool = ToolEntry &
  Readonly<{ activation: ToolActivation }>;

const tool = (entry: ToolEntry): ToolEntry => Object.freeze(entry);

// What no installation may do, whoever performs it.
const never: ToolText = {
  cs: "Nikdy: tajemství (token, heslo, klíč, kód) v chatu, Gitu ani logu; druhá instalace téhož nástroje; downgrade nebo přeinstalace nástroje, který funguje.",
  en: "Never: a secret (token, password, key, code) in chat, Git or a log; a second installation of the same tool; a downgrade or reinstall of a tool that works.",
};
const installation = (cs: string, en: string): ToolText => ({
  cs: `${cs} ${never.cs}`,
  en: `${en} ${never.en}`,
});
// The usage of a tool that writes outside: the externally visible write is a
// Publication. The agent prepares the Draft and leaves it unfinished; the
// Operator's explicit "Publish" for that Draft is the full mandate to finish
// it (decision F14, addendum 2026-10-05).
const writingUsage = (cs: string, en: string, write: ToolText): ToolText => ({
  cs: `${cs} ${write.cs} je Publikace: připrav Draft a nedokončuj ho; výslovné „Publikuj“ Operátora k tomu Draftu je plný mandát k jeho dokončení (\`manual/working-here.md\`).`,
  en: `${en} ${write.en} is a Publication: prepare the Draft and leave it unfinished; the Operator's explicit “Publish” for that Draft is the full mandate to finish it (\`manual/working-here.md\`).`,
});

export const toolCatalog: readonly ToolEntry[] = Object.freeze([
  tool({
    name: "codex",
    command: "codex",
    versionArgs: ["--version"],
    source: "https://developers.openai.com/codex/cli",
    // The official standalone installer installs and updates Codex
    // (manual/organization-install.md "Codex CLI: instalace a aktualizace").
    updater: {
      kind: "installer",
      // Two steps, so a failed download can never run half a script or pass
      // as an update: fetch to a private file, then run it.
      posix:
        'set -eu; f="$(mktemp)"; trap \'rm -f "$f"\' EXIT; curl -fsSL https://chatgpt.com/codex/install.sh -o "$f"; sh "$f"',
      windows:
        "$ErrorActionPreference = 'Stop'; $s = irm https://chatgpt.com/codex/install.ps1; iex $s",
    },
  }),
  tool({
    name: "claude",
    command: "claude",
    versionArgs: ["--version"],
    source: "https://docs.claude.com/en/docs/claude-code/setup",
    updater: { kind: "self", argv: ["update"] },
  }),
  tool({
    name: "gh",
    command: "gh",
    versionArgs: ["--version"],
    source: "https://github.com/cli/cli#installation",
    updater: { kind: "none" },
    activation: {
      tier: "required",
      setup: "launchpad",
      // The text form, for a gh older than 2.81.0: every gh probe asks
      // `gh auth status --json hosts` first (gh-status.ts).
      signInProbe: {
        argv: ["auth", "status", "--hostname", "github.com"],
        account: {
          kind: "regex",
          pattern:
            "Logged in to github\\.com (?:account|as) ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\\[bot\\])?)",
        },
      },
      installation: installation(
        'Cílový stav: `gh` je první spustitelný soubor toho jména na PATH Operátora, ve standardní cestě `~/.local/bin/gh`, z oficiálního zdroje https://github.com/cli/cli#installation. Fungující `gh` jinde na PATH zůstává a jen se nahlásí. Operátor se přihlásí příkazem `gh auth login --hostname github.com --git-protocol ssh --web --scopes admin:public_key`: v prohlížeči otevře stránku zařízení a zadá jednorázový kód. Environment pak má SSH klíč propojený s týmž účtem: použije se stávající výchozí klíč (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, v tomto pořadí) beze změny, jinak se příkazem `ssh-keygen` vytvoří nový klíč `ed25519` bez hesla (`~/.ssh` 0700, soukromý klíč 0600); zaregistruje ho `gh ssh-key add <klíč>.pub --title "Lazurio: <hostname>" --type authentication` (chybí-li tokenu scope, `gh auth refresh --hostname github.com --scopes admin:public_key`); do `~/.ssh/known_hosts` přibudou jen chybějící klíče github.com zveřejněné v `gh api meta` (`ssh_keys`) a záznam github.com, který se od nich liší, se operátorovi nahlásí a nikdy nenahradí. Klíč, který GitHub odmítne jako použitý jiným účtem, se nahlásí; druhý klíč se přes něj nevytváří. Důkaz: `gh --version` odpoví, `gh auth status` skončí kódem 0 a jmenuje zamýšlený účet a `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes git@github.com` pozdraví tentýž účet. V týmovém Environmentu (hosted-organization-team) gh nepřihlašuj a klíč nepropojuj: Environment pracuje v GitHubu přes Lazurio for GitHub, které nastavuje Organizace.',
        'Target state: `gh` is the first executable of that name on the Operator\'s PATH, in the standard path `~/.local/bin/gh`, from the official source https://github.com/cli/cli#installation. A working `gh` elsewhere on PATH stays and is only reported. The operator signs in with `gh auth login --hostname github.com --git-protocol ssh --web --scopes admin:public_key`: they open the device page in their browser and enter the one-time code. The Environment then has an SSH key linked to the same account: the existing default key (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, in that order) is used unchanged, otherwise a new `ed25519` key without a passphrase is created with `ssh-keygen` (`~/.ssh` 0700, private key 0600); `gh ssh-key add <key>.pub --title "Lazurio: <hostname>" --type authentication` registers it (when the token lacks the scope, `gh auth refresh --hostname github.com --scopes admin:public_key` first); `~/.ssh/known_hosts` gains only the missing github.com keys published by `gh api meta` (`ssh_keys`), and a github.com entry that differs from them is reported to the operator, never replaced. A key GitHub refuses as in use by another account is reported; no second key is created over it. Proof: `gh --version` answers, `gh auth status` exits 0 and names the intended account, and `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes git@github.com` greets that account. On a Team Environment (hosted-organization-team) do not sign in gh or link a key: the Environment works in GitHub through Lazurio for GitHub, set up by the Organization.',
      ),
      // A Team Environment works in GitHub through Lazurio for GitHub, set up
      // by the Organization (Matěj 2026-09-28): there the prompt carries
      // this target state instead of the sign-in and the SSH key.
      team: installation(
        "Cílový stav v tomhle týmovém Environmentu (hosted-organization-team): na PATH Operátora je funkční `gh`. Obvykle ho dodává hosting jako brokerovaný `gh` Organizace; funkční `gh` kdekoli na PATH zůstává, jak je, a jen se nahlásí. Jen když žádný nefunguje, nainstaluje se `gh` do standardní cesty `~/.local/bin/gh` z oficiálního zdroje https://github.com/cli/cli#installation. gh nepřihlašuj a klíč nepropojuj: Environment pracuje v GitHubu přes Lazurio for GitHub, které nastavuje Organizace. Důkaz: `gh --version` odpoví.",
        "Target state on this Team Environment (hosted-organization-team): a working `gh` is on the Operator's PATH. The hosting normally delivers it as the Organization's brokered `gh`; a working `gh` anywhere on PATH stays as it is and is only reported. Only when none works is `gh` installed in the standard path `~/.local/bin/gh` from the official source https://github.com/cli/cli#installation. Do not sign in gh or link a key: the Environment works in GitHub through Lazurio for GitHub, set up by the Organization. Proof: `gh --version` answers.",
      ),
      purpose: {
        cs: "GitHub CLI pro práci s repozitáři, pull requesty, issues a review.",
        en: "GitHub CLI for work with repositories, pull requests, issues and reviews.",
      },
      usage: {
        cs: "Používej `gh` pro veškerou práci s GitHubem. Před připojenou operací ověř přihlášenou identitu příkazem `gh auth status`; přihlášení není důkaz práva k přesné operaci.",
        en: "Use `gh` for all GitHub work. Verify the signed-in identity with `gh auth status` before a connected operation; a sign-in is not proof of the right to an exact operation.",
      },
    },
  }),
  // Executor 1 of every Remote Environment (decision F44, root decision 0162
  // addendum 2026-10-09): the MCP gateway of the direct Integrations and of
  // custom MCP servers, installed, run and connected to the agents by
  // Lazurio itself (`lazurio executor setup`, the Launchpad after it starts,
  // Settings → Tools → executor), pinned per Platform release.
  // Even its version command writes a cache in its data directory, so the
  // probe gets a private one.
  tool({
    name: "executor",
    command: "executor",
    versionArgs: ["--version"],
    source: "https://github.com/UsefulSoftwareCo/executor",
    updater: { kind: "none" },
    isolatedData: "EXECUTOR_DATA_DIR",
    activation: {
      tier: "required",
      setup: "launchpad",
      offered: "hosted-linux",
      task: {
        cs: "Úkol: zprovozni Executor tohoto Environmentu, nástroj `executor`: verzi, kterou připíná Lazurio, jeho službu jen na localhostu a MCP server `executor` v Codexu a Claude Code. Nejdřív zjisti skutečný stav příkazem `lazurio executor status --json`; co už funguje, neměň.",
        en: "Task: get this Environment's Executor working, the tool `executor`: the version Lazurio pins, its service on localhost only and the MCP server `executor` in Codex and Claude Code. First read the actual state with `lazurio executor status --json`; change nothing that already works.",
      },
      installation: installation(
        `Cílový stav: Executor ve verzi, kterou připíná Lazurio (${executorPin.version}, balíčky \`executor\` a \`executor-linux-<arch>\` z registru npm ověřené proti otiskům v Lazuriu), v \`~/.local/share/executor-cli/<verze>\`; spouští ho wrapper Lazuria \`~/.local/bin/executor\`, který vždy vypíná analytiku i kontrolu nové verze; jeho služba \`sh.executor.daemon.service\` běží pod uživatelem Environmentu jen na \`127.0.0.1:4789\` s doplňkem Lazuria \`lazurio.conf\`; Codex a Claude Code mají MCP server \`executor\` (\`~/.local/bin/executor mcp\`). Udělá to příkaz \`lazurio executor setup --json\` a ohlásí, co chybí. Jinou verzi Executoru neinstaluj, \`~/.local/bin/executor\` ani MCP server \`executor\`, které nejsou Lazuria, nepřepisuj a přístupový token z \`~/.executor\` nikam nekopíruj. Důkaz: \`lazurio executor status --json\` hlásí \`running\`.`,
        `Target state: Executor at the version Lazurio pins (${executorPin.version}, the packages \`executor\` and \`executor-linux-<arch>\` of the npm registry, verified against the digests in Lazurio), in \`~/.local/share/executor-cli/<version>\`; Lazurio's wrapper \`~/.local/bin/executor\` runs it with analytics and the check for a newer version always off; its service \`sh.executor.daemon.service\` runs as the Environment's user on \`127.0.0.1:4789\` only, with Lazurio's drop-in \`lazurio.conf\`; Codex and Claude Code have the MCP server \`executor\` (\`~/.local/bin/executor mcp\`). The command \`lazurio executor setup --json\` does it and reports what is missing. Install no other version of Executor, never overwrite a \`~/.local/bin/executor\` or an MCP server \`executor\` that is not Lazurio's, and copy the access token in \`~/.executor\` nowhere. Proof: \`lazurio executor status --json\` reports \`running\`.`,
      ),
      purpose: {
        cs: "MCP brána tohoto Environmentu pro přímo připojené Integrace a vlastní MCP servery; běží jako služba jen na localhostu a stará se o ni Lazurio.",
        en: "This Environment's MCP gateway for directly connected Integrations and custom MCP servers; it runs as a service on localhost only and Lazurio looks after it.",
      },
      usage: writingUsage(
        "Integrace připojené přímo používej přes MCP server `executor` (jeho nástroje `skills` a `execute`) nebo příkazem `executor call tools <integrace> <vlastník> <připojení> <nástroj> '<json>'`; co je k dispozici, ukáže `executor tools integrations` a `executor tools search \"<úkol>\"`. Stav služby a napojení agentů ověříš příkazem `lazurio executor status`; když hlásí, že Executor neběží nebo není hotový, řekni to Operátorovi: na jeho pokyn ho opraví `lazurio executor setup` (totéž nabízí Nastavení → Nástroje → executor).",
        "Use the Integrations connected directly through the MCP server `executor` (its tools `skills` and `execute`) or with `executor call tools <integration> <owner> <connection> <tool> '<json>'`; `executor tools integrations` and `executor tools search \"<task>\"` show what is there. Check the service and the agents' connection with `lazurio executor status`; when it reports that Executor is not running or not finished, tell the Operator: on their instruction `lazurio executor setup` repairs it (Settings → Tools → executor offers the same).",
        {
          cs: "Zápis viditelný navenek přes Integraci (odeslání, zveřejnění, smazání)",
          en: "An externally visible write through an Integration (sending, publishing, deleting)",
        },
      ),
    },
  }),
  tool({
    name: "git",
    command: "git",
    versionArgs: ["--version"],
    source: "https://git-scm.com/downloads",
    updater: { kind: "none" },
  }),
  tool({
    name: "node",
    command: "node",
    versionArgs: ["--version"],
    source: "https://nodejs.org/en/download",
    updater: { kind: "none" },
  }),
  tool({
    name: "npm",
    command: "npm",
    versionArgs: ["--version"],
    source: "https://nodejs.org/en/download",
    updater: { kind: "none" },
  }),
  tool({
    name: "bun",
    command: "bun",
    versionArgs: ["--version"],
    source: "https://bun.sh/docs/installation",
    updater: { kind: "self", argv: ["upgrade"] },
  }),
  tool({
    name: "composio",
    command: "composio",
    versionArgs: ["--version"],
    source: "https://docs.composio.dev/docs/cli",
    updater: { kind: "self", argv: ["upgrade"] },
    activation: {
      tier: "recommended",
      setup: "launchpad",
      // `composio whoami` prints one JSON object line when signed in and
      // "You are not logged in" otherwise, with exit code 0 either way.
      signInProbe: {
        argv: ["whoami"],
        account: {
          kind: "json",
          paths: [["email"]],
          organization: ["current_org_name"],
          requireAccount: true,
        },
        signedOut: "not logged in",
      },
      installation: installation(
        "Cílový stav: `composio` ve standardní cestě `~/.local/bin/composio`, nainstalované oficiálním instalátorem podle https://docs.composio.dev/docs/cli; instalátor si smí držet vlastní domov a do `~/.local/bin` vede jen link nebo wrapper. Operátor se přihlásí příkazem `composio login` a odkaz, který příkaz vrátí, otevře ve svém prohlížeči; jednotlivé aplikace pak člověk připojuje v Launchpadu v Apps → Integrace. Přihlášení platí pro celý tenhle Environment. Důkaz: `composio --version` odpoví a `composio whoami` skončí kódem 0 a jmenuje zamýšlený účet.",
        "Target state: `composio` in the standard path `~/.local/bin/composio`, installed by the official installer per https://docs.composio.dev/docs/cli; the installer may keep its own home, with only a link or wrapper in `~/.local/bin`. The Operator signs in with `composio login` and opens the link the command returns in their browser; the person then connects single applications in the Launchpad under Apps → Integrations. The sign-in holds for this whole Environment. Proof: `composio --version` answers and `composio whoami` exits 0 and names the intended account.",
      ),
      purpose: {
        cs: "Composio CLI pro externí aplikace (pošta, kalendář, chat a další) napojené pro celý tenhle Environment.",
        en: "Composio CLI for external applications (mail, calendar, chat and others) connected for this whole Environment.",
      },
      usage: writingUsage(
        "Přihlášení ověř příkazem `composio whoami`. Composio používej jen pro Integrace, jejichž cestou je Composio (`lazurio integrations list --json`): nástroje najdeš přes `composio search` a spustíš přes `composio execute`. Aplikaci sám nepřipojuj; chybí-li, pošli člověku odkaz na její kartu v Apps → Integrace.",
        "Check the sign-in with `composio whoami`. Use Composio only for the Integrations whose path is Composio (`lazurio integrations list --json`): find tools with `composio search` and run them with `composio execute`. Never connect an app yourself; when one is missing, send the person the link to its card in Apps → Integrations.",
        {
          cs: "Zápis viditelný navenek (odeslání, odevzdání formuláře, zveřejnění, smazání)",
          en: "An externally visible write (sending, submitting a form, publishing, deleting)",
        },
      ),
    },
  }),
  // The Environment vault (decision F43, root decision 0193): the Bitwarden
  // CLI signed in to the Environment's own account in its network's
  // Vaultwarden, pinned per Platform release and set up by Settings → Tools
  // → bitwarden or `lazurio vault connect`. bw writes its store on every
  // start, so even its version command gets a data directory of its own.
  tool({
    name: "bitwarden",
    command: "bw",
    versionArgs: ["--version"],
    source: "https://github.com/bitwarden/clients",
    updater: { kind: "none" },
    isolatedData: "BITWARDENCLI_APPDATA_DIR",
    activation: {
      tier: "recommended",
      setup: "launchpad",
      offered: "hosted-linux",
      task: {
        cs: "Úkol: připoj trezor tohoto Environmentu, nástroj `bitwarden` (příkaz `bw`): účet Environmentu v trezoru jeho sítě, přihlášený a odemčený pro agenty. Nejdřív zjisti skutečný stav příkazem `lazurio vault status --json`; co už funguje, neměň. Pozvat adresu účtu a potvrdit nového člena může jen Admin nebo Owner organizace v trezoru: tyhle dva kroky dělá Operátor (nebo jeho Admin) sám v trezoru, ty mu řekneš přesně co.",
        en: "Task: connect this Environment's vault, the tool `bitwarden` (command `bw`): the Environment's account in its network's vault, signed in and unlocked for agents. First read the actual state with `lazurio vault status --json`; change nothing that already works. Only an Admin or Owner of the vault's organization can invite the account's address and confirm the new member: the Operator (or their Admin) does these two steps in the vault, and you tell them exactly what.",
      },
      installation: installation(
        `Cílový stav: Bitwarden CLI ve verzi, kterou připíná Lazurio (${bitwardenPin.version}, sestavení OSS z oficiálních vydání https://github.com/bitwarden/clients), spouští \`~/.local/bin/bw\` a účet tohoto Environmentu \`vaultwarden@<adresa Environmentu>\` je v trezoru jeho sítě založený, přihlášený a odemčený. Udělá to příkaz \`lazurio vault connect --json\`: nainstaluje připnuté \`bw\`, založí účet s heslem, které vznikne tady a nezná ho žádný člověk, přihlásí ho API klíčem a vrátí stav. Hlásí-li \`awaiting-invite\`, řekni Operátorovi, že Admin nebo Owner organizace v trezoru musí pozvat adresu účtu s právem úprav do kolekce \`Environmenty/<jméno> · <stroj>\` (přesné hodnoty jsou ve výstupu příkazu), a pak příkaz spusť znovu. Hlásí-li \`confirming\`, Admin v trezoru potvrdí nového člena podle otisku z výstupu. Jinou verzi \`bw\` neinstaluj, \`~/.local/bin/bw\`, který není Lazuria, nepřepisuj a heslo účtu, API klíč ani relaci nikam nekopíruj. Důkaz: \`lazurio vault refresh --json\` hlásí \`connected\`.`,
        `Target state: the Bitwarden CLI at the version Lazurio pins (${bitwardenPin.version}, the OSS build of the official releases https://github.com/bitwarden/clients) runs as \`~/.local/bin/bw\`, and this Environment's account \`vaultwarden@<Environment address>\` exists in its network's vault, signed in and unlocked. The command \`lazurio vault connect --json\` does it: it installs the pinned \`bw\`, creates the account with a password generated here that no person knows, signs it in with its API key and returns the state. When it reports \`awaiting-invite\`, tell the Operator that an Admin or Owner of the vault's organization must invite the account's address with edit rights into the collection \`Environmenty/<name> · <machine>\` (the exact values are in the command's output), then run the command again. When it reports \`confirming\`, an Admin confirms the new member in the vault by the fingerprint in the output. Install no other version of \`bw\`, never overwrite a \`~/.local/bin/bw\` that is not Lazurio's, and copy the account's password, API key or session nowhere. Proof: \`lazurio vault refresh --json\` reports \`connected\`.`,
      ),
      purpose: {
        cs: "Bitwarden CLI (`bw`) přihlášené k vlastnímu účtu tohoto Environmentu v jeho trezoru Vaultwarden. Co v něm najdeš, smíš použít bez ptaní.",
        en: "Bitwarden CLI (`bw`) signed in to this Environment's own account in its Vaultwarden vault. What you find there you may use without asking.",
      },
      usage: writingUsage(
        'Na začátku práce spusť `eval "$(lazurio vault env)"`; dá ti odemčené `bw` k trezoru tohoto Environmentu. Když `bw` hlásí zamčený trezor, spusť `eval "$(lazurio vault env)"` znovu; když `lazurio vault env` hlásí, že trezor není připojený, pošli Operátora do Launchpadu (Nastavení → Nástroje → bitwarden). Nikdy nespouštěj `bw login`, `unlock`, `lock`, `logout` ani `bw config`: odemčení drží Launchpad pro všechny agenty a každé další odemčení ho ostatním zruší. Před čtením spusť `bw sync`, hledej `bw list items --search <služba>` a hodnotu z `bw get password|username|totp <id>` předávej rovnou do příkazu, nikdy do chatu, Gitu, logu ani PR. Nové heslo nebo token ulož do kolekce Environmentu: v šabloně `bw get template item` vyplň `organizationId` a `collectionIds` z `$LAZURIO_VAULT_ORGANIZATION_ID` a `$LAZURIO_VAULT_COLLECTION_ID`, pak `bw encode` a `bw create item`, a pojmenuj ho podle služby a účelu; do vlastního trezoru účtu nic neukládej. Chybí-li něco, požádej Operátora, ať to do kolekce nasdílí.',
        'At the start of work run `eval "$(lazurio vault env)"`; it gives you an unlocked `bw` for this Environment\'s vault. When `bw` reports a locked vault, run `eval "$(lazurio vault env)"` again; when `lazurio vault env` reports that the vault is not connected, send the Operator to the Launchpad (Settings → Tools → bitwarden). Never run `bw login`, `unlock`, `lock`, `logout` or `bw config`: the Launchpad keeps the unlocked session for all agents and every further unlock ends it for the others. Run `bw sync` before reading, search with `bw list items --search <service>` and pass a value of `bw get password|username|totp <id>` straight into a command, never into chat, Git, a log or a PR. Store a new password or token in the Environment\'s collection: fill `organizationId` and `collectionIds` of the `bw get template item` template from `$LAZURIO_VAULT_ORGANIZATION_ID` and `$LAZURIO_VAULT_COLLECTION_ID`, then `bw encode` and `bw create item`, and name it after the service and its purpose; store nothing in the account\'s own vault. When something is missing, ask the Operator to share it into the collection.',
        {
          cs: "Navenek viditelný zápis do služby, ke které přístup z trezoru patří,",
          en: "An externally visible write to the service a credential of the vault belongs to",
        },
      ),
    },
  }),
  tool({
    name: "wacli",
    command: "wacli",
    versionArgs: ["--version"],
    source: "https://github.com/openclaw/wacli",
    updater: { kind: "none" },
    activation: {
      tier: "optional",
      setup: "launchpad",
      signInProbe: {
        argv: ["auth", "status", "--json", "--read-only"],
        // wacli wraps every `--json` answer in its envelope (`internal/out`
        // `WriteJSON`): `{"success":true,"data":{"authenticated":…,
        // "linked_jid":…,"phone":…},"error":null}` (#98).
        account: {
          kind: "json",
          paths: [
            ["data", "phone"],
            ["data", "linked_jid"],
          ],
          flag: ["data", "authenticated"],
        },
      },
      installation: installation(
        "Cílový stav: `wacli` ve standardní cestě `~/.local/bin/wacli`, z oficiálního zdroje https://github.com/openclaw/wacli (Homebrew tap `openclaw/tap/wacli` nebo předpřipravený archiv z GitHub Releases; link nebo wrapper v `~/.local/bin`). Operátor spáruje CLI příkazem `wacli auth`: QR kód z terminálu naskenuje ve WhatsAppu na obrazovce Propojená zařízení; párování dělá jen on, svým telefonem. Relace je uložená v úložišti nástroje (Linux `~/.local/state/wacli`, jinde `~/.wacli`) a nikam se nekopíruje. Důkaz: `wacli --version` odpoví a `wacli auth status --json` hlásí přihlášený účet.",
        "Target state: `wacli` in the standard path `~/.local/bin/wacli`, from the official source https://github.com/openclaw/wacli (the Homebrew tap `openclaw/tap/wacli` or a prebuilt archive from GitHub Releases; a link or wrapper in `~/.local/bin`). The Operator pairs the CLI with `wacli auth`: they scan the terminal QR code in WhatsApp on the Linked devices screen; only they pair, with their own phone. The session lives in the tool's store (Linux `~/.local/state/wacli`, elsewhere `~/.wacli`) and is copied nowhere. Proof: `wacli --version` answers and `wacli auth status --json` reports the signed-in account.",
      ),
      purpose: {
        cs: "WhatsApp CLI pro čtení a odesílání zpráv z WhatsApp účtu Operátora.",
        en: "WhatsApp CLI for reading and sending messages of the Operator's WhatsApp account.",
      },
      usage: writingUsage(
        "Přihlášení ověř příkazem `wacli auth status --json`. Pro čtení používej `--read-only`.",
        "Check the sign-in with `wacli auth status --json`. Use `--read-only` for reading.",
        { cs: "Odeslání zprávy", en: "Sending a message" },
      ),
    },
  }),
  tool({
    name: "gogcli",
    command: "gog",
    versionArgs: ["--version"],
    source: "https://github.com/openclaw/gogcli",
    updater: { kind: "none" },
    activation: {
      tier: "optional",
      setup: "agent",
      // Google of the company comes through the Organization's company app
      // (root decision 0162 addendum 2026-10-09 point 5): a work
      // Environment does not offer gogcli; a personal one does.
      offered: "personal",
      signInProbe: {
        argv: ["auth", "list", "--check", "--json", "--no-input"],
        account: {
          kind: "json",
          paths: [["email"], ["account"]],
          list: [[], ["accounts"]],
        },
      },
      installation: installation(
        "Cílový stav: `gog` ve standardní cestě `~/.local/bin/gog`, z oficiálního zdroje https://github.com/openclaw/gogcli (Homebrew tap `openclaw/tap/gogcli` nebo binárka z vydání projektu; link nebo wrapper v `~/.local/bin`). Řekni Operátorovi předem a poctivě, co přihlášení obnáší: potřebuje vlastního OAuth klienta typu Desktop ve svém Google Cloud projektu, jehož staženým souborem se nástroj nastaví (`gog auth credentials set <soubor>`), a souhlas v prohlížeči, po kterém vloží zpět URL přesměrování (`gog auth add <email> --remote --step 1` a potom `--step 2`, nebo `--manual`). Soubor klienta i URL přesměrování s kódem jsou tajemství: předej je jen příkazu a nikde je neopakuj. Na headless Linuxu bez systémové klíčenky potřebuje souborový backend klíčenky heslo; to je tajemství držené v custody Operátora, nikdy ve skriptu, Gitu ani chatu; přesné nastavení backendu vezmi z dokumentace gogcli. Důkaz: `gog --version` odpoví a `gog auth list --check --json --no-input` skončí kódem 0 a jmenuje zamýšlený účet.",
        "Target state: `gog` in the standard path `~/.local/bin/gog`, from the official source https://github.com/openclaw/gogcli (the Homebrew tap `openclaw/tap/gogcli` or a binary of the project's releases; a link or wrapper in `~/.local/bin`). Tell the Operator up front and honestly what the sign-in takes: their own Desktop OAuth client in their Google Cloud project, whose downloaded file configures the tool (`gog auth credentials set <file>`), and a browser consent after which they paste the redirect URL back (`gog auth add <email> --remote --step 1` and then `--step 2`, or `--manual`). The client file and the redirect URL with its code are secrets: pass them only to the command and repeat them nowhere. On a headless Linux without a system keyring the file keyring backend needs a password; it is a secret held in the Operator's custody, never in a script, Git or chat; take the exact backend settings from the gogcli documentation. Proof: `gog --version` answers and `gog auth list --check --json --no-input` exits 0 and names the intended account.",
      ),
      purpose: {
        cs: "Google Workspace (Gmail, Kalendář, Disk…) z příkazové řádky; alternativa pro Operátory, kteří nechtějí Composio.",
        en: "Google Workspace (Gmail, Calendar, Drive…) from the command line; the alternative for Operators who do not want Composio.",
      },
      usage: writingUsage(
        "Přihlášení ověř příkazem `gog auth list --check --json --no-input`. Pro čtení používej `--readonly` a `--json`.",
        "Check the sign-in with `gog auth list --check --json --no-input`. Use `--readonly` and `--json` for reading.",
        {
          cs: "Odeslání pošty, změna kalendáře nebo sdílení souboru",
          en: "Sending mail, changing a calendar or sharing a file",
        },
      ),
    },
  }),
  tool({
    name: "neon",
    command: "neon",
    versionArgs: ["--version"],
    source: "https://neon.com/docs/reference/neon-cli",
    updater: { kind: "none" },
    activation: {
      tier: "optional",
      setup: "agent",
      signInProbe: {
        argv: ["me", "-o", "json"],
        account: { kind: "json", paths: [["email"], ["login"]] },
      },
      installation: installation(
        "Cílový stav: `neon` (alias `neonctl`) ve standardní cestě `~/.local/bin/neon`, z oficiálního zdroje https://neon.com/docs/reference/cli-install: binárka z vydání `neondatabase/neon-pkgs`, Homebrew formule `neonctl`, nebo npm balíček nad Node.js Operátora. Jméno npm balíčku a požadovanou verzi Node.js ověř na té stránce před instalací: dokumentace a README repozitáře `neondatabase/neonctl` je v době zápisu uvádějí různě a Lazurio je neověřilo. Operátor se přihlásí příkazem `neon login` (starší jméno `neon auth`), který otevírá okno prohlížeče k autorizaci; zda to jde dokončit na Environmentu bez prohlížeče, ověřeno není. Druhá dokumentovaná cesta je API klíč Neonu v proměnné `NEON_API_KEY`: je to tajemství v custody Operátora a nikdy se nepředává v argumentu příkazu, který skončí v historii nebo logu. Kam nástroj přihlášení ukládá, zjisti z `--config-dir` v dokumentaci; ten soubor nekopíruj. Důkaz: `neon --version` odpoví a `neon me -o json` skončí kódem 0 a jmenuje zamýšlený účet.",
        "Target state: `neon` (alias `neonctl`) in the standard path `~/.local/bin/neon`, from the official source https://neon.com/docs/reference/cli-install: a binary of the `neondatabase/neon-pkgs` releases, the Homebrew formula `neonctl`, or the npm package on the Operator's Node.js. Verify the npm package name and the required Node.js version on that page before installing: the documentation and the README of the `neondatabase/neonctl` repository state them differently at the time of writing and Lazurio has not verified them. The Operator signs in with `neon login` (older name `neon auth`), which opens a browser window for authorization; whether it can be completed in an Environment without a browser is not verified. The other documented way is a Neon API key in the `NEON_API_KEY` variable: it is a secret in the Operator's custody and is never passed in a command argument that ends in history or a log. Find where the tool stores the sign-in from `--config-dir` in the documentation; do not copy that file. Proof: `neon --version` answers and `neon me -o json` exits 0 and names the intended account.",
      ),
      purpose: {
        cs: "Neon CLI pro správu Postgres projektů, větví a databází v Neonu.",
        en: "Neon CLI for managing Postgres projects, branches and databases in Neon.",
      },
      usage: {
        cs: "Přihlášení ověř příkazem `neon me -o json`. Čti s `-o json`; vytvoření, změna nebo smazání projektu, větve či databáze vyžaduje pokyn Operátora.",
        en: "Check the sign-in with `neon me -o json`. Read with `-o json`; creating, changing or deleting a project, branch or database needs the Operator's instruction.",
      },
    },
  }),
]);

/** The Environment vault's catalog tool (decision F43): set up by `lazurio
 * vault connect` and Settings → Tools → bitwarden, not by the curated
 * install and sign-in of F19. */
export const vaultToolName = "bitwarden";

/** Executor's catalog tool (decision F44): set up by Lazurio itself
 * (`lazurio executor setup`, the Launchpad after it starts, Settings → Tools
 * → executor), not by the curated install and sign-in of F19. */
export const executorToolName = "executor";

/** Whether Lazurio offers a tool in an Environment of this preset, on Linux
 * or elsewhere (`ToolActivation.offered`). A Remote Environment is always
 * Linux; `local` is the person's own computer. */
export function toolOffered(
  entry: Pick<ActivatableTool, "activation">,
  environment: Readonly<{ preset: PresetName; linux: boolean }>,
): boolean {
  const offered = entry.activation.offered;
  if (offered === "hosted-linux")
    return environment.preset !== "local" && environment.linux;
  if (offered === "personal")
    return (
      environment.preset === "local" || environment.preset === "hosted-personal"
    );
  return true;
}

export function findTool(name: string): ToolEntry | undefined {
  return toolCatalog.find((entry) => entry.name === name);
}

const isActivatable = (entry: ToolEntry): entry is ActivatableTool =>
  entry.activation !== undefined;

// The catalog tools an Environment's instructions may name, in catalog order.
export function activatableTools(): readonly ActivatableTool[] {
  return toolCatalog.filter(isActivatable);
}

// Always on, never stored and never disabled.
export function requiredTools(): readonly ActivatableTool[] {
  return activatableTools().filter(
    (entry) => entry.activation.tier === "required",
  );
}

// The one validator of an enabled-tools list, for stored state and for a
// request alike: own data only, names of `recommended` or `optional` catalog
// tools, sorted and unique, so one selection has exactly one representation.
// An empty list is a valid selection; whether it may be stored is the state
// parser's rule.
export function parseEnabledTools(input: unknown): readonly string[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    throw new Error("Invalid enabled tools");
  const names: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (!descriptor || !("value" in descriptor))
      throw new Error("Invalid enabled tools");
    const name: unknown = descriptor.value;
    const tier =
      typeof name === "string"
        ? activatableTools().find((entry) => entry.name === name)?.activation
            .tier
        : undefined;
    if (typeof name !== "string" || tier === undefined || tier === "required")
      throw new Error("Unknown or required enabled tool");
    const previous = names.at(-1);
    if (previous !== undefined && previous >= name)
      throw new Error("Enabled tools must be sorted and unique");
    names.push(name);
  }
  if (Reflect.ownKeys(input).length !== input.length + 1)
    throw new Error("Invalid enabled tools");
  return Object.freeze(names);
}

export type ToolNotes = Readonly<Record<string, string>>;

// The one validator of the operator's notes (decision F18, addendum
// 2026-09-27), for stored state and for a request alike: a plain object of own
// data fields, keyed by the names of activatable tools that are on in the
// given selection (required, or enabled), in sorted order, each value a note
// in its stored form (`toolNoteProblem`). Sorted keys give one selection one
// representation. An empty object is valid; whether it may be stored is the
// state parser's rule.
export function parseToolNotes(
  input: unknown,
  enabled: readonly string[],
): ToolNotes {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Invalid tool notes");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Invalid tool notes");
  const on = activeTools(enabled).map((entry) => entry.name);
  const notes: Record<string, string> = {};
  let previous: string | undefined;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !on.includes(key))
      throw new Error("A note needs a required or enabled catalog tool");
    if (previous !== undefined && previous >= key)
      throw new Error("Tool notes must be sorted");
    previous = key;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("Invalid tool notes");
    const note: unknown = descriptor.value;
    if (typeof note !== "string" || toolNoteProblem(note) !== null)
      throw new Error("Invalid tool note");
    notes[key] = note;
  }
  return Object.freeze(notes);
}

// What agents on the Environment are told to use: the required tools and the
// enabled ones, in catalog order.
export function activeTools(
  enabled: readonly string[],
): readonly ActivatableTool[] {
  return activatableTools().filter(
    (entry) =>
      entry.activation.tier === "required" || enabled.includes(entry.name),
  );
}

// The catalog as a selection surface: every activatable tool with its tier
// and whether it is on in this Folder (a required tool always is).
export type ToolSelection = Readonly<{
  name: string;
  tier: ToolTier;
  setup: ToolSetup;
  enabled: boolean;
}>;
export function toolSelection(
  enabled: readonly string[],
): readonly ToolSelection[] {
  return activatableTools().map((entry) => ({
    name: entry.name,
    tier: entry.activation.tier,
    setup: entry.activation.setup,
    enabled:
      entry.activation.tier === "required" || enabled.includes(entry.name),
  }));
}

// The prepared prompt for an agent who installs a tool and guides its
// sign-in: the task, the target state and the rule that the Folder is told
// afterwards. For a `setup: "agent"` tool the Launchpad hands it to a chat;
// for a `launchpad` tool it is what a fallback agent follows. Text only:
// producing it installs nothing and grants nothing.
export function toolPrompt(
  name: string,
  locale: "cs" | "en",
  /** `team`: the Environment is a Team Environment; a tool with a Team
   * target state (gh) is then set up without any sign-in. */
  options: Readonly<{ team?: boolean }> = {},
): string | undefined {
  const entry = activatableTools().find((tool) => tool.name === name);
  if (!entry) return undefined;
  const { activation, command } = entry;
  const team = options.team === true ? activation.team : undefined;
  const enable =
    activation.tier === "required"
      ? {
          cs: `\`${name}\` je povinný nástroj a v instrukcích Folderu je vždy; nic se nezapíná.`,
          en: `\`${name}\` is a required tool and is always in the Folder instructions; nothing is enabled.`,
        }
      : {
          cs: `Po úspěšné instalaci a přihlášení nástroj zapni příkazem \`lazurio tools enable ${name} --folder <Folder> --expected-revision <n>\`, aby ho instrukce Folderu uváděly; revizi zjistíš z \`lazurio tools list --folder <Folder> --json\`.`,
          en: `After a successful installation and sign-in enable the tool with \`lazurio tools enable ${name} --folder <Folder> --expected-revision <n>\` so the Folder instructions name it; read the revision from \`lazurio tools list --folder <Folder> --json\`.`,
        };
  const stop = {
    cs: "Když cílového stavu nedosáhneš, přestaň, nahlas přesně, co chybí, a nic neobcházej.",
    en: "If you cannot reach the target state, stop, report exactly what is missing and work around nothing.",
  };
  if (team === undefined && activation.task !== undefined)
    return [
      activation.task[locale],
      activation.installation[locale],
      enable[locale],
      stop[locale],
    ].join("\n\n");
  if (team !== undefined)
    return [
      {
        cs: `Úkol: zajisti, aby na tomhle Environmentu fungoval nástroj \`${name}\` (příkaz \`${command}\`). ${activation.purpose.cs}`,
        en: `Task: make sure the tool \`${name}\` (command \`${command}\`) works in this Environment. ${activation.purpose.en}`,
      }[locale],
      {
        cs: "Nejdřív zjisti skutečný stav příkazem `lazurio tools status --json`; co už funguje, neměň. Instaluj jen z oficiálního zdroje a jen v mandátu, který ti dal Operátor.",
        en: "First read the actual state with `lazurio tools status --json`; change nothing that already works. Install only from the official source and only within the mandate the Operator gave you.",
      }[locale],
      team[locale],
      enable[locale],
      stop[locale],
    ].join("\n\n");
  return [
    {
      cs: `Úkol: nainstaluj na tomhle Environmentu nástroj \`${name}\` (příkaz \`${command}\`) a proveď Operátora přihlášením. ${activation.purpose.cs}`,
      en: `Task: install the tool \`${name}\` (command \`${command}\`) in this Environment and guide the Operator through the sign-in. ${activation.purpose.en}`,
    }[locale],
    {
      cs: "Nejdřív zjisti skutečný stav příkazem `lazurio tools status --json`; co už funguje, neměň. Instaluj jen z oficiálního zdroje a jen v mandátu, který ti dal Operátor; přihlášení dělá Operátor sám.",
      en: "First read the actual state with `lazurio tools status --json`; change nothing that already works. Install only from the official source and only within the mandate the Operator gave you; the Operator does the sign-in themselves.",
    }[locale],
    activation.installation[locale],
    enable[locale],
    stop[locale],
  ].join("\n\n");
}

// A custom MCP server of the Environment (decision F42, root decision 0162
// addendum of 2026-10-09): people add one in Apps → Integrace → Vlastní; an
// agent adds one only on the Operator's explicit request, and always to the
// Environment's Executor, never to its own harness alone. The prepared prompt
// for that agent. Text only: producing it installs nothing and grants
// nothing.
export function mcpServerPrompt(locale: "cs" | "en"): string {
  return [
    {
      cs: "Úkol: přidej do Executoru tohohle Environmentu vlastní MCP server. Nejdřív se Operátora zeptej, který server chce přidat (adresu URL, nebo příkaz na tomhle Environmentu) a k čemu ho agenti mají používat; nic nepředpokládej.",
      en: "Task: add a custom MCP server to this Environment's Executor. First ask the Operator which server they want to add (a URL, or a command in this Environment) and what agents should use it for; assume nothing.",
    }[locale],
    {
      cs: "Dej přednost oficiálnímu MCP serveru poskytovatele. Když žádný není, řekni to Operátorovi a navrhni mu možnosti; server z neověřeného zdroje ani server postavený na scrapingu nebo cookies prohlížeče nenastavuj.",
      en: "Prefer the provider's official MCP server. If there is none, tell the Operator and offer the options; do not set up a server from an unverified source or one built on scraping or browser cookies.",
    }[locale],
    {
      cs: 'Server přidej do Executoru, ne do svého harnessu: Executor ho dá všem agentům a botům Environmentu. Adresu ověř příkazem `executor call executor mcp probeEndpoint \'{"endpoint":"<adresa>"}\'` a server přidej příkazem `executor call executor mcp addServer`, vzdálený s `{"transport":"remote","name":"<název>","endpoint":"<adresa>","remoteTransport":"auto","auth":{"kind":"none"}}`, příkaz s `{"transport":"stdio","name":"<název>","command":"<příkaz>","args":[…]}`. Vzdálenému serveru bez přihlášení pak založ připojení: `executor call executor coreTools connections create \'{"owner":"org","name":"default","integration":"<slug>","template":"none"}\'`. Executor obojí pozastaví ke schválení; výslovný pokyn Operátora je to schválení, potvrď ho příkazem `executor resume --execution-id <id> --action accept --content \'{}\'`.',
      en: 'Add the server to Executor, not to your harness: Executor gives it to every agent and bot of the Environment. Check the address with `executor call executor mcp probeEndpoint \'{"endpoint":"<address>"}\'` and add the server with `executor call executor mcp addServer`, a remote one with `{"transport":"remote","name":"<name>","endpoint":"<address>","remoteTransport":"auto","auth":{"kind":"none"}}`, a command with `{"transport":"stdio","name":"<name>","command":"<command>","args":[…]}`. Then create the connection of a remote server without sign-in: `executor call executor coreTools connections create \'{"owner":"org","name":"default","integration":"<slug>","template":"none"}\'`. Executor pauses both for approval; the Operator\'s explicit request is that approval, confirm it with `executor resume --execution-id <id> --action accept --content \'{}\'`.',
    }[locale],
    {
      cs: "Potřebuje-li server přihlášení nebo klíč, nepřidávej ho sám: Operátor ho přidá v Launchpadu v Apps → Integrace → Vlastní, kde se přihlásí nebo klíč zadá sám. Tajemství (token, heslo, klíč, kód) nikdy nepatří do chatu, Gitu ani logu a konzoli Executoru Operátorovi neotvírej.",
      en: "When the server needs a sign-in or a key, do not add it yourself: the Operator adds it in the Launchpad under Apps → Integrations → Custom, where they sign in or enter the key themselves. A secret (token, password, key, code) never belongs in chat, Git or a log, and never open Executor's console for the Operator.",
    }[locale],
    {
      cs: "Do Lazurio Folderu nic nezapisuj. Nakonec ověř, že `lazurio integrations list --json` server uvádí mezi vlastními (`custom`), a řekni Operátorovi, co je přidané a že ho odebere v Apps → Integrace → Vlastní.",
      en: "Record nothing in the Lazurio Folder. Finally verify that `lazurio integrations list --json` lists the server among the custom ones (`custom`), and tell the Operator what is added and that they remove it in Apps → Integrations → Custom.",
    }[locale],
    {
      cs: "Když cílového stavu nedosáhneš, přestaň, nahlas přesně, co chybí, a nic neobcházej.",
      en: "If you cannot reach the target state, stop, report exactly what is missing and work around nothing.",
    }[locale],
  ].join("\n\n");
}
