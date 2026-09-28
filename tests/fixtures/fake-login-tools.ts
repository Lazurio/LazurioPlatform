import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Fake gh, composio and wacli that behave like their documented sign-in
// output (decision F19): the device-flow lines of gh without a terminal, the
// `--no-wait` instructions and `--poll` JSON of composio, and wacli's NDJSON
// `--events` on stderr with rotating QR codes. Each waits for the file
// `$HOME/approve` as the operator's action in the browser or on the phone.
// gh also keeps the account's SSH keys (`ssh-key add|delete`, `api
// user/keys`), its token scopes (`--scopes`, `auth refresh`) and answers `api
// meta`; a fake `ssh` greets the account whose key is registered, as GitHub's
// `ssh -T` does. Nothing here reaches a vendor or the network.

export const fakeCodes = Object.freeze({
  gh: "WXYZ-9876",
  composioKey: "PENDINGKEY0123456789abcdef",
  qrFirst: "2@firstref,AAAAnoisekey=,BBBBidentity=,CCCCadv=",
  qrSecond: "2@secondref,AAAAnoisekey=,BBBBidentity=,CCCCadv=",
  pair: "ABCD-EFGH",
});

/** GitHub's published SSH host keys (`https://api.github.com/meta`,
 * `ssh_keys`, read 2026-09-28): public data, the answer of the fake `gh api
 * meta`. */
export const githubHostKeys = Object.freeze([
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
]);

// A step that hangs while `$HOME/hang.<name>` exists: its helper's pid goes
// to `$HOME/hang.pid`, so a test can see that a cancel killed it.
const hang = `hang() {
  if [ -f "$HOME/hang.$1" ]; then
    sleep 300 &
    echo $! > "$HOME/hang.pid.tmp"
    mv "$HOME/hang.pid.tmp" "$HOME/hang.pid"
    wait
  fi
}
`;

const scripts: Record<string, string> = {
  gh: `#!/bin/sh
echo "$@" >> "$HOME/gh.calls"
${hang}
tab=$(printf '\\t')
has() { want="$1"; shift; for a in "$@"; do [ "$a" = "$want" ] && return 0; done; return 1; }
after() { want="$1"; shift; prev=""; for a in "$@"; do if [ "$prev" = "$want" ]; then echo "$a"; return 0; fi; prev="$a"; done; return 1; }
scope() { [ -f "$HOME/gh.scopes" ] && for s in $(cat "$HOME/gh.scopes"); do [ "$s" = "$1" ] && return 0; done; return 1; }
case "$1" in
--version) echo "gh version 2.101.0 (2026-09-01)"; exit 0;;
auth)
  case "$2" in
  login|refresh)
    if [ -f "$HOME/gh.old" ] && has --clipboard=false "$@"; then echo "unknown flag: --clipboard" >&2; exit 1; fi
    if [ "$2" = refresh ] && [ ! -f "$HOME/gh.state" ]; then echo "not logged in to any hosts" >&2; exit 1; fi
    url="https://github.com/login/device"
    [ -f "$HOME/gh.url" ] && url=$(cat "$HOME/gh.url")
    sleep 300 &
    echo $! > "$HOME/gh.child.tmp"
    mv "$HOME/gh.child.tmp" "$HOME/gh.child"
    echo "! First copy your one-time code: ${fakeCodes.gh}" >&2
    echo "Open this URL to continue in your web browser: $url" >&2
    while [ ! -f "$HOME/approve" ]; do sleep 0.05; done
    rm -f "$HOME/approve"
    kill "$(cat "$HOME/gh.child")" 2>/dev/null
    [ -f "$HOME/gh.fail" ] && exit 1
    if [ "$2" = login ]; then echo octocat > "$HOME/gh.state"; scopes="gist read:org repo"; else scopes=$(cat "$HOME/gh.scopes" 2>/dev/null); fi
    extra=$(after --scopes "$@") && scopes="$scopes $extra"
    echo "$scopes" > "$HOME/gh.scopes"
    echo "✓ Authentication complete." >&2
    exit 0;;
  status)
    if [ -f "$HOME/gh.state" ]; then
      echo "github.com"
      echo "  ✓ Logged in to github.com account $(cat "$HOME/gh.state") (keyring)"
      echo "  - Active account: true"
      echo "  - Git operations protocol: ssh"
      echo "  - Token: gho_************************************"
      line=""; for s in $(cat "$HOME/gh.scopes" 2>/dev/null); do line="$line, '$s'"; done
      echo "  - Token scopes: \${line#, }"
      exit 0
    fi
    echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1;;
  logout) rm -f "$HOME/gh.state" "$HOME/gh.scopes"; echo "✓ Logged out of github.com account octocat" >&2; exit 0;;
  esac;;
api)
  case "$2" in
  meta)
    hang api-meta
    if [ -f "$HOME/gh.meta" ]; then cat "$HOME/gh.meta"; else echo '${JSON.stringify(githubHostKeys)}'; fi
    exit 0;;
  "user/keys?per_page=100")
    scope admin:public_key || scope read:public_key || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    printf '['; sep=""
    if [ -f "$HOME/gh.keys" ]; then
      while IFS="$tab" read -r id title key; do printf '%s{"id":%s,"key":"%s","title":"%s"}' "$sep" "$id" "$key" "$title"; sep=","; done < "$HOME/gh.keys"
    fi
    echo ']'; exit 0;;
  esac;;
ssh-key)
  case "$2" in
  add)
    hang ssh-key-add
    scope admin:public_key || scope write:public_key || { printf 'HTTP 404: Not Found (https://api.github.com/user/keys)\\nThis API operation needs the "admin:public_key" scope. To request it, run:  gh auth refresh -h github.com -s admin:public_key\\n' >&2; exit 1; }
    read -r t k rest < "$3"; key="$t $k"
    if [ -f "$HOME/gh.foreign" ] && grep -qxF "$key" "$HOME/gh.foreign"; then printf 'HTTP 422: Validation Failed (https://api.github.com/user/keys)\\nkey is already in use\\n' >&2; exit 1; fi
    if [ -f "$HOME/gh.keys" ] && cut -f3 "$HOME/gh.keys" | grep -qxF "$key"; then echo "✓ Public key already exists on your account" >&2; exit 0; fi
    title=$(after --title "$@")
    id=$(( $(cat "$HOME/gh.nextid" 2>/dev/null || echo 100) + 1 )); echo "$id" > "$HOME/gh.nextid"
    printf '%s\\t%s\\t%s\\n' "$id" "$title" "$key" >> "$HOME/gh.keys"
    echo "✓ Public key added to your account" >&2; exit 0;;
  delete)
    has --yes "$@" || { echo "--yes required when not running interactively" >&2; exit 1; }
    scope admin:public_key || { echo "HTTP 404: Not Found" >&2; exit 1; }
    grep -v "^$3$tab" "$HOME/gh.keys" > "$HOME/gh.keys.tmp"; mv "$HOME/gh.keys.tmp" "$HOME/gh.keys"; exit 0;;
  esac;;
esac
exit 1
`,
  // OpenSSH offers the default keys in the order rsa, ecdsa, ed25519; the
  // first registered one decides which account GitHub greets.
  ssh: `#!/bin/sh
echo "$@" >> "$HOME/ssh.calls"
${hang}
hang ssh
grep -qF "${githubHostKeys[0]?.split(" ")[1]}" "$HOME/.ssh/known_hosts" 2>/dev/null || { echo "Host key verification failed." >&2; exit 255; }
for name in id_rsa id_ecdsa id_ed25519; do
  pub="$HOME/.ssh/$name.pub"
  [ -f "$pub" ] || continue
  read -r t k rest < "$pub"; key="$t $k"
  if [ -f "$HOME/gh.foreign" ] && grep -qxF "$key" "$HOME/gh.foreign"; then echo "Hi someone-else! You've successfully authenticated, but GitHub does not provide shell access." >&2; exit 1; fi
  if [ ! -f "$HOME/ssh.fail" ] && [ -f "$HOME/gh.keys" ] && cut -f3 "$HOME/gh.keys" | grep -qxF "$key"; then echo "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access." >&2; exit 1; fi
done
echo "git@github.com: Permission denied (publickey)." >&2
exit 255
`,
  composio: `#!/bin/sh
echo "$@" >> "$HOME/composio.calls"
case "$1" in
--version) echo "0.3.1"; exit 0;;
login)
  if [ "$2" = "--no-wait" ]; then
    if [ -f "$HOME/composio.hang" ]; then
      echo $$ > "$HOME/composio.first.tmp"
      mv "$HOME/composio.first.tmp" "$HOME/composio.first"
      while :; do sleep 0.05; done
    fi
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

// The system's own ssh-keygen, when this runner has one: it only generates
// and reads files under the temporary home it is given with `-f`, and it
// never uses the network.
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin";
export const realSshKeygen: string | null = Bun.which("ssh-keygen", {
  PATH: systemPath,
});

/** A private home with a bin directory holding the named fake tools, a fake
 * `ssh` and, when the system has one, `ssh-keygen` (the real one behind a
 * wrapper that records its calls and can hang). The PATH is that bin
 * directory and a private directory of linked utilities: no system
 * directory, so a runner's own gh or ssh is never found. */
export async function fakeLoginTools(
  home: string,
  tools: readonly ("gh" | "composio" | "wacli")[] = ["gh", "composio", "wacli"],
): Promise<string> {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  for (const tool of [...tools, "ssh"]) {
    const script = join(bin, tool);
    await writeFile(script, scripts[tool] as string);
    await chmod(script, 0o755);
  }
  if (realSshKeygen !== null) {
    const wrapper = join(bin, "ssh-keygen");
    await writeFile(
      wrapper,
      `#!/bin/sh\necho "$@" >> "$HOME/ssh-keygen.calls"\n${hang}hang ssh-keygen\nexec "${realSshKeygen}" "$@"\n`,
    );
    await chmod(wrapper, 0o755);
  }
  const utilities = join(home, ".local", "utilities");
  await mkdir(utilities, { recursive: true });
  for (const name of [
    "cat",
    "cut",
    "grep",
    "mkdir",
    "mv",
    "rm",
    "sleep",
    "touch",
  ]) {
    const found = Bun.which(name, { PATH: systemPath });
    if (found) await symlink(found, join(utilities, name));
  }
  return [bin, utilities].join(":");
}
