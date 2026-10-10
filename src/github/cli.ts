import { basename } from "node:path";
import { parseArgs } from "node:util";
import { runTool, type ToolRunner } from "../tools/status";
import { resolveInstallBase } from "../update/base";
import { layout } from "../update/layout";
import {
  findLeftovers,
  type Leftover,
  type LeftoverReport,
  leftoverAdvice,
} from "./leftovers";
import { type GithubHttp, githubHttp } from "./oauth";
import {
  configuredOrganization,
  isAppClientId,
  isGithubLogin,
  maxOrganizations,
  owningOrganization,
  type PilotConfig,
  type PilotOrganization,
  type PilotPaths,
  pilotPaths,
  pilotSchema,
  readPilot,
  removePilot,
  sameLogin,
  type WorkEnvironment,
  workEnvironment,
  writePilot,
} from "./pilot";
import {
  abortableSleep,
  type SignInState,
  type SignOutResult,
  signIn,
  signOut,
} from "./sign-in";
import { readStoredSignIn, type StoredSignIn } from "./store";
import {
  inspectWiring,
  unwire,
  type WireRefusal,
  type WiringHealth,
  wire,
} from "./wiring";

/** `lazurio github`: the pilot of the Organization-scoped GitHub sign-in of
 * a Work Environment (decision F46). */
export const githubHelp = `github status [--json]
  The GitHub sign-in pilot of this Environment (decision F46): off or on,
  each Organization's sign-in (as whom, until when; never a token), whether gh
  and Git are wired to it, and the account-wide credentials still left here
  (gh's own sign-in, Git's credential store, token variables, other Git
  helpers; lazurio doctor --sign-in also tries ssh -T git@github.com). Read
  only, no network.
github pilot enable --organization <login> --client-id <Iv…> [--json]
  Turns the pilot on in this Work Environment (preset
  hosted-organization-personal) for its owning Organization: the login of the
  GitHub Organization and the client id of the private sign-in app its Owner
  created (public; no secret exists). Changes nothing for gh or Git yet.
github pilot add|remove --organization <login> [--client-id <Iv…>] [--json]
  Records another Organization's sign-in app (explicit, selected by the
  repository's owner), or forgets one that is not signed in.
github sign-in [--organization <login>] [--json]
  Signs the person in to one Organization's sign-in app (default: the owning
  one): a one-time code to enter at https://github.com/login/device in your
  own browser, then GitHub's checks that the account is the one this
  Environment is assigned to and that the token reaches only that
  Organization. The code is shown only here; the tokens are kept owner-only
  in this Environment and renew themselves without any secret. Ctrl-C cancels.
github sign-out [--organization <login>] [--json]
  Revokes that sign-in at GitHub and removes it here.
github pilot wire [--json]
  gh and Git use the sign-ins: ~/.local/bin/gh becomes a launcher that runs
  the official gh (kept beside it) with the token of the repository owner's
  Organization, and Git asks the pilot's helper for https://github.com with
  git@github.com: remotes rewritten to HTTPS. Needs the owning Organization
  signed in. Run again, it repairs the wiring.
github pilot unwire [--json]
  Gives gh and Git back exactly as they were before wire.
github pilot disable [--json]
  Turns the pilot off; refused while wired or signed in.
github gh <gh arguments>
  The launcher itself (what ~/.local/bin/gh runs once wired).
github credential get|store|erase
  Git's credential helper (Git runs it; not for people).
Exit status: 0 done or unchanged, 2 blocked or usage, 1 failure.`;

export type GithubContext = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  /** This running Lazurio executable (`process.execPath`). */
  executable: string;
  /** The declared operator's Folder of a hosted Machine. */
  hostedFolder?: (() => Promise<string | undefined>) | undefined;
  /** Tests: GitHub's origins and transport. */
  http?: GithubHttp | undefined;
  now?: (() => number) | undefined;
  sleep?:
    | ((milliseconds: number, signal?: AbortSignal) => Promise<void>)
    | undefined;
  /** Runs git and ssh. */
  run?: ToolRunner | undefined;
  /** Where a running sign-in writes its code (default: stdout). */
  write?: ((line: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}>;

export type GithubOutput = Readonly<{
  code: number;
  stdout?: string;
  stderr?: string;
}>;

const usage = `Usage: github status [--json] | github pilot enable --organization <login> --client-id <id> [--json] | github pilot add --organization <login> --client-id <id> [--json] | github pilot remove --organization <login> [--json] | github pilot wire|unwire|disable [--json] | github sign-in|sign-out [--organization <login>] [--json]`;

type EnvironmentRefusal = Extract<WorkEnvironment, { kind: "refused" }>;

const refusalText: Readonly<Record<EnvironmentRefusal["reason"], string>> = {
  "not-hosted":
    "The pilot runs in a Remote Work Environment only; this is not a Remote Environment of this account.",
  "not-work-environment":
    "The pilot runs in an individual Work Environment only (preset hosted-organization-personal). A Team Environment works in GitHub through Lazurio for GitHub; a personal Environment keeps its own sign-in.",
  "environment-unreadable":
    "The kind of this Environment could not be read, so nothing was changed.",
  "subject-unknown":
    "This Environment's handover names no assigned operator (owner.assignment), so no sign-in could be checked against the right person. Refresh the Environment's handover (lazurio machine folder-refresh) or ask its Admin.",
};

const wireText: Readonly<Record<WireRefusal, string>> = {
  "executable-unsupported":
    "Run lazurio github pilot wire from a compiled Lazurio executable whose path has no quote, backslash or control character.",
  "git-missing": "Git is not on PATH.",
  "gh-missing": "The official gh is not installed: lazurio tools install gh",
  "gh-entry-unsupported":
    "~/.local/bin/gh is something the pilot does not replace (not gh's binary or a link to it). Nothing was changed.",
  "gh-not-first":
    "~/.local/bin is not the first place PATH finds gh in, so a launcher there would not be used. Nothing was changed.",
  "git-config-failed":
    "Git's global configuration could not be read or written. Nothing was replaced.",
};

const time = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export function signInLines(state: SignInState): string[] {
  const organization = state.organization;
  switch (state.kind) {
    case "pending":
      return [
        `Sign in to GitHub for ${organization}: open ${state.challenge.url} in your own browser (not this Environment's browser) and enter the code ${state.challenge.code}.`,
        `The code works until ${time(state.expiresAt)}. Waiting… (Ctrl-C cancels)`,
      ];
    case "signed-in":
      return state.already
        ? [
            `Already signed in to GitHub as ${state.account} for ${organization}. To sign in again, sign out first: lazurio github sign-out --organization ${organization}`,
          ]
        : [
            `Signed in to GitHub as ${state.account} for ${organization} only (installation ${state.installationId}). The sign-in renews itself while it is used at least every six months.`,
          ];
    case "expired":
      return [
        `The code expired before it was entered. Start again: lazurio github sign-in --organization ${organization}`,
      ];
    case "cancelled":
      return ["The sign-in was cancelled; nothing was kept."];
    case "failed":
      switch (state.reason) {
        case "device-flow-disabled":
          return [
            `${organization}'s sign-in app does not allow the device flow yet. An Owner of ${organization} ticks "Enable Device Flow" in the app's settings (Organization settings → Developer settings → GitHub Apps → the app → General).`,
          ];
        case "client-id-rejected":
          return [
            `GitHub does not accept the client id recorded for ${organization} as a GitHub App's. Compare it with the app's settings page.`,
          ];
        case "access-denied":
          return [
            "The sign-in was cancelled on GitHub's page; nothing was kept.",
          ];
        case "unreachable":
          return ["GitHub could not be reached; nothing was kept. Try again."];
        case "unexpected-response":
          return [
            "GitHub answered in an unexpected way; nothing was kept. Try again, and report it if it repeats.",
          ];
        case "token-not-expiring":
          return [
            `${organization}'s sign-in app handed out a token that never expires; nothing was kept. An Owner keeps "Expire user authorization tokens" on in the app's settings.`,
          ];
        case "wrong-account":
          return [
            `GitHub signed in ${state.account}, but this Environment is assigned to ${state.expected}; nothing was kept. Sign in again and approve the code as ${state.expected}.`,
          ];
        case "app-not-installed":
          return [
            `${organization} has not installed its sign-in app (or you are not a member who can reach it); nothing was kept. An Owner installs it on ${organization} for all repositories.`,
          ];
        case "app-suspended":
          return [
            `${organization} has suspended its sign-in app; nothing was kept.`,
          ];
        case "installation-unexpected":
          return [
            `The token reaches another installation than ${organization}'s own, so the app is not ${organization}'s private sign-in app; nothing was kept.`,
          ];
        case "busy":
          return [
            `Another sign-in or sign-out of ${organization} is running here. Try again.`,
          ];
      }
  }
}

type OrganizationStatus = Readonly<{
  login: string;
  clientId: string;
  owning: boolean;
  signIn:
    | Readonly<{
        state: "signed-in";
        account: string;
        installationId: number;
        accessTokenExpiresAt: string;
        refreshTokenExpiresAt: string;
        signedInAt: string;
        refreshedAt: string | null;
      }>
    | Readonly<{ state: "signed-out" }>
    | Readonly<{ state: "unreadable" }>;
}>;

const signInStatus = (
  signIn: StoredSignIn | null | "unreadable",
  organization: PilotOrganization,
): OrganizationStatus["signIn"] =>
  signIn === "unreadable"
    ? { state: "unreadable" }
    : signIn === null || signIn.clientId !== organization.clientId
      ? { state: "signed-out" }
      : {
          state: "signed-in",
          account: signIn.account.login,
          installationId: signIn.installationId,
          accessTokenExpiresAt: signIn.accessTokenExpiresAt,
          refreshTokenExpiresAt: signIn.refreshTokenExpiresAt,
          signedInAt: signIn.signedInAt,
          refreshedAt: signIn.refreshedAt,
        };

/** The executable the launcher and the helper run: the install base's
 * selector when this is an installed version (it follows updates), else this
 * very file (a pilot build placed by hand). */
export function wiringExecutable(
  context: Pick<GithubContext, "env" | "platform" | "executable">,
): string {
  const base = resolveInstallBase({
    platform: context.platform,
    env: context.env,
    homedir: context.env.HOME,
  });
  if (base !== undefined) {
    const { versions, selector } = layout(base);
    if (context.executable.startsWith(`${versions}/`)) return selector;
  }
  return context.executable;
}

export type GithubStatus = Readonly<{
  kind: "github-pilot";
  state: "off" | "on" | "unreadable";
  organizations: readonly OrganizationStatus[];
  wiring:
    | Readonly<{ state: "not-wired" }>
    | Readonly<{
        state: "wired" | "broken";
        gh: WiringHealth["gh"];
        git: WiringHealth["git"];
        executable: string;
        official: string;
      }>
    | null;
  leftovers: readonly Leftover[];
  ssh: LeftoverReport["ssh"];
}>;

/** The pilot's state as `github status` and doctor read it. Local: no
 * request to GitHub unless `ssh` asks for the SSH probe. */
export async function pilotStatus(
  context: Pick<GithubContext, "env" | "platform" | "run">,
  paths: PilotPaths,
  ssh = false,
): Promise<GithubStatus> {
  const run = context.run ?? runTool;
  const pilot = await readPilot(paths);
  if (pilot.kind !== "on")
    return Object.freeze({
      kind: "github-pilot",
      state: pilot.kind,
      organizations: [],
      wiring: null,
      leftovers: [],
      ssh: "not-checked",
    });
  const { config } = pilot;
  const organizations: OrganizationStatus[] = [];
  for (const [index, organization] of config.organizations.entries())
    organizations.push({
      login: organization.login,
      clientId: organization.clientId,
      owning: index === 0,
      signIn: signInStatus(
        await readStoredSignIn(paths, organization.login),
        organization,
      ),
    });
  const host = { paths, env: context.env, platform: context.platform, run };
  let wiring: GithubStatus["wiring"] = { state: "not-wired" };
  if (config.wiring !== null) {
    const health = await inspectWiring(host, config.wiring);
    wiring = {
      state: health.gh === "ok" && health.git === "ok" ? "wired" : "broken",
      gh: health.gh,
      git: health.git,
      executable: config.wiring.executable,
      official: config.wiring.gh.real,
    };
  }
  const report = await findLeftovers({ ...host, ssh, wiring: config.wiring });
  return Object.freeze({
    kind: "github-pilot",
    state: "on",
    organizations,
    wiring,
    leftovers: report.leftovers,
    ssh: report.ssh,
  });
}

function statusText(status: GithubStatus): string {
  if (status.state === "off")
    return "GitHub sign-in pilot (decision F46): off. gh and Git work as everywhere.";
  if (status.state === "unreadable")
    return "GitHub sign-in pilot (decision F46): its configuration cannot be read; gh and Git refuse until it is repaired or removed.";
  const lines = ["GitHub sign-in pilot (decision F46): on"];
  for (const organization of status.organizations) {
    const name = `${organization.login}${organization.owning ? " (owning)" : ""}`;
    const signIn = organization.signIn;
    lines.push(
      signIn.state === "signed-in"
        ? `  ${name}: signed in as ${signIn.account}; renews itself (current token until ${time(signIn.accessTokenExpiresAt)}, sign-in valid until ${time(signIn.refreshTokenExpiresAt)} without use)`
        : signIn.state === "unreadable"
          ? `  ${name}: the sign-in cannot be read: lazurio github sign-out --organization ${organization.login}, then sign in again`
          : `  ${name}: not signed in: lazurio github sign-in --organization ${organization.login}`,
    );
  }
  const wiring = status.wiring;
  lines.push(
    wiring === null || wiring.state === "not-wired"
      ? "gh and Git: not wired yet (lazurio github pilot wire)"
      : wiring.state === "wired"
        ? `gh and Git: wired (~/.local/bin/gh runs the official gh at ${wiring.official}; Git uses the pilot's helper for https://github.com and HTTPS for git@github.com: remotes)`
        : `gh and Git: the wiring changed (gh ${wiring.gh}, Git ${wiring.git}); lazurio github pilot wire repairs it`,
  );
  if (status.leftovers.length === 0)
    lines.push(
      `Account-wide credentials left here: none found${status.ssh === "not-checked" ? " (ssh not tried: lazurio doctor --sign-in)" : ""}`,
    );
  else {
    lines.push("Account-wide credentials left here:");
    for (const leftover of status.leftovers)
      lines.push(`  - ${leftoverAdvice(leftover)}`);
  }
  return lines.join("\n");
}

export async function runGithubCommand(
  args: readonly string[],
  context: GithubContext,
): Promise<GithubOutput> {
  let values: {
    json?: boolean | undefined;
    organization?: string | undefined;
    "client-id"?: string | undefined;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        organization: { type: "string" },
        "client-id": { type: "string" },
      },
    });
    ({ values, positionals } = parsed);
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (new Set(names).size !== names.length) throw new Error("duplicate");
  } catch {
    return { code: 2, stderr: `${usage}\n${githubHelp}` };
  }
  const json = values.json === true;
  const command = positionals.join(" ");
  const paths = pilotPaths(context.env);
  if (paths === undefined)
    return {
      code: 1,
      stderr: "The GitHub sign-in pilot needs an absolute HOME.",
    };
  const done = (
    code: number,
    result: Record<string, unknown>,
    text: string,
  ): GithubOutput => ({ code, stdout: json ? JSON.stringify(result) : text });
  const blocked = (
    reason: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) => done(2, { kind: "blocked", reason, ...extra }, text);
  const allowed: Readonly<Record<string, readonly string[]>> = {
    status: [],
    "pilot enable": ["organization", "client-id"],
    "pilot add": ["organization", "client-id"],
    "pilot remove": ["organization"],
    "pilot wire": [],
    "pilot unwire": [],
    "pilot disable": [],
    "sign-in": ["organization"],
    "sign-out": ["organization"],
  };
  const options = Object.hasOwn(allowed, command)
    ? allowed[command]
    : undefined;
  if (
    options === undefined ||
    (values.organization !== undefined && !options.includes("organization")) ||
    (values["client-id"] !== undefined && !options.includes("client-id"))
  )
    return { code: 2, stderr: `${usage}\n${githubHelp}` };

  if (command === "status") {
    const status = await pilotStatus(context, paths);
    return done(0, status, statusText(status));
  }

  const pilot = await readPilot(paths);
  if (pilot.kind === "unreadable")
    return blocked(
      "pilot-unreadable",
      `The pilot's configuration cannot be read (${paths.config}); nothing was changed.`,
    );
  const work = () => workEnvironment(context.hostedFolder);
  const refusedEnvironment = (environment: EnvironmentRefusal) =>
    blocked(environment.reason, refusalText[environment.reason], {
      ...(environment.preset === undefined
        ? {}
        : { preset: environment.preset }),
    });

  if (command === "pilot enable" || command === "pilot add") {
    const login = values.organization;
    const clientId = values["client-id"];
    if (login === undefined || clientId === undefined)
      return { code: 2, stderr: `${usage}\n${githubHelp}` };
    if (!isGithubLogin(login))
      return blocked(
        "organization-invalid",
        "--organization is not a GitHub login.",
      );
    if (!isAppClientId(clientId))
      return blocked(
        "client-id-invalid",
        "--client-id is not a GitHub App's client id (Iv…); the GitHub CLI's or another OAuth App's id is not accepted.",
      );
    if (command === "pilot enable" && pilot.kind === "on")
      return blocked(
        "pilot-on",
        `The pilot is on already (owning Organization ${owningOrganization(pilot.config).login}). Another Organization: lazurio github pilot add.`,
      );
    if (command === "pilot add" && pilot.kind === "off")
      return blocked(
        "pilot-off",
        "The pilot is off: lazurio github pilot enable first.",
      );
    const environment = await work();
    if (environment.kind === "refused") return refusedEnvironment(environment);
    const current = pilot.kind === "on" ? pilot.config : null;
    if (current !== null) {
      if (configuredOrganization(current, login) !== undefined)
        return blocked(
          "organization-configured",
          `${login} is configured already. To change its client id: sign out of it, lazurio github pilot remove, then add it again.`,
        );
      if (current.organizations.some((entry) => entry.clientId === clientId))
        return blocked(
          "client-id-configured",
          "That client id belongs to another configured Organization.",
        );
      if (current.organizations.length >= maxOrganizations)
        return blocked(
          "too-many-organizations",
          `At most ${maxOrganizations} Organizations.`,
        );
    }
    const config: PilotConfig = {
      schema: pilotSchema,
      organizations: [...(current?.organizations ?? []), { login, clientId }],
      wiring: current?.wiring ?? null,
    };
    await writePilot(paths, config);
    return done(
      0,
      { kind: "updated", organization: login, owning: current === null },
      current === null
        ? `The GitHub sign-in pilot is on for ${login} (decision F46). Nothing changed for gh or Git yet.\nNext: lazurio github sign-in --organization ${login}`
        : `${login} added; its repositories use its own sign-in once signed in.\nNext: lazurio github sign-in --organization ${login}`,
    );
  }

  if (pilot.kind === "off")
    return blocked(
      "pilot-off",
      "The GitHub sign-in pilot is off in this Environment (lazurio github pilot enable).",
    );
  const config = pilot.config;
  const http = context.http ?? githubHttp();
  const now = context.now ?? (() => Date.now());
  const named = (): PilotOrganization | GithubOutput => {
    if (values.organization === undefined) return owningOrganization(config);
    return (
      configuredOrganization(config, values.organization) ??
      blocked(
        "organization-unknown",
        `${values.organization} is not configured: ${config.organizations.map((entry) => entry.login).join(", ")}.`,
      )
    );
  };

  if (command === "pilot remove") {
    if (values.organization === undefined)
      return { code: 2, stderr: `${usage}\n${githubHelp}` };
    const organization = named();
    if ("code" in organization) return organization;
    if (sameLogin(organization.login, owningOrganization(config).login))
      return blocked(
        "owning-organization",
        "The owning Organization stays while the pilot is on (lazurio github pilot disable).",
      );
    if ((await readStoredSignIn(paths, organization.login)) !== null)
      return blocked(
        "signed-in",
        `Signed in to ${organization.login}: lazurio github sign-out --organization ${organization.login} first.`,
      );
    await writePilot(paths, {
      ...config,
      organizations: config.organizations.filter(
        (entry) => !sameLogin(entry.login, organization.login),
      ),
    });
    return done(
      0,
      { kind: "updated", organization: organization.login },
      `${organization.login} removed from the pilot.`,
    );
  }

  const run = context.run ?? runTool;
  const host = { paths, env: context.env, platform: context.platform, run };

  if (command === "pilot wire") {
    const environment = await work();
    if (environment.kind === "refused") return refusedEnvironment(environment);
    const owning = owningOrganization(config);
    const signedIn = await readStoredSignIn(paths, owning.login);
    if (
      signedIn === null ||
      signedIn === "unreadable" ||
      signedIn.clientId !== owning.clientId
    )
      return blocked(
        "owning-not-signed-in",
        `Sign in to ${owning.login} first, so gh and Git keep working: lazurio github sign-in --organization ${owning.login}`,
      );
    const executable = wiringExecutable(context);
    if (["bun", "node"].includes(basename(executable)))
      return blocked(
        "executable-unsupported",
        wireText["executable-unsupported"],
      );
    const outcome = await wire(host, {
      executable,
      current: config.wiring,
      now,
      record: (wiring) => writePilot(paths, { ...config, wiring }),
    });
    if (outcome.kind === "blocked")
      return blocked(outcome.reason, wireText[outcome.reason]);
    return done(
      0,
      {
        kind: outcome.repaired ? "repaired" : "wired",
        gh: outcome.wiring.gh.previous,
      },
      [
        outcome.repaired
          ? "gh and Git: the pilot's wiring is in place again."
          : `gh and Git now use the GitHub sign-ins of this Environment: ~/.local/bin/gh runs the official gh (${outcome.wiring.gh.real}) with the token of the repository owner's Organization, and Git uses HTTPS with the pilot's helper for github.com.`,
        "Back as before: lazurio github pilot unwire",
      ].join("\n"),
    );
  }

  if (command === "pilot unwire") {
    if (config.wiring === null)
      return done(
        0,
        { kind: "unchanged" },
        "gh and Git are not wired to the pilot.",
      );
    const outcome = await unwire(host, config.wiring);
    await writePilot(paths, { ...config, wiring: null });
    const ghText = {
      restored: "gh is the official gh again",
      removed: "the launcher is removed; gh is found where it was",
      left: "~/.local/bin/gh had been replaced since and was left as it is",
      "not-restored":
        "the official gh the pilot kept is gone, so the launcher was removed: lazurio tools install gh",
    }[outcome.gh];
    return done(
      outcome.git === "removed" ? 0 : 1,
      outcome,
      `${ghText}; ${outcome.git === "removed" ? "Git's pilot configuration is removed" : `Git's include could not be removed: git config --global --unset-all include.path (${paths.gitInclude})`}.\nThe sign-ins stay; sign out with lazurio github sign-out.`,
    );
  }

  if (command === "pilot disable") {
    if (config.wiring !== null)
      return blocked(
        "wired",
        "gh and Git are wired: lazurio github pilot unwire first.",
      );
    const signedIn: string[] = [];
    for (const organization of config.organizations)
      if ((await readStoredSignIn(paths, organization.login)) !== null)
        signedIn.push(organization.login);
    if (signedIn.length > 0)
      return blocked(
        "signed-in",
        `Still signed in to ${signedIn.join(", ")}: lazurio github sign-out --organization <login> first.`,
        { organizations: signedIn },
      );
    // The state directory keeps its lock files: a lock file is never
    // unlinked (src/platform/flock.ts), and they hold nothing.
    await removePilot(paths);
    return done(0, { kind: "disabled" }, "The GitHub sign-in pilot is off.");
  }

  if (command === "sign-in") {
    const organization = named();
    if ("code" in organization) return organization;
    const environment = await work();
    if (environment.kind === "refused") return refusedEnvironment(environment);
    const write = context.write ?? ((line: string) => console.log(line));
    const final = await signIn({
      paths,
      organization,
      subject: environment.subject,
      http,
      now,
      sleep: context.sleep ?? abortableSleep,
      signal: context.signal,
      emit: (state) => {
        if (json) write(JSON.stringify(state));
        else for (const line of signInLines(state)) write(line);
      },
    });
    const next =
      final.kind === "signed-in" &&
      !final.already &&
      config.wiring === null &&
      sameLogin(organization.login, owningOrganization(config).login)
        ? ["Next: lazurio github pilot wire"]
        : [];
    return done(
      final.kind === "signed-in" ? 0 : 1,
      final,
      [...signInLines(final), ...next].join("\n"),
    );
  }

  // sign-out
  const organization = named();
  if ("code" in organization) return organization;
  const result: SignOutResult = await signOut({ paths, organization, http });
  const text =
    result.kind === "not-signed-in"
      ? `Not signed in to GitHub for ${result.organization} here.`
      : result.kind === "failed"
        ? `Another sign-in or sign-out of ${result.organization} is running here. Try again.`
        : result.revoked
          ? `Signed out of GitHub for ${result.organization} here; GitHub revoked both tokens and tells you so by email.`
          : `Signed out of GitHub for ${result.organization} here (nothing of it is kept). GitHub did not confirm the revocation: if this sign-in must end at GitHub too, revoke the app under GitHub Settings → Applications → Authorized GitHub Apps (that ends its sign-ins in all your Environments).`;
  const wiredOwning =
    result.kind === "signed-out" &&
    config.wiring !== null &&
    sameLogin(organization.login, owningOrganization(config).login);
  return done(
    result.kind === "failed" ? 1 : 0,
    result,
    wiredOwning
      ? `${text}\ngh and Git refuse GitHub requests here until you sign in again: lazurio github sign-in --organization ${organization.login}`
      : text,
  );
}
