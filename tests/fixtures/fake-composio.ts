// A synthetic `composio` 0.4.x for the Integrace contract (decision F42). It
// answers the documented outputs of the commands the Launchpad runs, taken
// from the CLI's help and its source (`ComposioHQ/composio`,
// `ts/packages/cli`, read 2026-10-08 and 2026-10-09):
// - `connections list` prints every status, an alias only when the toolkit
//   has more than one account, and no ids;
// - `link <toolkit> --list` prints the active accounts with their ids;
// - `link --no-wait --no-browser [--alias]` prints the pending connection
//   as JSON. It refuses an alias in use before it creates anything, but a
//   second account without an alias only after it created the link, which
//   then stays pending; both refusals log the error and exit 0;
// - `connections remove` asks for confirmation, and without a terminal it
//   removes nothing; `--yes` exists only when the state says so (not in the
//   CLI as of 0.4.3; Lazurio removes only where it is).
// State: `$HOME/.fake-composio/state.json`; every call is appended to
// `calls.jsonl` there. It never reads `~/.composio/user_data.json` and never
// reaches a vendor.
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

function save() {
  const temporary = join(directory, `state.${process.pid}.json`);
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
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

const [command, sub] = args;

if (command === "--version") {
  console.log("0.4.1");
  end(0);
}

if (command === "whoami") {
  requireAuth();
  console.log(
    JSON.stringify({
      account_type: "human",
      email: "op@example.com",
      current_org_name: "First",
      enhanced_controls_enabled: null,
    }),
  );
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
    entries.push({
      status: account.status,
      ...((counts.get(account.toolkit) ?? 0) > 1
        ? { alias: account.alias }
        : {}),
      word_id: account.word_id,
      permission_group: null,
    });
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
          ? ["", "FLAGS", "  --yes    Remove without asking for confirmation"]
          : []),
      ].join("\n"),
    );
    end(0);
  }
  const yes = args.includes("--yes");
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
