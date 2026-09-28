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
}>;

export type ToolEntry = Readonly<{
  name: string;
  command: string;
  versionArgs: readonly string[];
  source: string;
  updater: ToolUpdater;
  activation?: ToolActivation;
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
        'Cílový stav: `gh` je první spustitelný soubor toho jména na PATH operátora, ve standardní cestě `~/.local/bin/gh`, z oficiálního zdroje https://github.com/cli/cli#installation. Fungující `gh` jinde na PATH zůstává a jen se nahlásí. Operátor se přihlásí příkazem `gh auth login --hostname github.com --git-protocol ssh --web --scopes admin:public_key`: v prohlížeči otevře stránku zařízení a zadá jednorázový kód. Mašina pak má SSH klíč propojený s týmž účtem: použije se stávající výchozí klíč (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, v tomto pořadí) beze změny, jinak se příkazem `ssh-keygen` vytvoří nový klíč `ed25519` bez hesla (`~/.ssh` 0700, soukromý klíč 0600); zaregistruje ho `gh ssh-key add <klíč>.pub --title "Lazurio: <Mašina>" --type authentication` (chybí-li tokenu scope, `gh auth refresh --hostname github.com --scopes admin:public_key`); do `~/.ssh/known_hosts` přibudou jen chybějící klíče github.com zveřejněné v `gh api meta` (`ssh_keys`) a záznam github.com, který se od nich liší, se operátorovi nahlásí a nikdy nenahradí. Klíč, který GitHub odmítne jako použitý jiným účtem, se nahlásí; druhý klíč se přes něj nevytváří. Důkaz: `gh --version` odpoví, `gh auth status` skončí kódem 0 a jmenuje zamýšlený účet a `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes git@github.com` pozdraví tentýž účet. V týmovém Environmentu (hosted-organization-team) gh nepřihlašuj a klíč nepropojuj: Environment pracuje v GitHubu přes Lazurio for GitHub, které nastavuje Organizace.',
        'Target state: `gh` is the first executable of that name on the operator\'s PATH, in the standard path `~/.local/bin/gh`, from the official source https://github.com/cli/cli#installation. A working `gh` elsewhere on PATH stays and is only reported. The operator signs in with `gh auth login --hostname github.com --git-protocol ssh --web --scopes admin:public_key`: they open the device page in their browser and enter the one-time code. The Machine then has an SSH key linked to the same account: the existing default key (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, in that order) is used unchanged, otherwise a new `ed25519` key without a passphrase is created with `ssh-keygen` (`~/.ssh` 0700, private key 0600); `gh ssh-key add <key>.pub --title "Lazurio: <Machine>" --type authentication` registers it (when the token lacks the scope, `gh auth refresh --hostname github.com --scopes admin:public_key` first); `~/.ssh/known_hosts` gains only the missing github.com keys published by `gh api meta` (`ssh_keys`), and a github.com entry that differs from them is reported to the operator, never replaced. A key GitHub refuses as in use by another account is reported; no second key is created over it. Proof: `gh --version` answers, `gh auth status` exits 0 and names the intended account, and `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes git@github.com` greets that account. On a Team Environment (hosted-organization-team) do not sign in gh or link a key: the Environment works in GitHub through Lazurio for GitHub, set up by the Organization.',
      ),
      // A Team Environment works in GitHub through Lazurio for GitHub, set up
      // by the Organization (Principal 2026-09-28): there the prompt carries
      // this target state instead of the sign-in and the SSH key.
      team: installation(
        "Cílový stav v tomhle týmovém Environmentu (hosted-organization-team): na PATH operátora je funkční `gh`. Obvykle ho dodává Mašina jako brokerovaný `gh` Organizace; funkční `gh` kdekoli na PATH zůstává, jak je, a jen se nahlásí. Jen když žádný nefunguje, nainstaluje se `gh` do standardní cesty `~/.local/bin/gh` z oficiálního zdroje https://github.com/cli/cli#installation. gh nepřihlašuj a klíč nepropojuj: Environment pracuje v GitHubu přes Lazurio for GitHub, které nastavuje Organizace. Důkaz: `gh --version` odpoví.",
        "Target state on this Team Environment (hosted-organization-team): a working `gh` is on the operator's PATH. The Machine normally delivers it as the Organization's brokered `gh`; a working `gh` anywhere on PATH stays as it is and is only reported. Only when none works is `gh` installed in the standard path `~/.local/bin/gh` from the official source https://github.com/cli/cli#installation. Do not sign in gh or link a key: the Environment works in GitHub through Lazurio for GitHub, set up by the Organization. Proof: `gh --version` answers.",
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
        "Cílový stav: `composio` ve standardní cestě `~/.local/bin/composio`, nainstalované oficiálním instalátorem podle https://docs.composio.dev/docs/cli; instalátor si smí držet vlastní domov a do `~/.local/bin` vede jen link nebo wrapper. Operátor se přihlásí příkazem `composio login` a odkaz, který příkaz vrátí, otevře ve svém prohlížeči; jednotlivé aplikace pak napojuje `composio link <toolkit>` stejným způsobem. Přihlášení platí pro celé tohle Environment. Důkaz: `composio --version` odpoví a `composio whoami` skončí kódem 0 a jmenuje zamýšlený účet.",
        "Target state: `composio` in the standard path `~/.local/bin/composio`, installed by the official installer per https://docs.composio.dev/docs/cli; the installer may keep its own home, with only a link or wrapper in `~/.local/bin`. The operator signs in with `composio login` and opens the link the command returns in their browser; single applications are then connected with `composio link <toolkit>` the same way. The sign-in holds for this whole Environment. Proof: `composio --version` answers and `composio whoami` exits 0 and names the intended account.",
      ),
      purpose: {
        cs: "Composio CLI pro externí aplikace (pošta, kalendář, chat a další) napojené pro celé tohle Environment.",
        en: "Composio CLI for external applications (mail, calendar, chat and others) connected for this whole Environment.",
      },
      usage: {
        cs: "Přihlášení ověř příkazem `composio whoami`. Aplikaci napojíš příkazem `composio link <toolkit>`, který vrátí odkaz, a ten otevře operátor; nástroje najdeš přes `composio search` a spustíš přes `composio execute`. Zápis viditelný navenek (odeslání, zveřejnění, smazání) vyžaduje pokyn Principála.",
        en: "Check the sign-in with `composio whoami`. Connect an app with `composio link <toolkit>`, which returns a link for the operator to open; find tools with `composio search` and run them with `composio execute`. An externally visible write (sending, publishing, deleting) needs the Principal's instruction.",
      },
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
        account: {
          kind: "json",
          paths: [["phone"], ["linked_jid"]],
          flag: ["authenticated"],
        },
      },
      installation: installation(
        "Cílový stav: `wacli` ve standardní cestě `~/.local/bin/wacli`, z oficiálního zdroje https://github.com/openclaw/wacli (Homebrew tap `openclaw/tap/wacli` nebo předpřipravený archiv z GitHub Releases; link nebo wrapper v `~/.local/bin`). Operátor spáruje CLI příkazem `wacli auth`: QR kód z terminálu naskenuje ve WhatsAppu na obrazovce Propojená zařízení; párování dělá jen on, svým telefonem. Relace je uložená v úložišti nástroje (Linux `~/.local/state/wacli`, jinde `~/.wacli`) a nikam se nekopíruje. Důkaz: `wacli --version` odpoví a `wacli auth status --json` hlásí přihlášený účet.",
        "Target state: `wacli` in the standard path `~/.local/bin/wacli`, from the official source https://github.com/openclaw/wacli (the Homebrew tap `openclaw/tap/wacli` or a prebuilt archive from GitHub Releases; a link or wrapper in `~/.local/bin`). The operator pairs the CLI with `wacli auth`: they scan the terminal QR code in WhatsApp on the Linked devices screen; only they pair, with their own phone. The session lives in the tool's store (Linux `~/.local/state/wacli`, elsewhere `~/.wacli`) and is copied nowhere. Proof: `wacli --version` answers and `wacli auth status --json` reports the signed-in account.",
      ),
      purpose: {
        cs: "WhatsApp CLI pro čtení a odesílání zpráv z WhatsApp účtu operátora.",
        en: "WhatsApp CLI for reading and sending messages of the operator's WhatsApp account.",
      },
      usage: {
        cs: "Přihlášení ověř příkazem `wacli auth status --json`. Pro čtení používej `--read-only`; odeslání zprávy vyžaduje pokyn Principála.",
        en: "Check the sign-in with `wacli auth status --json`. Use `--read-only` for reading; sending a message needs the Principal's instruction.",
      },
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
      signInProbe: {
        argv: ["auth", "list", "--check", "--json", "--no-input"],
        account: {
          kind: "json",
          paths: [["email"], ["account"]],
          list: [[], ["accounts"]],
        },
      },
      installation: installation(
        "Cílový stav: `gog` ve standardní cestě `~/.local/bin/gog`, z oficiálního zdroje https://github.com/openclaw/gogcli (Homebrew tap `openclaw/tap/gogcli` nebo binárka z vydání projektu; link nebo wrapper v `~/.local/bin`). Řekni operátorovi předem a poctivě, co přihlášení obnáší: potřebuje vlastního OAuth klienta typu Desktop ve svém Google Cloud projektu, jehož staženým souborem se nástroj nastaví (`gog auth credentials set <soubor>`), a souhlas v prohlížeči, po kterém vloží zpět URL přesměrování (`gog auth add <email> --remote --step 1` a potom `--step 2`, nebo `--manual`). Soubor klienta i URL přesměrování s kódem jsou tajemství: předej je jen příkazu a nikde je neopakuj. Na headless Linuxu bez systémové klíčenky potřebuje souborový backend klíčenky heslo; to je tajemství držené v custody operátora, nikdy ve skriptu, Gitu ani chatu; přesné nastavení backendu vezmi z dokumentace gogcli. Důkaz: `gog --version` odpoví a `gog auth list --check --json --no-input` skončí kódem 0 a jmenuje zamýšlený účet.",
        "Target state: `gog` in the standard path `~/.local/bin/gog`, from the official source https://github.com/openclaw/gogcli (the Homebrew tap `openclaw/tap/gogcli` or a binary of the project's releases; a link or wrapper in `~/.local/bin`). Tell the operator up front and honestly what the sign-in takes: their own Desktop OAuth client in their Google Cloud project, whose downloaded file configures the tool (`gog auth credentials set <file>`), and a browser consent after which they paste the redirect URL back (`gog auth add <email> --remote --step 1` and then `--step 2`, or `--manual`). The client file and the redirect URL with its code are secrets: pass them only to the command and repeat them nowhere. On a headless Linux without a system keyring the file keyring backend needs a password; it is a secret held in the operator's custody, never in a script, Git or chat; take the exact backend settings from the gogcli documentation. Proof: `gog --version` answers and `gog auth list --check --json --no-input` exits 0 and names the intended account.",
      ),
      purpose: {
        cs: "Google Workspace (Gmail, Kalendář, Disk…) z příkazové řádky; alternativa pro operátory, kteří nechtějí Composio.",
        en: "Google Workspace (Gmail, Calendar, Drive…) from the command line; the alternative for operators who do not want Composio.",
      },
      usage: {
        cs: "Přihlášení ověř příkazem `gog auth list --check --json --no-input`. Pro čtení používej `--readonly` a `--json`; odeslání pošty, změna kalendáře nebo sdílení souboru vyžaduje pokyn Principála.",
        en: "Check the sign-in with `gog auth list --check --json --no-input`. Use `--readonly` and `--json` for reading; sending mail, changing a calendar or sharing a file needs the Principal's instruction.",
      },
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
        "Cílový stav: `neon` (alias `neonctl`) ve standardní cestě `~/.local/bin/neon`, z oficiálního zdroje https://neon.com/docs/reference/cli-install: binárka z vydání `neondatabase/neon-pkgs`, Homebrew formule `neonctl`, nebo npm balíček nad Node.js operátora. Jméno npm balíčku a požadovanou verzi Node.js ověř na té stránce před instalací: dokumentace a README repozitáře `neondatabase/neonctl` je v době zápisu uvádějí různě a Lazurio je neověřilo. Operátor se přihlásí příkazem `neon login` (starší jméno `neon auth`), který otevírá okno prohlížeče k autorizaci; zda to jde dokončit na Mašině bez prohlížeče, ověřeno není. Druhá dokumentovaná cesta je API klíč Neonu v proměnné `NEON_API_KEY`: je to tajemství v custody operátora a nikdy se nepředává v argumentu příkazu, který skončí v historii nebo logu. Kam nástroj přihlášení ukládá, zjisti z `--config-dir` v dokumentaci; ten soubor nekopíruj. Důkaz: `neon --version` odpoví a `neon me -o json` skončí kódem 0 a jmenuje zamýšlený účet.",
        "Target state: `neon` (alias `neonctl`) in the standard path `~/.local/bin/neon`, from the official source https://neon.com/docs/reference/cli-install: a binary of the `neondatabase/neon-pkgs` releases, the Homebrew formula `neonctl`, or the npm package on the operator's Node.js. Verify the npm package name and the required Node.js version on that page before installing: the documentation and the README of the `neondatabase/neonctl` repository state them differently at the time of writing and Lazurio has not verified them. The operator signs in with `neon login` (older name `neon auth`), which opens a browser window for authorization; whether it can be completed on a Machine without a browser is not verified. The other documented way is a Neon API key in the `NEON_API_KEY` variable: it is a secret in the operator's custody and is never passed in a command argument that ends in history or a log. Find where the tool stores the sign-in from `--config-dir` in the documentation; do not copy that file. Proof: `neon --version` answers and `neon me -o json` exits 0 and names the intended account.",
      ),
      purpose: {
        cs: "Neon CLI pro správu Postgres projektů, větví a databází v Neonu.",
        en: "Neon CLI for managing Postgres projects, branches and databases in Neon.",
      },
      usage: {
        cs: "Přihlášení ověř příkazem `neon me -o json`. Čti s `-o json`; vytvoření, změna nebo smazání projektu, větve či databáze vyžaduje pokyn Principála.",
        en: "Check the sign-in with `neon me -o json`. Read with `-o json`; creating, changing or deleting a project, branch or database needs the Principal's instruction.",
      },
    },
  }),
]);

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
  if (team !== undefined)
    return [
      {
        cs: `Úkol: zajisti, aby na téhle Mašině fungoval nástroj \`${name}\` (příkaz \`${command}\`). ${activation.purpose.cs}`,
        en: `Task: make sure the tool \`${name}\` (command \`${command}\`) works on this Machine. ${activation.purpose.en}`,
      }[locale],
      {
        cs: "Nejdřív zjisti skutečný stav příkazem `lazurio tools status --json`; co už funguje, neměň. Instaluj jen z oficiálního zdroje a jen v mandátu, který ti Principál dal.",
        en: "First read the actual state with `lazurio tools status --json`; change nothing that already works. Install only from the official source and only within the mandate the Principal gave you.",
      }[locale],
      team[locale],
      enable[locale],
      stop[locale],
    ].join("\n\n");
  return [
    {
      cs: `Úkol: nainstaluj na téhle Mašině nástroj \`${name}\` (příkaz \`${command}\`) a proveď operátora přihlášením. ${activation.purpose.cs}`,
      en: `Task: install the tool \`${name}\` (command \`${command}\`) on this Machine and guide the operator through the sign-in. ${activation.purpose.en}`,
    }[locale],
    {
      cs: "Nejdřív zjisti skutečný stav příkazem `lazurio tools status --json`; co už funguje, neměň. Instaluj jen z oficiálního zdroje a jen v mandátu, který ti Principál dal; přihlášení dělá operátor sám.",
      en: "First read the actual state with `lazurio tools status --json`; change nothing that already works. Install only from the official source and only within the mandate the Principal gave you; the operator does the sign-in themselves.",
    }[locale],
    activation.installation[locale],
    enable[locale],
    stop[locale],
  ].join("\n\n");
}

// The third route next to the catalog (decision F18): an MCP server an agent
// sets up on the operator's request. The prepared prompt for that agent. MCP
// servers are never recorded in the Lazurio Folder, so nothing is enabled
// afterwards. Text only: producing it installs nothing and grants nothing.
export function mcpServerPrompt(locale: "cs" | "en"): string {
  return [
    {
      cs: "Úkol: napoj na téhle Mašině další aplikaci přes MCP server. Nejdřív se operátora zeptej, kterou aplikaci chce napojit a k čemu ji agenti mají používat; nic nepředpokládej.",
      en: "Task: connect another app on this Machine through an MCP server. First ask the operator which app they want to connect and what agents should use it for; assume nothing.",
    }[locale],
    {
      cs: "Dej přednost oficiálnímu MCP serveru poskytovatele té aplikace. Když žádný není, řekni to operátorovi a navrhni mu možnosti; server z neověřeného zdroje ani server postavený na scrapingu nebo cookies prohlížeče nenastavuj.",
      en: "Prefer the official MCP server of the app's provider. If there is none, tell the operator and offer the options; do not set up a server from an unverified source or one built on scraping or browser cookies.",
    }[locale],
    {
      cs: "Server nastav pro harnessy, které na téhle Mašině skutečně jsou: pro Codex v `~/.codex/config.toml`, pro Claude Code příkazem `claude mcp add`. Nejdřív zjisti, co už je nastavené, a fungující nastavení neměň.",
      en: "Configure the server for the harnesses actually present on this Machine: for Codex in `~/.codex/config.toml`, for Claude Code with `claude mcp add`. First read what is already configured and change nothing that works.",
    }[locale],
    {
      cs: "Přihlášení dělá operátor sám ve svém prohlížeči; ty mu jen předáš odkaz, který nástroj vrátí. Tajemství (token, heslo, klíč, kód) nikdy nepatří do chatu, Gitu ani logu a operátor žádný API klíč nekopíruje.",
      en: "The operator does the sign-in themselves in their browser; you only hand over the link the tool returns. A secret (token, password, key, code) never belongs in chat, Git or a log, and the operator copies no API key.",
    }[locale],
    {
      cs: "MCP server do Lazurio Folderu nezapisuj: Folder eviduje jen nástroje z katalogu a `lazurio tools enable` se tady nepoužívá. Nakonec ověř, že harness server vidí, a nahlas operátorovi, co je nastavené a jak napojení zrušit.",
      en: "Do not record the MCP server in the Lazurio Folder: the Folder lists catalog tools only and `lazurio tools enable` is not used here. Finally verify that the harness sees the server and report to the operator what is configured and how to remove the connection.",
    }[locale],
    {
      cs: "Když cílového stavu nedosáhneš, přestaň, nahlas přesně, co chybí, a nic neobcházej.",
      en: "If you cannot reach the target state, stop, report exactly what is missing and work around nothing.",
    }[locale],
  ].join("\n\n");
}
