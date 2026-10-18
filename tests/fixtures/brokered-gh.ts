import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./owned-files";

// A stand-in for a Team Environment's brokered gh (Lazurio/github-app
// `adapter/brokered-gh.mjs`, which Machines installs as `/usr/local/bin/gh`)
// and for the broker's git credential helper, with the behavior the Platform
// depends on (#488), synthetic names only and no network:
// - `gh auth status --json hosts` answers the App identity
//   (`lazurio-for-github[bot]`); every other `gh auth` command, and `config`,
//   `alias`, `extension`, `search`, fail closed;
// - any other command needs a repository: `GH_REPO`, else the origin of the
//   checkout it runs in (an origin that is not brokered HTTPS, or that names
//   another repository than `GH_REPO`, fails closed); none at all fails with
//   "run gh inside a Team repository checkout or pass --repo";
// - the broker mints only for a granted repository ("refused the request"
//   otherwise), or does not answer at all when it is down;
// - with a token, `gh api repos/<repo>` answers that repository with every
//   `permissions` false, as GitHub answers an App installation's token;
// - the credential helper (git's `credential.helper`, with `useHttpPath`)
//   answers `get` for a granted repository only, by its path.
// Every gh call is recorded as `<cwd>\t<GH_REPO>\t<args>`, every helper
// call as `<action>\t<path>`.

export type BrokeredGh = Readonly<{
  /** The directory holding `gh`, first on the PATH given to the Platform. */
  bin: string;
  /** git's credential helper of the hosting, an absolute path. */
  helper: string;
  /** The username and password the helper gives for `repository`. */
  credential(repository: string): Readonly<{ user: string; password: string }>;
  grant(...repositories: string[]): Promise<void>;
  broker(state: "up" | "down"): Promise<void>;
  calls(): Promise<readonly string[]>;
  helperCalls(): Promise<readonly string[]>;
}>;

const lines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line !== "");

export async function brokeredGh(root: string): Promise<BrokeredGh> {
  const bin = join(root, "brokered-bin");
  const state = join(root, "brokered-state");
  await mkdir(bin, { recursive: true });
  await mkdir(state, { recursive: true });
  const grants = join(state, "grants");
  const brokerState = join(state, "broker");
  const calls = join(state, "calls");
  const helperCalls = join(state, "helper-calls");
  await writeFile(grants, "");
  await writeFile(brokerState, "up\n");
  const fail = (message: string) =>
    `echo 'Brokered gh failed closed: ${message}' >&2; exit 1`;
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
printf '%s\\t%s\\t%s\\n' "$(pwd)" "\${GH_REPO:-}" "$*" >> '${calls}'
case "$1" in
  auth)
    if [ "$*" = "auth status --json hosts" ]; then
      if [ "$(cat '${brokerState}')" = down ]; then
        echo '{"hosts":{}}'
        echo 'Brokered gh authentication proof failed.' >&2
        exit 1
      fi
      echo '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"lazurio-for-github[bot]","tokenSource":"lazurio-broker-live-proof","scopes":"","gitProtocol":"https"}]}}'
      exit 0
    fi
    ${fail("this gh command is disabled in a hosted Team Workspace")} ;;
  alias|config|extension|search)
    ${fail("this gh command is disabled in a hosted Team Workspace")} ;;
esac
repository="\${GH_REPO:-}"
origin=$(git remote get-url origin 2>/dev/null)
if [ -n "$origin" ]; then
  case "$origin" in
    https://github.com/*.git) ;;
    *) ${fail("Hosted Team Workspace origin must use brokered HTTPS")} ;;
  esac
  from_origin=$(printf '%s' "$origin" | sed -e 's#^https://github.com/##' -e 's#[.]git$##')
  if [ -n "$repository" ] && [ "$(printf '%s' "$repository" | tr A-Z a-z)" != "$(printf '%s' "$from_origin" | tr A-Z a-z)" ]; then
    ${fail("gh repository selector does not match the current brokered checkout")}
  fi
  repository="$from_origin"
fi
if [ -z "$repository" ]; then
  ${fail("run gh inside a Team repository checkout or pass --repo OWNER/REPO")}
fi
if [ "$(cat '${brokerState}')" = down ]; then
  ${fail("GitHub token broker is unavailable")}
fi
if ! grep -qixF "$repository" '${grants}'; then
  ${fail("GitHub token broker refused the request")}
fi
# Official gh with a token for exactly "$repository".
if [ "$1" = api ] && [ "$(printf '%s' "$2" | tr A-Z a-z)" = "repos/$(printf '%s' "$repository" | tr A-Z a-z)" ]; then
  printf '{"full_name":"%s","private":true,"archived":false,"owner":{"login":"%s","id":7,"type":"Organization"},"permissions":{"admin":false,"maintain":false,"push":false,"triage":false,"pull":false}}\\n' "$repository" "\${repository%%/*}"
  exit 0
fi
echo '{"message":"Not Found","status":"404"}'
echo 'gh: Not Found (HTTP 404)' >&2
exit 1
`,
  );
  await chmod(gh, 0o755);
  const helper = join(bin, "github-app-credential-helper");
  await writeFile(
    helper,
    `#!/bin/sh
path=
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in
    path=*) path="\${line#path=}" ;;
  esac
done
printf '%s\\t%s\\n' "$1" "$path" >> '${helperCalls}'
[ "$1" = get ] || exit 0
repository="\${path%.git}"
if [ "$(cat '${brokerState}')" = up ] && grep -qixF "$repository" '${grants}'; then
  echo "username=x-access-token"
  echo "password=token-for-$repository"
fi
`,
  );
  await chmod(helper, 0o755);
  return Object.freeze({
    bin,
    helper,
    credential: (repository: string) =>
      Object.freeze({
        user: "x-access-token",
        password: `token-for-${repository}`,
      }),
    grant: (...repositories: string[]) =>
      writeFile(grants, repositories.map((name) => `${name}\n`).join("")),
    broker: (value: "up" | "down") => writeFile(brokerState, `${value}\n`),
    calls: () => lines(calls),
    helperCalls: () => lines(helperCalls),
  });
}
