import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Fake `codex` and `claude` that sign in the way the real CLIs do on a
// headless Linux (read from codex-cli 0.162.1 and Claude Code 2.1.301 in a
// throwaway Ubuntu 24.04 container on 2026-10-15, F19's addendum of that
// day):
// - `codex login` listens on 127.0.0.1, runs `$BROWSER <page>` without
//   waiting for it (Rust's `webbrowser` crate; the command split at
//   whitespace), prints the page on stderr and signs in when the page
//   returns to `/auth/callback` with its `state`. `codex login status`:
//   "Logged in using ChatGPT", exit 0, or "Not logged in", exit 1.
// - `claude auth login` listens on 127.0.0.1, prints the code page (whose
//   return is `https://platform.claude.com/oauth/code/callback`) on stdout,
//   runs `$BROWSER <automatic page>` (returning to localhost `/callback`) and
//   waits for it, and reads `<code>#<state>` lines on its input. `claude auth
//   status --json`: `loggedIn` with the account, exit 0, or `loggedIn:
//   false`, exit 1.
// Switches are files in `$HOME`: `codex.fail` and `claude.fail` exit at once
// with 1; `codex.unconfirmed` ends 0 without storing a sign-in;
// `codex.page`/`claude.page` replace the page's origin; `claude.no-browser`
// never runs `$BROWSER` (a CLI that ignores it); `codex.provided` makes
// `codex app-server` answer that the configured provider needs no sign-in,
// which otherwise answers the stored ChatGPT account (`account/read`). For a
// walkthrough in a browser: `codex.auto` and `claude.auto` return from the
// page by themselves after a few seconds (no person signs in to a fake), and
// `claude.show-code` writes the code its code page would show to
// `$HOME/claude.code`.
// Every call appends its arguments and `BROWSER` to `$HOME/<cli>.calls`, its
// pid to `$HOME/<cli>.pid`. Nothing here reaches a vendor or the network.

export const fakeAi = Object.freeze({
  /** The code Claude's code page shows the person (`<code>#<state>`). */
  claudeCode: "fake-authorization-code",
  email: "person@example.com",
  organization: "person@example.com's Organization",
});

const common = `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
const home = process.env.HOME;
const flag = (name) => existsSync(home + "/" + name);
const args = process.argv.slice(2);
appendFileSync(home + "/" + CLI + ".calls", JSON.stringify({ args, browser: process.env.BROWSER ?? null }) + "\\n");
writeFileSync(home + "/" + CLI + ".pid", String(process.pid));
const state = randomBytes(12).toString("hex");
function listen(onCallback) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400).end("State mismatch");
        return;
      }
      response.writeHead(200).end("Signed in");
      onCallback(url.searchParams.get("code"));
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
`;

const codex = `const CLI = "codex";
${common}
const authFile = home + "/.codex/auth.json";
if (args[0] === "--version") { console.log("codex-cli 0.162.1"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") {
  if (existsSync(authFile)) { console.error("Logged in using ChatGPT"); process.exit(0); }
  console.error("Not logged in"); process.exit(1);
}
if (args[0] === "app-server") {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "account/read")
      console.log(JSON.stringify({ id: message.id, result: {
        account: existsSync(authFile) ? { type: "chatgpt", email: ${JSON.stringify(fakeAi.email)}, planType: "plus" } : null,
        requiresOpenaiAuth: !flag("codex.provided"),
      } }));
  });
  lines.on("close", () => process.exit(0));
} else if (args.join(" ") === "login") {
  if (flag("codex.fail")) { console.error("Error: login failed to start"); process.exit(1); }
  const port = await listen(() => {
    if (!flag("codex.unconfirmed")) {
      mkdirSync(home + "/.codex", { recursive: true });
      writeFileSync(authFile, JSON.stringify({ tokens: { id_token: "fake" } }));
    }
    console.error("Successfully logged in");
    process.exit(0);
  });
  const origin = flag("codex.page") ? "https://auth.openai.example" : "https://auth.openai.com";
  const page = origin + "/oauth/authorize?response_type=code&client_id=app_fake&redirect_uri=" +
    encodeURIComponent("http://127.0.0.1:" + port + "/auth/callback") +
    "&scope=openid+profile+email+offline_access&code_challenge=" + randomBytes(16).toString("hex") +
    "&code_challenge_method=S256&state=" + state + "&originator=codex_cli_rs";
  if (process.env.BROWSER) {
    const [command, ...rest] = process.env.BROWSER.split(/\\s+/);
    spawn(command, [...rest, page], { stdio: "ignore", detached: true }).unref();
  }
  if (flag("codex.auto"))
    setTimeout(() => fetch("http://127.0.0.1:" + port + "/auth/callback?code=auto&state=" + state), 4000);
  console.error("Starting local login server on http://localhost:" + port + ".\\nIf your browser did not open, navigate to this URL to authenticate:\\n\\n" + page + "\\n\\nOn a remote or headless machine? Use \`codex login --device-auth\` instead.");
} else {
  console.error("unexpected arguments: " + args.join(" "));
  process.exit(2);
}
`;

const claude = `const CLI = "claude";
${common}
const credentials = home + "/.claude/.credentials.json";
if (args[0] === "--version") { console.log("2.1.301 (Claude Code)"); process.exit(0); }
if (args.join(" ") === "auth status --json") {
  if (existsSync(credentials)) {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: ${JSON.stringify(fakeAi.email)}, orgId: "00000000-0000-0000-0000-000000000000", orgName: ${JSON.stringify(fakeAi.organization)}, subscriptionType: "max" }, null, 2));
    process.exit(0);
  }
  console.log(JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2));
  process.exit(1);
}
if (args.join(" ") === "auth login") {
  if (flag("claude.fail")) { console.error("Login failed: unavailable"); process.exit(1); }
  const signedIn = () => {
    mkdirSync(home + "/.claude", { recursive: true });
    writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }));
    process.stdout.write("Login successful.\\n");
    process.exit(0);
  };
  const port = await listen(() => signedIn());
  const origin = flag("claude.page") ? "https://claude.example" : "https://claude.com";
  const pageFor = (redirect) => origin + "/cai/oauth/authorize?code=true&client_id=fake-client&response_type=code&redirect_uri=" +
    encodeURIComponent(redirect) + "&scope=user%3Ainference&code_challenge=" + randomBytes(16).toString("hex") +
    "&code_challenge_method=S256&state=" + state;
  const manual = pageFor("https://platform.claude.com/oauth/code/callback");
  const automatic = pageFor("http://localhost:" + port + "/callback");
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const [code, given] = line.trim().split("#");
    if (!code || !given) { process.stderr.write("Invalid code. Please make sure the full code was copied.\\n"); return; }
    if (code === ${JSON.stringify(fakeAi.claudeCode)} && given === state) signedIn();
    process.stderr.write("Login failed: Request failed with status code 400\\n");
    process.exit(1);
  });
  if (flag("claude.auto"))
    setTimeout(() => fetch("http://127.0.0.1:" + port + "/callback?code=auto&state=" + state), 4000);
  if (flag("claude.show-code"))
    writeFileSync(home + "/claude.code", ${JSON.stringify(fakeAi.claudeCode)} + "#" + state);
  process.stdout.write("Opening browser to sign in\\u2026\\n");
  process.stdout.write("If the browser didn't open, visit: " + manual + "\\n");
  process.stdout.write("Paste code here if prompted > ");
  if (process.env.BROWSER && !flag("claude.no-browser"))
    spawnSync(process.env.BROWSER, [automatic], { stdio: "ignore" });
} else {
  console.error("unexpected arguments: " + args.join(" "));
  process.exit(2);
}
`;

/** Writes the fake CLIs (`codex`, `claude`, or both) into `<home>/bin`, as
 * scripts that run on this test's own Bun; returns that directory. */
export async function fakeAiClis(
  home: string,
  clis: readonly ("codex" | "claude")[] = ["codex", "claude"],
): Promise<string> {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of clis) {
    const script = join(bin, `${name}.mjs`);
    await writeFile(script, name === "codex" ? codex : claude);
    const launcher = join(bin, name);
    await writeFile(
      launcher,
      `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
    );
    await chmod(launcher, 0o755);
  }
  return bin;
}

/** The person in the browser: follows the page's return to the CLI on this
 * computer, as the Environment browser does once the person signed in. */
export async function returnFromPage(page: string): Promise<number> {
  const url = new URL(page);
  const redirect = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  if (redirect === null || state === null)
    throw new Error("The page has no return");
  const back = new URL(redirect);
  back.searchParams.set("code", "fake-code");
  back.searchParams.set("state", state);
  // localhost of Claude's return listens on 127.0.0.1 only.
  back.hostname = "127.0.0.1";
  return (await fetch(back)).status;
}

/** Claude's code page: the code it shows for that page. */
export function codeOfPage(page: string): string {
  const state = new URL(page).searchParams.get("state");
  if (state === null) throw new Error("The page has no state");
  return `${fakeAi.claudeCode}#${state}`;
}
