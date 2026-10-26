// A preview of the Launchpad (decision F36) against a temporary fixture
// Folder, never a live one: `bun scripts/preview-launchpad.ts
// local|hosted|personal cs|en [port] [owner|steward|member] [fresh]`.
// `personal` is a personal Remote Environment (`hosted-personal`); `fresh`
// leaves the Folder without any Organization, as a new Environment is before
// its content is prepared (root decision 0188). The role is what the preview's GitHub
// identity answers for the example Organization: an Owner (the default), a
// Steward (`maintain` on its module repositories) or a member. One
// Organization with root-level and workspace modules in
// Workspace, production repositories in Productionspace and an `infra` the
// Launchpad does not list (and a second Organization locally, for the rail),
// a synthetic home for Files and Tools. Prints one JSON line: `url` to open
// (local: with the fragment token) and, hosted, `proxy`: a loopback listener
// that adds the gateway's Host and cookie, which a browser automation routes
// the entry's origin through, and `browser`: the origin of the Environment
// browser's view the entry routes (decision F38). Agent-browser is not run:
// the Launchpad answers the view there with a synthetic token, and a browser
// automation stands in for that origin. In a Remote Environment, Executor
// (decision F44) is the tests' fake world: Settings → Tools → executor shows
// "not installed", and its setup runs a fake npm, program and user manager,
// never the network or this computer's services. Apps → Integrace (decision
// F42) reads a fake Executor API on a loopback port of its own (never 4789)
// with a synthetic token, and a fake `composio` signed in with two accounts,
// one of them named, in a Composio organization whose name has a space and
// diacritics (each account's menu links to Composio's dashboard): a direct
// sign-in finishes by itself after a few seconds and a Composio link at once
// (the window they open shows nothing real). Vlastní lists one server that
// Executor cannot reach, as 1.6.10 reads it (`degraded`, #322), so it says
// it could not start. Locally that fake
// stands in for a Remote Environment's Executor, so the page shows the
// direct paths (decision F44 installs none on a computer); in a Remote
// Environment the page follows Settings → Tools → executor, as in
// production. A hosted preview's Composio has the person's own
// organization of the example Organization's name ("Example Company", in
// Composio "ExampleCompany"), which the first reading makes current; with
// `composio-org-missing` anywhere after the mode it lacks it, and Apps →
// Integrace says to create it (decision F42, addendum of 2026-10-13). With
// `composio-signed-out` anywhere after the mode its Composio is signed out:
// "Připojit" starts the CLI's own two-step sign-in, whose link opens
// nothing real, and the person's approval in Composio is the sign-in's key
// (the link's `cliKey`) written into the file the JSON line names
// `composioApprove` (its poll notices it on the CLI's schedule, up to a
// minute later; decision F42, note of 2026-10-19). With
// `composio-off` anywhere
// after the mode, a hosted
// preview's example Organization does not allow Composio (root decision
// 0194, decision F45): its root becomes a Git checkout whose `main` says so,
// which the Launchpad reads as on an Organization's Environment without the
// relay, so Settings → Tools shows Composio's switch locked. With
// `microsoft365` anywhere after the mode, a hosted preview's example
// Organization sets up a fictional Microsoft 365 company app (F42 addendum (c)
// of 2026-10-14) whose callbacks list this preview's Launchpad: one card
// "Microsoft 365" offers "Připojit", and its sign-in goes to Microsoft's
// address, which a browser automation answers with a stand-in authorization
// page that returns to the Launchpad; the fake Executor holds the company
// app's integration already and finishes a sign-in only when it returns. A
// hosted preview's work Environment has its own vault (decision F53) in the
// tests' fake Vaultwarden at the example Organization's address, set up
// before the start, so Začínáme and Apps → Trezor show it with the
// steps for Bitwarden in Codex Desktop (F53's addendum of 2026-10-16); the
// fake bw keeps everything under the synthetic home, and the gateway names a
// fictional person, jana, whose own address the steps offer. A personal
// preview's vault is its person's own Bitwarden (root decision 0203 point 7)
// in the tests' fake Bitwarden cloud, waiting for its person: the JSON line's
// `bitwarden` has a fictional agents' account's `client_id`, `client_secret`
// and master password to connect with on Apps → Trezor (the account is
// in the cloud's EU region, or in the US with `bitwarden-us` anywhere after
// the mode), and `accept`, a file whose creation makes the person accept the
// invitation the page asked for, as Bitwarden's e-mail would. With `public`
// anywhere after the mode, a hosted preview's work Environment is a public
// Environment (root decision 0204, decision F55): its entry carries
// `audience: "public"`, so the Launchpad runs the demo onboarding, the
// column head says the Environment is public and shared, and Integrace and
// Nastavení → Nástroje answer as absent; Apps → Trezor shows the preview's
// vault as a Team Environment's, as the vault core makes a public
// Environment's (plan DEV-6668 slice 6), and with `no-tailnet` too it
// answers as absent, as on a public Environment without its vault. With
// `no-vault` or `no-tailnet` anywhere after the mode, a hosted preview's work
// Environment has no vault, for that reason (F53's addendum of 2026-10-17):
// nothing is set up, the Apps column does not list Trezor (F53's addendum of
// 2026-10-18 (3)), and `/vault` says why and explains the vault with its
// guide video. With `team`, `automated` or `services` anywhere after the
// mode, a hosted preview's work Environment is the example Organization's
// Team Environment, a persona's Automated Environment or the server's
// Služby serveru instead (its handover's assignment `team`, `automation` or
// `services`, root decision 0209), to see how a page names each kind
// (decision F28's addendum of 2026-10-18); Služby serveru's Productionspace
// then also lists the services of a handover shaped like the reference
// Organization's services-01, and "Otevřít stránku služby" opens the AI
// pool's page through a fake hub on the entry's port 4848 (decision F32's
// addendum of 2026-10-24; `servicesWorld` below); with `fresh` as well
// (`hosted cs <port> owner fresh services`), the Folder holds no
// Organization, as on a services Environment whose Organization install has
// not run, and Apps lists the services in a group of their own, named as
// the handover names its owner. With `vault-member` anywhere
// after the mode, the fictional person jana already has her Lazurio account
// with a master password in the hosted work Environment's vault, so Apps →
// Trezor adds and confirms her and finds her a member: the vault's video
// stands open first (F56's addendum (4) of 2026-10-19). With `gh-signed-out`
// or `gh-no-ssh` anywhere after the mode, gh is the curated sign-in's own
// fake (tests/fixtures/fake-login-tools.ts) beside a fake `ssh`, the
// system's `ssh-keygen` and `git`, all on the synthetic home (decision F19,
// addendum of 2026-10-19), and the Organization provides the AI (a fake
// codex), so Začínáme offers GitHub's step at once: `gh-signed-out` starts
// signed out, and its device code is confirmed by creating the file
// `ghApprove` of the JSON line, as the person's confirmation on GitHub
// would; `gh-no-ssh` starts signed in as octocat without an SSH key, so
// GitHub is connected badly. Without either, the stand-in gh is signed in as
// example-user and reaches GitHub over SSH (a stand-in key, GitHub's host
// keys, the greeting answered by the preview), so GitHub reads connected.
// With `gh-slow` each step of the SSH key takes 4 s, so the window can be
// closed while it links. With `codex-signed-out` anywhere after the mode, the
// AI sign-in's own fake codex and claude (tests/fixtures/fake-ai-clis.ts)
// are on the synthetic home, signed out (beside `gh-signed-out` too, whose
// fake codex is then signed out instead of the Organization's AI), so
// Začínáme offers "Přihlásit ChatGPT", "Přihlásit Claude" and beneath them
// "Přihlásit kódem" (root decision 0201 point 10): ChatGPT's code is entered
// on OpenAI's page by creating the file `codexApprove` of the JSON line, as
// the person would on any device. With `buddy` anywhere after the mode, a
// personal preview's entry routes Buddy's frame
// (`https://buddy.example.lazurio.io`, decision F60), so its shell document
// names Buddy and `<lazurio-buddy>` draws his bubble; nothing serves that
// origin, which a browser automation stands in for (the JSON line's
// `buddy`). His Hermes gateway is then the tests' stand-in
// (tests/fixtures/fake-hermes-gateway.ts), signed in, with a persona to
// confirm, so Nastavení → Buddy and his step read live; Telegram's word on a
// bot's token is a stand-in naming the bot `jana_buddy_bot`, and nothing
// reaches Telegram. His gateway taking Telegram in is creating the file
// `telegramStarted` of the JSON line, the person's Start in the bot creating
// `telegramMessage`, and a Hermes that never had Telegram `telegramReset`
// (decision F66). Synthetic names only; stop it with Ctrl-C.
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TabFacts } from "../src/browser/contract/platform";
import { addressKey } from "../src/browser/people/sleep";
import { writePersona } from "../src/buddy/persona";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { updateTools } from "../src/folder/update-profile";
import {
  microsoft365AuthTemplate,
  microsoft365PartsOf,
  microsoft365Scopes,
  microsoft365SpecId,
} from "../src/integrations/microsoft365";
import { microsoft365Description } from "../src/integrations/microsoft365-executor";
import type { NewTabHost } from "../src/launchpad/new-tab-routes";
import { startLaunchpad } from "../src/launchpad/server";
import { parseMachineContext } from "../src/machine/context";
import { serverServicesOf } from "../src/organizations/catalog";
import { toolsEnvironmentOf } from "../src/tools/overview";
import { runTool } from "../src/tools/status";
import { readConnection } from "../src/vault/connection";
import { vaultSetup } from "../src/vault/flow";
import { personAddress } from "../src/vault/members";
import {
  writeModule,
  writeOrganization,
} from "../tests/fixtures/catalog-folder";
import { fakeAiClis } from "../tests/fixtures/fake-ai-clis";
import {
  cloudHost,
  startFakeBitwardenCloud,
} from "../tests/fixtures/fake-bitwarden-cloud";
import { executorWorld } from "../tests/fixtures/fake-executor";
import { startFakeExecutor } from "../tests/fixtures/fake-executor-api";
import {
  type FakeHermesGateway,
  fakeHermesGateway,
} from "../tests/fixtures/fake-hermes-gateway";
import {
  fakeLoginTools,
  githubHostKeys,
} from "../tests/fixtures/fake-login-tools";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownContext,
  startFakeVault,
  vaultMember,
  workAccount,
  workHandover,
  zipOf,
} from "../tests/fixtures/fake-vault";
import {
  organizationWithEntry,
  personalWithEntry,
} from "../tests/fixtures/machine-bindings";
import servicesContext from "../tests/fixtures/machine-context-services.json";

const mode =
  process.argv[2] === "hosted" || process.argv[2] === "personal"
    ? process.argv[2]
    : "local";
const fresh = process.argv[6] === "fresh";
const composioOff = process.argv.slice(3).includes("composio-off");
const publicEnvironment =
  process.argv[2] === "hosted" && process.argv.slice(3).includes("public");
const microsoft365 = process.argv.slice(3).includes("microsoft365");
// With `workspace-tabs` anywhere after the mode, the example Organization has
// a dozen modules arranged into three tabs of its own (decision F32's
// addendum of 2026-10-16), the setting `workspace.tabs` of its root.
const tabbed = process.argv.slice(3).includes("workspace-tabs");
const team =
  process.argv[2] === "hosted" && process.argv.slice(3).includes("team");
const composioOrgMissing = process.argv
  .slice(3)
  .includes("composio-org-missing");
const composioSignedOut = process.argv.slice(3).includes("composio-signed-out");
const bitwardenUs = process.argv.slice(3).includes("bitwarden-us");
const vaultMemberPerson = process.argv.slice(3).includes("vault-member");
// gh as the curated sign-in's own fake (#515, #516), signed out or signed
// in without an SSH key; null: the stand-in that answers signed in.
const ghFake = process.argv.slice(3).includes("gh-signed-out")
  ? "signed-out"
  : process.argv.slice(3).includes("gh-no-ssh")
    ? "no-ssh"
    : null;
const ghSlow = process.argv.slice(3).includes("gh-slow");
// The fake codex and claude signed out: Začínáme's AI step with ChatGPT's
// sign-in by code (root decision 0201 point 10).
const codexSignedOut = process.argv.slice(3).includes("codex-signed-out");
// Buddy's frame routed by a personal preview's entry (decision F60).
const withBuddy =
  process.argv[2] === "personal" && process.argv.slice(3).includes("buddy");
const noVault =
  process.argv
    .slice(3)
    .find(
      (value): value is "no-vault" | "no-tailnet" =>
        value === "no-vault" || value === "no-tailnet",
    ) ?? null;
const assignment =
  mode !== "hosted"
    ? null
    : process.argv.slice(3).includes("team")
      ? "team"
      : process.argv.slice(3).includes("automated")
        ? "automation"
        : process.argv.slice(3).includes("services")
          ? "services"
          : null;
const locale = process.argv[3] === "en" ? "en" : "cs";
const listenPort = Number(process.argv[4] ?? 24611);
const role =
  process.argv[5] === "steward" || process.argv[5] === "member"
    ? process.argv[5]
    : "owner";
const host =
  mode === "personal" ? "example.lazurio.io" : "vm-01.example.lazurio.io";
const browserOrigin = `https://browser.${host}`;
const buddyOrigin = withBuddy ? `https://buddy.${host}` : null;
/** A personal binding whose entry routes Buddy's frame, with `buddy`. */
const buddyRouted = <T extends { entry?: object }>(binding: T): T =>
  buddyOrigin === null || binding.entry === undefined
    ? binding
    : { ...binding, entry: { ...binding.entry, buddyOrigin } };
const parent = await realpath(
  await mkdtemp(join(tmpdir(), "launchpad-preview-")),
);
const folder = join(parent, "Lazurio");
const os = executionOs(process.platform);
if (mode === "local")
  await initializeFolder(folder, {
    os,
    access: "local",
    purpose: "human",
    locale,
    detail: "concise",
    coordination: "direct",
  });
else {
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset =
    mode === "personal"
      ? "hosted-personal"
      : assignment === "team" || assignment === "services"
        ? "hosted-organization-team"
        : assignment === "automation"
          ? "hosted-organization-steward"
          : "hosted-organization-personal";
  await initializeHandoverFolder(folder, {
    preset,
    // A Remote Environment as the gateway serves it: the Environment
    // browser's view and the person's sign-out (Machines#358), and with
    // `public` a public Environment's audience (decision F55).
    machine:
      mode === "personal"
        ? buddyRouted(personalWithEntry(listenPort, true, true))
        : organizationWithEntry(
            listenPort,
            host,
            true,
            true,
            publicEnvironment,
            assignment,
          ),
    profile: presetProfile(preset, os, { locale }),
  });
}
if (!fresh && mode !== "personal") await writeExample();
async function writeExample() {
  const root = await writeOrganization(folder, "example_GEN3", {
    slug: "example",
    state: "current",
    modules: [
      { id: "mission-control", path: "mission-control" },
      { id: "design-system", path: "design-system" },
      // Workspace modules declare their repository, for a Steward's answer.
      {
        id: "knowledgebase",
        slot: { git: { url: "https://github.com/example/knowledgebase.git" } },
      },
      {
        id: "deals",
        slot: { git: { url: "https://github.com/example/deals.git" } },
      },
      { id: "website", broken: true },
      { id: "brainstorm", apps: false },
      ...(tabbed
        ? [
            "orders",
            "invoices",
            "pricing",
            "reports",
            "stock",
            "suppliers",
          ].map((id) => ({
            id,
            slot: { git: { url: `https://github.com/example/${id}.git` } },
          }))
        : []),
    ],
    slots: [
      {
        path: "infra",
        slug: "infra",
        git: { url: "https://github.com/example/infra.git", branch: "main" },
      },
      {
        path: "productionspace/firmware",
        slug: "firmware",
        git: { url: "https://github.com/example/firmware.git", branch: "main" },
      },
      {
        path: "productionspace/connect",
        slug: "connect",
        git: { url: "https://github.com/example/connect.git", branch: "main" },
      },
    ],
  });
  // What each example app declares of itself (decision F36): a title, and for
  // some a description and a semantic icon; the others show the org-agnostic
  // sentence of their stone. The website stays broken: it cannot start.
  const declared: Record<
    string,
    { title: string; description?: string; icon?: string; tags?: string[] }
  > = {
    "mission-control": {
      title: "Mission Control v3",
      description: "Plány, úkoly a koordinace práce",
    },
    "design-system": { title: "Design system v1" },
    knowledgebase: {
      title: "Knowledgebase",
      description: "Znalosti, rozhodnutí a dokumentace",
    },
    deals: { title: "Deals v2", tags: ["sales"] },
    ...(tabbed
      ? {
          orders: {
            title: "Objednávky",
            description: "Objednávky zákazníků a jejich stav",
            icon: "product",
          },
          invoices: {
            title: "Faktury",
            description: "Vydané a přijaté faktury",
            icon: "invoice",
          },
          pricing: {
            title: "Ceník",
            description: "Ceny produktů a služeb",
            icon: "pricebook",
          },
          reports: {
            title: "Reporty",
            description: "Tržby, marže a výsledky",
            icon: "profitability",
          },
          stock: {
            title: "Sklad",
            description: "Zásoby, příjem a výdej zboží",
            icon: "warehouse",
          },
          suppliers: {
            title: "Dodavatelé",
            description: "Dodavatelé a jejich podmínky",
            icon: "datasheet",
          },
        }
      : {}),
  };
  for (const [id, display] of Object.entries(declared)) {
    const file = join(
      root,
      ["mission-control", "design-system"].includes(id)
        ? id
        : `workspace/${id}`,
      "app/package.json",
    );
    const pkg = JSON.parse(await readFile(file, "utf8"));
    Object.assign(pkg.lazurio.runtime, {
      title: display.title,
      ...(display.description ? { description: display.description } : {}),
      ...(display.icon ? { icon: display.icon } : {}),
      tags: display.tags ?? [],
    });
    await writeFile(file, JSON.stringify(pkg));
  }
  if (tabbed) {
    const manifest = join(root, "lazurio.organization.json");
    const document = JSON.parse(await readFile(manifest, "utf8"));
    await writeFile(
      manifest,
      JSON.stringify({
        ...document,
        settings: {
          workspace: {
            tabs: [
              {
                name: "Každodenní práce",
                modules: [
                  "mission-control",
                  "knowledgebase",
                  "deals",
                  "orders",
                ],
              },
              { name: "Finance", modules: ["invoices", "pricing", "reports"] },
              { name: "Sklad", modules: ["stock", "suppliers"] },
            ],
          },
        },
      }),
    );
  }
  for (const path of ["infra/.git", "productionspace/firmware/.git"])
    await mkdir(join(root, path), { recursive: true });
  await writeModule(join(root, "infra"), "example", {
    id: "infra",
    apps: false,
  });
  if (mode === "local")
    await writeOrganization(folder, "northwind", {
      slug: "northwind",
      state: "current",
      modules: [{ id: "orders" }, { id: "pricing" }],
    });
}
// A synthetic home: the Files page shows its Documents, never the account's,
// and the Tools page reads no real tool or sign-in.
const home = join(parent, "home");
await mkdir(join(home, "bin"), { recursive: true });
// Buddy's own Hermes gateway (decisions F63 to F66): the tests' stand-in,
// signed in, behind the home's `~/.hermes`, and his persona as the installer
// leaves it, for the person to confirm in "Seznamte se s Buddym".
let buddyHermes: FakeHermesGateway | null = null;
if (withBuddy) {
  // A Hermes that takes Buddy's own words for a pairing reply
  // (Lazurio/hermes-agent#19).
  buddyHermes = await fakeHermesGateway({
    signedIn: true,
    pairingMessage: true,
  });
  await symlink(buddyHermes.home, join(home, ".hermes"));
  await writePersona(
    home,
    {
      buddyName: "Buddy",
      address: "vy",
      user: { nominative: "Jana", accusative: "Janu", dative: "Janě" },
    },
    null,
  );
  const hermes = buddyHermes;
  const started = join(home, "telegramStarted");
  const message = join(home, "telegramMessage");
  const reset = join(home, "telegramReset");
  setInterval(async () => {
    if (await Bun.file(reset).exists()) {
      await rm(reset, { force: true });
      Object.assign(hermes.state.telegram, {
        token: null,
        enabled: null,
        allowed: "",
        home: null,
        runtime: null,
        errorCode: null,
        pending: [],
        approved: [],
        config: {},
      });
    }
    if (await Bun.file(started).exists()) {
      await rm(started, { force: true });
      hermes.state.telegram.runtime = "connected";
    }
    if (await Bun.file(message).exists()) {
      await rm(message, { force: true });
      hermes.telegramMessage("4242424242", "jana_novakova");
    }
  }, 300);
}
for (const tool of ghFake === null ? ["gh", "t3"] : ["t3"])
  await writeFile(join(home, "bin", tool), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
// The stand-in gh reaches GitHub over SSH as its account (#515), so GitHub
// reads connected, as on a working Environment: a stand-in key of this
// Environment (nothing reads its private file), GitHub's published host
// keys in known_hosts, the system's ssh-keygen to read them, and an ssh the
// runner below answers with GitHub's greeting.
if (ghFake === null) {
  const ssh = join(home, ".ssh");
  await mkdir(ssh, { recursive: true, mode: 0o700 });
  await writeFile(join(ssh, "id_ed25519"), "preview stand-in, not a key\n", {
    mode: 0o600,
  });
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, 7),
  ]).toString("base64");
  await writeFile(join(ssh, "id_ed25519.pub"), `ssh-ed25519 ${blob} preview\n`);
  await writeFile(
    join(ssh, "known_hosts"),
    `${githubHostKeys.map((key) => `github.com ${key}`).join("\n")}\n`,
  );
  await writeFile(join(home, "bin", "ssh"), "#!/bin/sh\nexit 255\n", {
    mode: 0o755,
  });
  const keygen = Bun.which("ssh-keygen");
  if (keygen !== null) await symlink(keygen, join(home, "bin", "ssh-keygen"));
}
// The sign-in's own fake gh, ssh and the system's ssh-keygen on the
// synthetic home, and git for the Git identity the sign-in sets there. The
// Organization provides the AI (a fake codex whose provider needs no
// sign-in), so Začínáme offers GitHub's step at once.
const ghTools = ghFake === null ? null : await fakeLoginTools(home, ["gh"]);
if (ghFake !== null) {
  const git = Bun.which("git");
  if (git !== null) await symlink(git, join(home, "bin", "git"));
  if (!codexSignedOut) {
    await fakeAiClis(home, ["codex"]);
    await writeFile(join(home, "codex.provided"), "");
  }
  if (ghFake === "no-ssh") {
    await writeFile(join(home, "gh.state"), "octocat\n");
    await writeFile(
      join(home, "gh.scopes"),
      "gist read:org repo admin:public_key\n",
    );
  }
  if (ghSlow)
    for (const step of ["ssh-key-add", "api-meta", "ssh"])
      await writeFile(join(home, `slow.${step}`), "4");
}
// The AI sign-in's own fake codex and claude, signed out: ChatGPT's code is
// entered by creating `codexApprove` (root decision 0201 point 10).
if (codexSignedOut) await fakeAiClis(home);
// Integrace (decision F42): a fake composio signed in, with an active account
// named only by `link --list`, an expired one, and for Gmail an expired
// account beside a sign-in nobody finished, which the page leaves out (F42
// addendum of 2026-10-12); its CLI removes only after a prompt, so the page
// offers no "Odpojit". It stands in the standard path and is not the build
// Lazurio pins, so Apps → Integrace and Settings → Tools offer its update
// (decision F42, addendum (b) of 2026-10-14; the update itself would reach
// the network). And a fake Executor with Executor's token file of a
// synthetic token.
await mkdir(join(home, ".local", "bin"), { recursive: true });
await writeFile(
  join(home, ".local", "bin", "composio"),
  `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${join(import.meta.dir, "..", "tests", "fixtures", "fake-composio.ts")}' "$@"\n`,
  { mode: 0o755 },
);
await mkdir(join(home, ".fake-composio"), { recursive: true, mode: 0o700 });
await writeFile(
  join(home, ".fake-composio", "state.json"),
  JSON.stringify({
    signedIn: !composioSignedOut,
    removeYes: false,
    next: 100,
    activateOnLink: true,
    organization: "Příklad s.r.o.",
    // The person's own organization of the example Organization's name,
    // which the hosted preview's first reading makes current (decision F42,
    // addendum of 2026-10-13); without it, the page says to create it.
    organizations: [
      { id: "org_1", name: "Příklad s.r.o." },
      ...(composioOrgMissing ? [] : [{ id: "org_2", name: "ExampleCompany" }]),
    ],
    accounts: [
      {
        id: "ca_1",
        toolkit: "salesforce",
        status: "ACTIVE",
        alias: "Obchod",
        word_id: "castle",
      },
      {
        id: "ca_2",
        toolkit: "zoom",
        status: "EXPIRED",
        alias: null,
        word_id: "river",
      },
      {
        id: "ca_3",
        toolkit: "gmail",
        status: "EXPIRED",
        alias: "Práce",
        word_id: "meadow",
      },
      {
        id: "ca_4",
        toolkit: "gmail",
        status: "INITIATED",
        alias: null,
        word_id: "harbor",
      },
    ],
  }),
);
await mkdir(join(home, ".composio"), { recursive: true, mode: 0o700 });
await writeFile(
  join(home, ".composio", "toolkits.json"),
  JSON.stringify(
    [
      "salesforce",
      "zoom",
      "trello",
      "gmail",
      "outlook",
      "slack",
      "hubspot",
    ].map((slug) => ({ name: slug, slug })),
  ),
);
const executorToken = "previewExecutorToken000000000000";
await mkdir(join(home, ".executor", "server-control"), {
  recursive: true,
  mode: 0o700,
});
await writeFile(
  join(home, ".executor", "server-control", "auth.json"),
  JSON.stringify({ token: executorToken }),
  { mode: 0o600 },
);
await chmod(join(home, ".executor", "server-control", "auth.json"), 0o600);
const executorApi = await startFakeExecutor(
  executorToken,
  {
    integrations: [
      {
        slug: "notion-com",
        name: "Notion",
        kind: "mcp",
        transport: "remote",
        endpoint: "https://mcp.notion.com/mcp",
        auth: "oauth2",
        tools: 12,
      },
      {
        slug: "invoices",
        name: "invoices",
        kind: "mcp",
        transport: "remote",
        endpoint: "https://mcp.invoices.example.com/mcp",
        auth: "header",
        tools: 6,
        config: {
          transport: "remote",
          endpoint: "https://mcp.invoices.example.com/mcp",
          remoteTransport: "auto",
          authenticationTemplate: [
            {
              slug: "apikey",
              kind: "apikey",
              placements: [
                { carrier: "header", name: "Authorization", prefix: "Bearer " },
                {
                  carrier: "header",
                  name: "X-Api-Key",
                  variable: "header-x-api-key",
                },
              ],
            },
          ],
        },
      },
      {
        slug: "files",
        name: "Files",
        kind: "mcp",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@example/files-mcp"],
        auth: "none",
        tools: 4,
        config: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@example/files-mcp", "--root", "~/Documents"],
          cwd: "/home/preview",
          authenticationTemplate: [
            { slug: "env", kind: "stdio_env", vars: ["FILES_TOKEN"] },
          ],
        },
      },
      {
        slug: "search",
        name: "Search",
        kind: "mcp",
        transport: "stdio",
        command: "search-mcp",
        auth: "none",
        tools: 0,
        broken: true,
      },
    ],
    connections: [
      {
        owner: "org",
        name: "default",
        integration: "notion-com",
        template: "oauth2",
        identityLabel: "jana@example.com",
        health: "healthy",
      },
      {
        owner: "org",
        name: "default",
        integration: "invoices",
        template: "apikey",
        identityLabel: null,
        health: null,
      },
      {
        owner: "org",
        name: "default",
        integration: "files",
        template: "env",
        identityLabel: null,
        health: "healthy",
      },
      {
        owner: "org",
        name: "default",
        integration: "search",
        template: "none",
        identityLabel: null,
        health: "degraded",
        reason: "tool_sync_failed",
      },
    ],
  },
  // With the company app, a sign-in finishes only when it returns.
  microsoft365 ? undefined : 4_000,
);
// With the company app, Executor already holds its one integration as this
// release builds it, so the preview downloads no spec from the network.
if (microsoft365) {
  const parts = microsoft365PartsOf(["outlook", "one_drive", "share_point"]);
  executorApi.integrations.push({
    slug: "m365",
    name: "Microsoft 365",
    kind: "openapi",
    transport: "remote",
    auth: "oauth2",
    tools: 2825,
    description: microsoft365Description(microsoft365SpecId(parts)),
    authenticationTemplate: [
      {
        ...microsoft365AuthTemplate(
          parts,
          "00000000-0000-4000-8000-0000000000aa",
        ),
        scopes: [...microsoft365Scopes(parts)],
      },
    ],
  });
}
for (const endpoint of [
  "https://mcp.linear.app/mcp",
  "https://mcp.clickup.com/mcp",
  "https://mcp.figma.com/mcp",
])
  executorApi.probes.set(endpoint, { requiresOAuth: true });
executorApi.probes.set("https://mcp.deepwiki.com/mcp", {
  requiresOAuth: false,
});
// Vlastní: Codex's example address answers without a sign-in.
for (const endpoint of [
  "https://mcp.example.com/mcp",
  "https://mcp.invoices.example.com/mcp",
])
  executorApi.probes.set(endpoint, { requiresOAuth: false });
await mkdir(join(home, "Documents", "Nabídky"), { recursive: true });
await mkdir(join(home, "Documents", "Smlouvy"), { recursive: true });
await writeFile(
  join(home, "Documents", "Prezentace pro tým.pdf"),
  "x".repeat(182_000),
);
await writeFile(join(home, "Documents", "Ceník 2026.xlsx"), "x".repeat(48_000));
await writeFile(
  join(home, "Documents", "Zápis z porady.docx"),
  "x".repeat(23_000),
);
// Executor's fake world (decision F44) in a Remote Environment; its entry is
// on the tools' PATH, so the row's installation reads what its setup placed.
const executor = mode === "local" ? undefined : await executorWorld({ home });
// The work Environment's own vault, set up and connected before the start;
// the personal preview's person's own Bitwarden in the fake cloud, waiting
// for its person; locally, this process's (none on a computer).
let bitwarden: Readonly<Record<string, string>> | null = null;
const vaultHost =
  mode === "hosted"
    ? await previewVault()
    : mode === "personal"
      ? await previewBitwarden()
      : undefined;
async function previewBitwarden() {
  const cloud = await startFakeBitwardenCloud(home);
  const masterPassword = "Preview agents 2026";
  const key = await cloud.account(
    "jana+agents@example.com",
    masterPassword,
    undefined,
    "v1",
    bitwardenUs ? "us" : "eu",
  );
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const host = cloudHost({
    home,
    cloud,
    pin,
    download: fakeRelease(pin, zip).fetch,
  });
  // The person accepts the invitation the page asked for once this file
  // appears, as Bitwarden's e-mail would let them.
  const accept = join(parent, "accept");
  setInterval(async () => {
    if (!(await Bun.file(accept).exists())) return;
    await Bun.file(accept).delete();
    const connection = await readConnection(host.connection).catch(() => null);
    if (connection?.invitee) await cloud.accept(connection.invitee);
  }, 500);
  bitwarden = {
    clientId: key.clientId,
    clientSecret: key.clientSecret,
    masterPassword,
    accept,
  };
  return { ...host, enableForAgents: async () => undefined };
}
async function previewVault() {
  const vault = await startFakeVault(home);
  vault.allow(workAccount);
  // The gateway's person (jana) with her own account in the vault, master
  // password set: the membership adds and confirms her.
  if (vaultMemberPerson) vault.person(personAddress("jana"), true);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  // No vault, for the reason asked for: nothing to set up.
  if (noVault !== null)
    return {
      ...fakeHost({
        home,
        vault,
        pin,
        download: fakeRelease(pin, zip).fetch,
        context: async () => ({ kind: "unsupported", reason: noVault }),
      }),
      enableForAgents: async () => undefined,
    };
  const host = fakeHost({
    home,
    vault,
    pin,
    download: fakeRelease(pin, zip).fetch,
    context: async () =>
      ownContext(
        workHandover(vaultMember(workAccount, "Pracovní example")),
        // Služby serveru keep the Team preset's vault rule (root 0209); a
        // public Environment's vault is a Team one too (slice 6).
        team || assignment === "services" || publicEnvironment
          ? "team"
          : "work",
      ),
  });
  const setUp = await vaultSetup(host);
  if (setUp.state !== "connected")
    throw new Error("The preview's vault is not set up");
  return { ...host, enableForAgents: async () => undefined };
}
if (mode === "local") await updateTools(folder, 1, ["composio"]);
if ((composioOff || microsoft365) && mode === "hosted" && !fresh) {
  // The Launchpad reads the root with the operator's git, from its PATH.
  const git = Bun.which("git");
  if (git === null) throw new Error("composio-off needs git");
  await symlink(git, join(home, "bin", "git"));
  await updateTools(folder, 1, ["composio"]);
  const root = join(folder, "organizations", "example_GEN3");
  const manifest = join(root, "lazurio.organization.json");
  const document = JSON.parse(await readFile(manifest, "utf8"));
  await writeFile(
    manifest,
    JSON.stringify({
      ...document,
      settings: {
        ...document.settings,
        integrations: {
          ...(composioOff ? { composio: { allowed: false } } : {}),
          ...(microsoft365
            ? {
                microsoft365: {
                  tenant_id: "00000000-0000-4000-8000-0000000000aa",
                  client_id: "00000000-0000-4000-8000-0000000000bb",
                  apps: ["outlook", "one_drive", "share_point"],
                  callbacks: [
                    `https://launchpad.${host}/api/integrations/oauth/callback`,
                  ],
                },
              }
            : {}),
        },
      },
    }),
  );
  for (const args of [
    ["init", "--quiet", "--initial-branch=main"],
    ["add", "lazurio.organization.json"],
    [
      "-c",
      "user.name=Preview",
      "-c",
      "user.email=preview@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Organization settings",
    ],
  ]) {
    const git = Bun.spawn(["git", "-C", root, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
    if ((await git.exited) !== 0) throw new Error(`git ${args[0]} failed`);
  }
}
// Služby serveru's services (root decision 0209 point 6, decision F32's
// addendum of 2026-10-24), with `services`: a handover shaped like the
// reference Organization's services-01, read as the catalog reads one
// (CLIProxyAPI with the AI pool `members`, whose page is its Management
// Center on 127.0.0.1:18402, and the AI gateway `try` without a page; the
// public entry and DNS-01 without a repository). The view's hub is a fake on
// the entry's loopback port (4848) that keeps one tab per page and strip, as
// the hub does (decision F57 point 7), and lists its tabs on `/preview/tabs`
// for the browser automation that stands in for the view's origin; Nová
// karta's holder file is in a temporary runtime directory.
const services = assignment === "services" ? await servicesWorld() : null;
async function servicesWorld() {
  const served = serverServicesOf(
    parseMachineContext(
      Buffer.from(
        JSON.stringify({
          ...servicesContext,
          services: [
            { id: "entry", kind: "public-entry" },
            { id: "dns01", kind: "dns01" },
            {
              id: "try",
              kind: "ai-gateway",
              repository: "Lazurio/CLIProxyAPI",
            },
            {
              id: "members",
              kind: "ai-pool",
              repository: "Lazurio/CLIProxyAPI",
              page_port: 18402,
            },
          ],
        }),
      ),
    ),
  );
  const tabs: TabFacts[] = [];
  Bun.serve({
    hostname: "127.0.0.1",
    port: 4848,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/preview/tabs") return Response.json(tabs);
      if (url.pathname !== "/.lazurio/tabs")
        return Response.json({ error: "not-found" }, { status: 404 });
      if (request.method === "GET")
        return Response.json({
          tabs: url.searchParams.has("heap")
            ? tabs.map((tab) => ({ ...tab, heap: null }))
            : tabs,
        });
      const asked = (await request.json()) as {
        url: string;
        strip: string | null;
      };
      const known = tabs.find(
        (tab) =>
          tab.opener.kind === "new-tab" &&
          tab.opener.strip === asked.strip &&
          addressKey(tab.url) === addressKey(asked.url),
      );
      if (known !== undefined)
        return Response.json({
          id: known.id,
          view: `${browserOrigin}/t/${known.id}`,
          reused: true,
        });
      const id = (0xa00 + tabs.length)
        .toString(16)
        .toUpperCase()
        .padStart(32, "0");
      const now = new Date().toISOString();
      tabs.push({
        id,
        url: asked.url,
        title: "CLIProxyAPI Management Center",
        favicon: null,
        openedAt: now,
        usedAt: now,
        opener: { kind: "new-tab", strip: asked.strip },
        agents: [],
        holders: [],
        viewers: 0,
        closing: null,
        grace: null,
      });
      return Response.json(
        { id, view: `${browserOrigin}/t/${id}` },
        { status: 201 },
      );
    },
  });
  const runtime = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-preview-runtime-")),
  );
  const started = Date.now();
  const newTabHost: NewTabHost = {
    runtimeDirectory: runtime,
    run: null,
    readFile: (path) => readFile(path, "utf8"),
    bootClock: async () => ({
      boot: "6f2c1d0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      at: 1 + (Date.now() - started) / 1000,
    }),
    log: () => undefined,
  };
  return { served, newTabHost };
}
const app = await startLaunchpad(
  folder,
  undefined,
  undefined,
  undefined,
  mode === "local"
    ? {}
    : {
        // Služby serveru's services, and the owner's own slug the shell
        // document names it by, both from the same handover as on a services
        // Environment (`handoverServerServices`, `handoverOwnerKey`).
        ...(services === null
          ? {}
          : {
              serverServices: async () => services.served,
              ownerKey: async () => services.served?.owner.key ?? null,
            }),
        // Telegram's word on a bot's token (decision F66): a stand-in, so
        // nothing reaches Telegram.
        telegramBot: async () => ({ kind: "bot", username: "jana_buddy_bot" }),
        // A hosted preview's gateway names a fictional person with a Lazurio
        // username, as Lazurio Auth's answer does, so Apps → Trezor
        // offers her own address (F53's addendum of 2026-10-16).
        fetcher: async () =>
          new Response("ok", {
            headers:
              mode === "hosted"
                ? {
                    "x-auth-request-user":
                      "00000000-0000-4000-8000-00000000a11a",
                    "x-auth-request-preferred-username": "jana",
                  }
                : {},
          }),
      },
  // The preview's GitHub identity answers the Owner question of the Apps
  // home ("+ Nový modul", "Přístup k modulu") and a Steward's `maintain` on
  // the example Organization's repositories by its role, and its T3 Code is a
  // fork release that takes a prompt by link and pairs with a synthetic token;
  // no real account or T3 Code is asked.
  toolsEnvironmentOf(
    {
      // The sign-in's own fake gh needs its private utilities too.
      PATH:
        ghTools === null
          ? `${join(home, "bin")}:${join(home, ".local", "bin")}`
          : `${join(home, "bin")}:${ghTools}`,
      HOME: home,
    },
    process.platform,
    async (command, timeoutMs, env) =>
      command[1] === "api" &&
      command[2]?.startsWith("user/memberships/orgs/example")
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              state: "active",
              role: role === "owner" ? "admin" : "member",
            }),
            stderr: "",
          }
        : command[1] === "api" && command[2]?.startsWith("repos/example/")
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                permissions: {
                  admin: role === "owner",
                  maintain: role !== "member",
                  push: true,
                  pull: true,
                },
              }),
              stderr: "",
            }
          : ghFake === null &&
              command[0]?.endsWith("/gh") &&
              command.slice(1).join(" ") === "auth status --json hosts"
            ? {
                exitCode: 0,
                stdout: JSON.stringify({
                  hosts: {
                    "github.com": [
                      {
                        state: "success",
                        active: true,
                        host: "github.com",
                        login: "example-user",
                        tokenSource: "keyring",
                      },
                    ],
                  },
                }),
                stderr: "",
              }
            : // composio answers its own version (the fake's state).
              command[1] === "--version" &&
                !command[0]?.endsWith("/composio") &&
                !(ghFake !== null && command[0]?.endsWith("/gh"))
              ? { exitCode: 0, stdout: "t3 v0.0.45-lazurio.2\n", stderr: "" }
              : command[1] === "auth" && command[2] === "pairing"
                ? {
                    exitCode: 0,
                    stdout: JSON.stringify({
                      credential: "PreviewPairingToken",
                    }),
                    stderr: "",
                  }
                : // The stand-in gh's GitHub over SSH (above): GitHub's
                  // published host keys, and the greeting of `ssh -T`.
                  ghFake === null &&
                    command[0]?.endsWith("/gh") &&
                    command.slice(1).join(" ") === "api meta --jq .ssh_keys"
                  ? {
                      exitCode: 0,
                      stdout: `${JSON.stringify(githubHostKeys)}\n`,
                      stderr: "",
                    }
                  : ghFake === null &&
                      command[0]?.endsWith("/ssh") &&
                      command.includes("git@github.com")
                    ? {
                        exitCode: 1,
                        stdout: "",
                        stderr:
                          "Hi example-user! You've successfully authenticated, but GitHub does not provide shell access.\n",
                      }
                    : runTool(command, timeoutMs, env),
  ),
  {},
  undefined,
  undefined,
  { home, platform: process.platform, folder },
  undefined,
  undefined,
  // The Environment browser's people's view (decision F39): a thread's tab
  // answers a synthetic target id; nothing is opened.
  { openWindow: async () => ({ targetId: "0".repeat(32) }) },
  // The Environment vault: a hosted preview's own, otherwise this
  // process's.
  vaultHost,
  // Executor: the fake world in a Remote Environment, this computer's own on
  // a workstation (its second wave).
  executor?.host,
  // Integrace (decision F42): the fake Executor, and on a Remote
  // Environment a synthetic tab of the Environment browser.
  {
    // With the company app, Executor counts as set up here, as it is on a
    // Remote Environment once F44's setup ran.
    ...(mode === "local" || microsoft365 ? { executorPresent: true } : {}),
    executor: {
      dataDir: join(home, ".executor"),
      port: executorApi.port,
      uid: process.getuid?.() ?? 0,
      ownsListener: async () => true,
    },
    environmentBrowser:
      mode === "local"
        ? null
        : async () => ({ view: `${browserOrigin}/t/${"1".repeat(32)}` }),
  },
  undefined,
  // Služby serveru's Nová karta: its holder file and the fake hub above;
  // otherwise this process's (the parameter's default).
  services?.newTabHost,
);
let proxy: string | null = null;
if (mode !== "local") {
  const origin = `https://launchpad.${host}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("host", `launchpad.${host}`);
      headers.set("cookie", "__Secure-lazurio-workspace=preview");
      if (request.method !== "GET" && request.method !== "HEAD") {
        headers.set("origin", origin);
        headers.set("sec-fetch-site", "same-origin");
      }
      const answer = await fetch(
        `http://127.0.0.1:${listenPort}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? null
              : await request.arrayBuffer(),
          redirect: "manual",
        },
      );
      return new Response(answer.body, {
        status: answer.status,
        headers: answer.headers,
      });
    },
  });
  proxy = `http://127.0.0.1:${server.port}`;
}
console.log(
  JSON.stringify({
    url: app.url,
    proxy,
    browser: mode === "local" ? null : browserOrigin,
    ...(buddyOrigin === null ? {} : { buddy: buddyOrigin }),
    folder,
    ...(bitwarden === null ? {} : { bitwarden }),
    ...(composioSignedOut
      ? { composioApprove: join(home, ".fake-composio", "approve") }
      : {}),
    // The person's confirmation of gh's device code on GitHub: create it.
    ...(ghFake === null ? {} : { ghApprove: join(home, "approve") }),
    // The person's entering of ChatGPT's code on OpenAI's page: create it.
    ...(codexSignedOut ? { codexApprove: join(home, "codex.approve") } : {}),
    // Buddy's gateway taking Telegram in, and the person's Start: create
    // them.
    ...(buddyHermes === null
      ? {}
      : {
          telegramStarted: join(home, "telegramStarted"),
          telegramMessage: join(home, "telegramMessage"),
          telegramReset: join(home, "telegramReset"),
        }),
  }),
);
