import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Fake gh, composio and wacli that behave like their documented sign-in
// output (decision F19): the device-flow lines of gh without a terminal, the
// `--no-wait` instructions and `--poll` JSON of composio, and wacli's NDJSON
// `--events` on stderr with rotating QR codes. Each waits for the file
// `$HOME/approve` as the operator's action in the browser or on the phone.
// Nothing here reaches a vendor.

export const fakeCodes = Object.freeze({
  gh: "WXYZ-9876",
  composioKey: "PENDINGKEY0123456789abcdef",
  qrFirst: "2@firstref,AAAAnoisekey=,BBBBidentity=,CCCCadv=",
  qrSecond: "2@secondref,AAAAnoisekey=,BBBBidentity=,CCCCadv=",
  pair: "ABCD-EFGH",
});

const scripts: Record<string, string> = {
  gh: `#!/bin/sh
echo "$@" >> "$HOME/gh.calls"
case "$1" in
--version) echo "gh version 2.101.0 (2026-09-01)"; exit 0;;
auth)
  case "$2" in
  login)
    if [ -f "$HOME/gh.old" ] && [ "$8" = "--clipboard=false" ]; then echo "unknown flag: --clipboard" >&2; exit 1; fi
    url="https://github.com/login/device"
    [ -f "$HOME/gh.url" ] && url=$(cat "$HOME/gh.url")
    sleep 300 &
    echo $! > "$HOME/gh.child.tmp"
    mv "$HOME/gh.child.tmp" "$HOME/gh.child"
    echo "! First copy your one-time code: ${fakeCodes.gh}" >&2
    echo "Open this URL to continue in your web browser: $url" >&2
    while [ ! -f "$HOME/approve" ]; do sleep 0.05; done
    kill "$(cat "$HOME/gh.child")" 2>/dev/null
    [ -f "$HOME/gh.fail" ] && exit 1
    echo octocat > "$HOME/gh.state"
    echo "✓ Authentication complete." >&2
    exit 0;;
  status)
    if [ -f "$HOME/gh.state" ]; then echo "github.com"; echo "  ✓ Logged in to github.com account $(cat "$HOME/gh.state") (keyring)"; exit 0; fi
    echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1;;
  logout) rm -f "$HOME/gh.state"; echo "✓ Logged out of github.com account octocat" >&2; exit 0;;
  esac;;
esac
exit 1
`,
  composio: `#!/bin/sh
echo "$@" >> "$HOME/composio.calls"
case "$1" in
--version) echo "0.3.1"; exit 0;;
login)
  if [ "$2" = "--no-wait" ]; then
    url="https://dashboard.composio.dev/?cliKey=${fakeCodes.composioKey}"
    [ -f "$HOME/composio.url" ] && url=$(cat "$HOME/composio.url")
    mkdir -p "$HOME/.composio"
    echo "$url" > "$HOME/.composio/pending-login-session.json"
    printf 'Open this URL in your browser to log in:\\n\\n  %s\\n\\nThen run this command to complete login:\\n\\n  composio login --poll\\n' "$url"
    exit 0
  fi
  if [ "$2" = "--poll" ]; then
    while [ ! -f "$HOME/approve" ]; do sleep 0.05; done
    echo op@example.com > "$HOME/.composio/user"
    rm -f "$HOME/.composio/pending-login-session.json"
    echo '{"email":"op@example.com","current_org":{"id":"org_1","name":"First"},"organizations":[]}'
    exit 0
  fi;;
whoami)
  if [ -f "$HOME/.composio/user" ]; then
    org=First; [ -f "$HOME/.composio/org" ] && org=$(cat "$HOME/.composio/org")
    echo "{\\"account_type\\":\\"human\\",\\"email\\":\\"op@example.com\\",\\"current_org_name\\":\\"$org\\",\\"enhanced_controls_enabled\\":null}"
  else echo "You are not logged in yet. Please run \\\`composio login\\\`." >&2; fi
  exit 0;;
orgs)
  if [ "$2" = "list" ]; then
    [ -f "$HOME/.composio/user" ] || { echo "You are not logged in yet." >&2; exit 0; }
    cur=org_1; [ "$(cat "$HOME/.composio/org" 2>/dev/null)" = Second ] && cur=org_2
    if [ $cur = org_1 ]; then a=true; b=false; else a=false; b=true; fi
    echo "[{\\"id\\":\\"org_1\\",\\"name\\":\\"First\\",\\"is_selected_global_org\\":$a},{\\"id\\":\\"org_2\\",\\"name\\":\\"Second\\",\\"is_selected_global_org\\":$b}]"
    exit 0
  fi
  if [ "$2" = "switch" ] && [ "$3" = "--org-id" ]; then
    [ "$4" = org_2 ] && echo Second > "$HOME/.composio/org"
    [ "$4" = org_1 ] && echo First > "$HOME/.composio/org"
    echo "{\\"scope\\":\\"global\\",\\"org_id\\":\\"$4\\"}"
    exit 0
  fi;;
logout) rm -f "$HOME/.composio/user"; exit 0;;
esac
exit 1
`,
  wacli: `#!/bin/sh
echo "$@" >> "$HOME/wacli.calls"
case "$1" in
--version) echo "wacli 0.19.0"; exit 0;;
auth)
  case "$2" in
  status)
    if [ -f "$HOME/.wacli/paired" ]; then echo '{"authenticated":true,"linked_jid":"420123456789@s.whatsapp.net","phone":"420123456789"}'
    else echo '{"authenticated":false}'; fi
    exit 0;;
  logout) rm -f "$HOME/.wacli/paired"; exit 0;;
  esac
  sleep 300 &
  echo $! > "$HOME/wacli.child.tmp"
  mv "$HOME/wacli.child.tmp" "$HOME/wacli.child"
  if [ "$5" = "--phone" ]; then
    echo '{"event":"auth_starting","ts":1}' >&2
    echo '{"event":"pair_code","data":{"phone":"420123456789","code":"${fakeCodes.pair}"},"ts":2}' >&2
  else
    echo '{"event":"auth_starting","ts":1}' >&2
    echo '{"event":"qr_code","data":{"code":"${fakeCodes.qrFirst}"},"ts":2}' >&2
    while [ ! -f "$HOME/rotate" ] && [ ! -f "$HOME/approve" ]; do sleep 0.05; done
    echo '{"event":"qr_code","data":{"code":"${fakeCodes.qrSecond}"},"ts":3}' >&2
  fi
  while [ ! -f "$HOME/approve" ]; do sleep 0.05; done
  mkdir -p "$HOME/.wacli"
  touch "$HOME/.wacli/paired"
  echo '{"event":"connected","ts":4}' >&2
  echo '{"event":"progress","data":{"messages_synced":12},"ts":5}' >&2
  while [ ! -f "$HOME/synced" ]; do sleep 0.05; done
  kill "$(cat "$HOME/wacli.child")" 2>/dev/null
  echo "Authenticated. Messages stored: 12"
  exit 0;;
esac
exit 1
`,
};

/** A private home with a bin directory holding the named fake tools. The
 * PATH is that bin directory and the system directories for `sh`, `sleep`
 * and `cat`. */
export async function fakeLoginTools(
  home: string,
  tools: readonly ("gh" | "composio" | "wacli")[] = ["gh", "composio", "wacli"],
): Promise<string> {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  for (const tool of tools) {
    const script = join(bin, tool);
    await writeFile(script, scripts[tool] as string);
    await chmod(script, 0o755);
  }
  return [bin, "/usr/bin", "/bin"].join(":");
}
