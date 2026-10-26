// A synthetic `composio` 0.4.x for the Integrace contract (decision F42). It
// answers the documented outputs of the commands the Launchpad runs, taken
// from the CLI's help and its source (`ComposioHQ/composio`,
// `ts/packages/cli`, read 2026-10-08 and 2026-10-09):
// - `connections list` prints every status, an alias only when the toolkit
//   has more than one account, and no ids; as Lazurio's build (the state's
//   `lazurioBuild`, decision F42 addendum (3)) every account's id, its alias
//   (null for none) and its `display_name` where it has one;
// - `link <toolkit> --list` prints the active accounts with their ids, word
//   ids and aliases;
// - `whoami` names the account and its current organization (`First`, or
//   the state's `organization`; none where that is null);
// - `link --no-wait --no-browser [--alias]` prints the pending connection
//   as JSON. It refuses an alias in use before it creates anything, but a
//   second account without an alias only after it created the link, which
//   then stays pending; both refusals log the error and exit 0;
// - `connections remove` asks for confirmation, and without a terminal it
//   removes nothing; `--yes` (and `-y`) exists only when the state says so
//   (not in Composio's CLI as of 0.4.3, in Lazurio's build; Lazurio removes
//   only where it is);
// - `--version` prints the state's `version`, else the build's as Lazurio's
//   build, else 0.4.1;
// - `login --no-wait` prints its link and `login --poll` completes it on the
//   CLI's own backing-off schedule once the person approved it.
// A test may hold the next `link <toolkit> --list` (`hold-<toolkit>` in the
// state's directory) until it releases it (`release-<toolkit>`): that call
// answers what the state said when it started, as a slow CLI would.
// It may hold the next `link <toolkit> --no-wait` the same way after the
// pending account exists (`hold-link-<toolkit>`, `release-link-<toolkit>`),
// as a slow link would.
// State: `$HOME/.fake-composio/state.json`; every call is appended to
// `calls.jsonl` there. It never reads `~/.composio/user_data.json` and never
// reaches a vendor.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { composioBuild } from "../../src/tools/composio-build";
import type { FakeAccount, FakeComposioState } from "./integrations-world";

const home = process.env.HOME ?? "";
const directory = join(home, ".fake-composio");
const args = process.argv.slice(2);
appendFileSync(join(directory, "calls.jsonl"), `${JSON.stringify(args)}\n`, {
  mode: 0o600,
});
const state = JSON.parse(
  readFileSync(join(directory, "state.json"), "utf8"),
) as FakeComposioState;

function save(value: FakeComposioState = state) {
  const temporary = join(directory, `state.${process.pid}.json`);
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, join(directory, "state.json"));
}
const print = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const log = (text: string) => process.stderr.write(`${text}\n`);
function end(code: number): never {
  process.exit(code);
}
function requireAuth() {
  if (state.signedIn) return;
  log("You are not logged in yet. Please run `composio login`.");
  end(0);
}
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
function cachedSlugs(): string[] {
  try {
    return (
      JSON.parse(
        readFileSync(join(home, ".composio", "toolkits.json"), "utf8"),
      ) as { slug: string }[]
    ).map((entry) => entry.slug);
  } catch {
    return [];
  }
}
const item = (account: FakeAccount) => ({
  id: account.id,
  word_id: account.word_id,
  alias: account.alias,
  status: account.status,
  status_reason: null,
  is_disabled: false,
  user_id: "consumer-user",
  toolkit: { slug: account.toolkit },
  auth_config: {
    id: "ac_fake",
    auth_scheme: "OAUTH2",
    is_composio_managed: true,
    is_disabled: false,
  },
  created_at: "2026-10-08T00:00:00.000Z",
  updated_at: "2026-10-08T00:00:00.000Z",
});

// Only one call takes a hold: the rename succeeds for exactly one process.
function holdIfAsked(toolkit: string) {
  try {
    renameSync(
      join(directory, `hold-${toolkit}`),
      join(directory, `held-${toolkit}`),
    );
  } catch {
    return;
  }
  // At most ten seconds, so a test that never releases leaves no process.
  for (
    let waited = 0;
    waited < 10_000 && !existsSync(join(directory, `release-${toolkit}`));
    waited += 20
  )
    Bun.sleepSync(20);
}

const [command, sub] = args;

if (command === "--version") {
  console.log(
    state.version ?? (state.lazurioBuild ? composioBuild.version : "0.4.1"),
  );
  end(0);
}

// `login --no-wait` keeps a pending sign-in and prints its link (the CLI's
// `pending-login-session.json` and its instructions); `login --poll` checks
// it on the CLI's own schedule, at most every 5 s and then backing off
// (`Schedule.max([exponential('0.3 seconds'), spaced('5 seconds')])`, 120
// times: checks at about 0, 5, 10, 15, 20, 25, 35, 54, 92 and 169 s), and
// signs in once the person approved it in Composio (`approve` in the
// state's directory, holding its key). `pollScale` shortens that schedule
// for a test.
if (command === "login" && args.includes("--no-wait")) {
  if (state.signedIn) {
    log("You're already logged in!");
    end(0);
  }
  state.pendingLogin = `PENDING${String(state.next++).padStart(6, "0")}`;
  save();
  const url = `https://dashboard.composio.dev/?cliKey=${state.pendingLogin}`;
  console.log(
    `Open this URL in your browser to log in:\n\n  ${url}\n\nThen run this command to complete login:\n\n  composio login --poll\n`,
  );
  end(0);
}

// The person approved this sign-in in Composio: `approve` names its key (a
// sign-in started later is not approved by it).
function approved(key: string): boolean {
  try {
    return readFileSync(join(directory, "approve"), "utf8").trim() === key;
  } catch {
    return false;
  }
}

if (command === "login" && args.includes("--poll")) {
  const key = state.pendingLogin;
  if (key === undefined) {
    log("No pending login found. Run `composio login < /dev/null` first.");
    end(1);
  }
  const scale = state.pollScale ?? 1;
  for (let attempt = 0; attempt <= 120; attempt++) {
    if (attempt > 0)
      Bun.sleepSync(Math.max(300 * 2 ** (attempt - 1), 5_000) * scale);
    const now = JSON.parse(
      readFileSync(join(directory, "state.json"), "utf8"),
    ) as FakeComposioState;
    // Another sign-in replaced this one: its key is no longer pending.
    if (now.pendingLogin !== key) break;
    if (approved(key)) {
      now.signedIn = true;
      delete now.pendingLogin;
      save(now);
      console.log(
        JSON.stringify({
          email: "op@example.com",
          current_org: { id: "org_1", name: now.organization ?? "First" },
          organizations: [],
        }),
      );
      end(0);
    }
  }
  log("Login timed out. Please try again.");
  end(1);
}

if (command === "whoami") {
  requireAuth();
  const organization =
    state.organization === undefined ? "First" : state.organization;
  console.log(
    JSON.stringify({
      account_type: "human",
      email: "op@example.com",
      ...(organization === null ? {} : { current_org_name: organization }),
      enhanced_controls_enabled: null,
    }),
  );
  end(0);
}

// `orgs list` prints its JSON array on stdout when stdout is not a terminal
// (the CLI's `ui.output`, after its human lines on stderr); `orgs switch
// --org-id` makes one current, which `whoami` then names. An organization's
// `created_at` is printed where the state gives it, as Lazurio's build does
// from 0.4.3-lazurio.3 on.
if (command === "orgs" && sub === "list") {
  requireAuth();
  log("composio dev orgs list");
  const current =
    state.organization === undefined ? "First" : state.organization;
  console.log(
    JSON.stringify(
      (state.organizations ?? []).map((organization) => ({
        id: organization.id,
        name: organization.name,
        ...(organization.created_at === undefined
          ? {}
          : { created_at: organization.created_at }),
        is_selected_global_org: organization.name === current,
      })),
    ),
  );
  end(0);
}

if (command === "orgs" && sub === "switch") {
  requireAuth();
  if (state.switchFails === true) {
    log("Failed to switch the organization.");
    end(1);
  }
  const id = option("--org-id");
  const organization = (state.organizations ?? []).find(
    (entry) => entry.id === id,
  );
  if (organization === undefined) {
    log(`Organization ${id} not found.`);
    end(1);
  }
  state.organization = organization.name;
  save();
  log(`Switched to ${organization.name}.`);
  end(0);
}

if (command === "connections" && sub === "list") {
  requireAuth();
  const toolkit = option("--toolkit");
  const listed = state.accounts.filter(
    (account) => toolkit === undefined || account.toolkit === toolkit,
  );
  const counts = new Map<string, number>();
  for (const account of listed)
    counts.set(account.toolkit, (counts.get(account.toolkit) ?? 0) + 1);
  const grouped: Record<string, unknown[]> = {};
  for (const account of listed) {
    const entries = grouped[account.toolkit] ?? [];
    entries.push(
      state.lazurioBuild === true
        ? {
            id: account.id,
            status: account.status,
            alias: account.alias,
            word_id: account.word_id,
            ...(account.display_name === undefined
              ? {}
              : { display_name: account.display_name }),
            permission_group: null,
          }
        : {
            status: account.status,
            ...((counts.get(account.toolkit) ?? 0) > 1
              ? { alias: account.alias }
              : {}),
            word_id: account.word_id,
            permission_group: null,
          },
    );
    grouped[account.toolkit] = entries;
  }
  print(grouped);
  end(0);
}

if (command === "connections" && sub === "remove") {
  if (args.includes("--help")) {
    console.log(
      [
        "USAGE",
        `  composio connections remove <account>${state.removeYes ? " [--yes]" : ""}`,
        "",
        "DESCRIPTION",
        "  Interactively remove a connected toolkit account. The command prompts for confirmation and defaults to No.",
        ...(state.removeYes
          ? [
              "",
              "FLAGS",
              "  -y, --yes    Remove without asking for confirmation",
            ]
          : []),
      ].join("\n"),
    );
    end(0);
  }
  const yes = args.includes("--yes") || args.includes("-y");
  if (yes && !state.removeYes) {
    log("Unrecognized flag: --yes");
    end(1);
  }
  requireAuth();
  const selector = (args[2] ?? "").trim().toLowerCase();
  const matches = state.accounts.filter((account) =>
    [account.id, account.alias ?? "", account.word_id, account.toolkit].some(
      (value) => value.toLowerCase() === selector,
    ),
  );
  const byId = matches.filter(
    (account) => account.id.toLowerCase() === selector,
  );
  const match =
    byId.length === 1 ? byId[0] : matches.length === 1 ? matches[0] : undefined;
  if (match === undefined) {
    log(
      matches.length === 0
        ? `No connection matched "${args[2]}".`
        : `Multiple connections matched "${args[2]}".`,
    );
    end(0);
  }
  if (!yes) {
    // No terminal: the prompt answers its default, No.
    log("No connection removed.");
    end(0);
  }
  state.accounts = state.accounts.filter((account) => account !== match);
  save();
  log(`Removed ${match.toolkit} connection.`);
  end(0);
}

if (command === "link") {
  requireAuth();
  const toolkit = args[1];
  if (toolkit === undefined || toolkit.startsWith("--")) {
    log("Missing argument. Provide a toolkit slug:\n  composio link github");
    end(0);
  }
  const active = state.accounts.filter(
    (account) => account.toolkit === toolkit && account.status === "ACTIVE",
  );
  if (args.includes("--list")) {
    holdIfAsked(toolkit);
    print({ toolkit, total: active.length, items: active.map(item) });
    end(0);
  }
  const alias = option("--alias")?.trim();
  if (alias === "") {
    log("`--alias` cannot be empty.");
    end(1);
  }
  if (!cachedSlugs().includes(toolkit)) {
    log(`Failed to create link for toolkit "${toolkit}".`);
    end(0);
  }
  const taken =
    alias === undefined
      ? undefined
      : active.find(
          (account) => account.alias?.toLowerCase() === alias.toLowerCase(),
        );
  if (taken !== undefined) {
    log(
      `Alias "${alias}" is already in use by connected account "${taken.id}".`,
    );
    end(0);
  }
  state.next += 1;
  const account: FakeAccount = {
    id: `ca_${state.next}`,
    toolkit,
    status: "INITIATED",
    alias: alias ?? null,
    word_id: `word${state.next}`,
  };
  // The preview's stand-in for a person who finishes the sign-in at once.
  if (state.activateOnLink === true) account.status = "ACTIVE";
  state.accounts.push(account);
  save();
  holdIfAsked(`link-${toolkit}`);
  // The CLI asks for an alias only after the link exists.
  if (alias === undefined && active.length > 0) {
    log(
      `A connected account already exists for user "consumer-user" in toolkit "${toolkit}". Pass --alias to create another one.`,
    );
    end(0);
  }
  const url = `https://connect.composio.dev/link/lk_fake${state.next}`;
  log("Open this URL in your browser to authorize");
  log(url);
  if (args.includes("--no-wait")) {
    print({
      status: "pending",
      message: "Complete authorization by opening the URL",
      connected_account_id: account.id,
      redirect_url: url,
      toolkit,
      project_type: "CONSUMER",
    });
    end(0);
  }
  // The real command would wait for the browser; the fake never does.
  log("Waiting for authentication...");
  end(1);
}

log(`Unknown command: ${args.join(" ")}`);
end(1);
