import { activatableTools } from "./catalog";
import { ghTokenScopes } from "./ssh-key";
import {
  readSignIn,
  signInLabel,
  type ToolProcessResult,
  type ToolSignIn,
} from "./status";
import { ghIdentity, ghIdentityOf } from "./team-github";

/** gh's sign-in, read the way every gh answers it (decision F19, addendum
 * 2026-09-28): first `gh auth status --json hosts`, which gh has since
 * 2.81.0 (cli/cli#11544) and which is the ONLY `gh auth` command the
 * Organization's brokered gh of a Team Environment answers; then, for a gh
 * that does not know `--json` there, the text form of the catalog probe
 * (`gh auth status --hostname github.com`). The JSON form is requested with
 * exactly one field, `hosts`, and never with `--show-token`: gh leaves the
 * token out of it then (`token` is `omitempty` and blanked). Only the state,
 * the login, the kind of identity and the token scopes leave this module;
 * the output itself never does. */
export type GhStatus = Readonly<{
  signIn: ToolSignIn;
  /** The token scopes of the active github.com account, when gh names them. */
  scopes: readonly string[] | undefined;
}>;

export const ghJsonStatusArgs = Object.freeze([
  "auth",
  "status",
  "--json",
  "hosts",
]);

type GhRunner = (
  command: readonly string[],
  timeoutMs: number,
) => Promise<ToolProcessResult>;

const login = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const own = (value: unknown, key: string): unknown =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** What `gh auth status --json hosts` printed, or undefined when it is not
 * that document (a gh without the flag, a refusal, anything else). With
 * `--json` gh always exits 0 and says in `state` whether an entry works. */
export function readGhJsonStatus(stdout: string): GhStatus | undefined {
  let document: unknown;
  try {
    document = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const hosts = own(document, "hosts");
  if (hosts === null || typeof hosts !== "object" || Array.isArray(hosts))
    return undefined;
  const entries = own(hosts, "github.com");
  if (!Array.isArray(entries) || entries.length === 0)
    return { signIn: { state: "signed-out" }, scopes: undefined };
  // The active account; gh lists it first.
  const active =
    entries.find((entry) => own(entry, "active") === true) ?? entries[0];
  const state = own(active, "state");
  if (state === "timeout")
    return { signIn: { state: "unknown" }, scopes: undefined };
  if (state !== "success")
    return { signIn: { state: "signed-out" }, scopes: undefined };
  const label = signInLabel(own(active, "login"));
  const account = label !== undefined && login.test(label) ? label : undefined;
  const source = own(active, "tokenSource");
  const scopes = own(active, "scopes");
  return {
    signIn: {
      state: "signed-in",
      ...(account === undefined ? {} : { account }),
      identity:
        account === undefined
          ? "unknown"
          : ghIdentityOf(account, typeof source === "string" ? source : ""),
    },
    scopes:
      typeof scopes === "string"
        ? scopes
            .split(",")
            .map((scope) => scope.trim())
            .filter((scope) => scope.length > 0)
        : undefined,
  };
}

/** gh's sign-in as described above. Each command is bounded by `timeoutMs`;
 * a timeout or a failure to run is `unknown`. */
export async function ghStatus(
  run: GhRunner,
  gh: string,
  timeoutMs: number,
): Promise<GhStatus> {
  const unknown: GhStatus = { signIn: { state: "unknown" }, scopes: undefined };
  const probe = activatableTools().find((entry) => entry.name === "gh")
    ?.activation.signInProbe;
  if (probe === undefined) return unknown;
  try {
    const json = await run([gh, ...ghJsonStatusArgs], timeoutMs);
    if (json === "timeout") return unknown;
    const read = readGhJsonStatus(json.stdout);
    if (read !== undefined) return read;
    const text = await run([gh, ...probe.argv], timeoutMs);
    if (text === "timeout") return unknown;
    const signIn = readSignIn(probe, text);
    if (signIn.state !== "signed-in") return { signIn, scopes: undefined };
    const output = `${text.stdout}\n${text.stderr}`;
    return {
      signIn: { ...signIn, identity: ghIdentity(output) },
      scopes: ghTokenScopes(output),
    };
  } catch {
    return unknown;
  }
}
