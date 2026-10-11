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
  isAppClientId,
  type PilotApplication,
  type PilotConfig,
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
import {
  lockSignIn,
  readSettledSignIn,
  readStoredSignIn,
  type StoredSignIn,
} from "./store";
import {
  inspectWiring,
  unwire,
  unwireLeftovers,
  type WireRefusal,
  type WiringHealth,
  wire,
} from "./wiring";

/** One shared GitHub App sign-in on the Work Environment (F48). */
export const githubHelp = `github status [--json]
  Shows the shared App sign-in, expiry, reversible wiring and leftover
  credentials. Local observation, never a token or a fresh access inventory.
github pilot enable --client-id <Iv…> [--json]
  Enables the pilot in an assigned individual Work Environment. Use the
  existing shared GitHub App's public client id. The owning Organization
  comes from the handover. Changes nothing for gh or Git yet.
github sign-in [--json]
  Approve a device code in your own browser as this Environment's assigned
  Operator. The token reaches the intersection of your GitHub rights and
  the App's installations and permissions, across Organizations. It is not
  limited to the owning Organization. Anyone sharing the full Environment
  can use that access. No PAT or client secret is needed. Ctrl-C cancels.
github sign-out [--json]
  Removes this Environment's one sign-in and requests token revocation.
github pilot wire [--json]
  Wires official gh and HTTPS Git to the same sign-in. Repairs existing wiring.
github pilot unwire [--json]
  Restores the prior gh entry and Git configuration; keeps the sign-in.
github pilot disable [--json]
  Disables the pilot; refused while wired or signed in.
github gh <gh arguments>
  Runs official gh with the shared App's user token in its child environment.
github credential get|store|erase
  Git's credential helper (Git runs it; not for people).
Exit status: 0 done or unchanged, 2 blocked or usage, 1 failure.`;

export const sharedReach =
  "This shared App sign-in reaches the intersection of your GitHub rights and the App's installations and permissions, across Organizations. It is not limited to the owning Organization. Full Environment sharing includes this access.";

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

const usage =
  "Usage: github status [--json] | github pilot enable --client-id <id> [--json] | github pilot wire|unwire|disable [--json] | github sign-in|sign-out [--json]";

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
        sharedReach,
        `The code works until ${time(state.expiresAt)}. Waiting… (Ctrl-C cancels)`,
      ];
    case "signed-in":
      return state.already
        ? [
            `Already signed in to GitHub as ${state.account} for ${organization}. To sign in again, sign out first: lazurio github sign-out`,
          ]
        : [
            `Signed in to GitHub as ${state.account}; owning installation ${organization} (${state.installationId}). The sign-in renews itself while it is used at least every six months.`,
            sharedReach,
          ];
    case "expired":
      return [
        `The code expired before it was entered. Start again: lazurio github sign-in`,
      ];
    case "cancelled":
      return ["The sign-in was cancelled; nothing was kept."];
    case "failed":
      switch (state.reason) {
        case "device-flow-disabled":
          return [
            `The shared GitHub App does not allow Device Flow yet. An authorized owner of the App enables "Device Flow" in its GitHub settings.`,
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
            "The shared GitHub App handed out a non-expiring token; nothing was kept. Its owner checks the App token-expiry settings.",
          ];
        case "wrong-account":
          return [
            `GitHub signed in ${state.account}, but this Environment is assigned to ${state.expected}; nothing was kept. Sign in again and approve the code as ${state.expected}.`,
          ];
        case "app-not-installed":
          return [
            `The shared App has no owning installation accessible to you in ${organization}; nothing was kept. Ask the Organization Owner to check its installation and your access.`,
          ];
        case "app-suspended":
          return [
            `${organization} has suspended its sign-in app; nothing was kept.`,
          ];
        case "installation-unexpected":
          return [
            "GitHub returned an inconsistent App or owning installation; nothing was kept.",
          ];
        case "state-unreadable":
          return [
            "Existing GitHub credentials do not match this pilot; they were preserved. Resolve their local recovery before retrying.",
          ];
        case "pilot-changed":
          return [
            "The pilot configuration changed before sign-in started. Check lazurio github status and retry.",
          ];
        case "busy":
          return [
            `Another sign-in or sign-out of ${organization} is running here. Try again.`,
          ];
      }
  }
}

type ApplicationStatus = Readonly<{
  login: string;
  clientId: string;
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
  organization: PilotApplication,
): ApplicationStatus["signIn"] =>
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
  application: ApplicationStatus | null;
  reach: "user-and-app-intersection";
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
      application: null,
      reach: "user-and-app-intersection",
      wiring: null,
      leftovers: [],
      ssh: "not-checked",
    });
  const { config } = pilot;
  const organization = config.application;
  const application: ApplicationStatus = {
    login: organization.login,
    clientId: organization.clientId,
    signIn: signInStatus(
      await readStoredSignIn(paths, organization.login),
      organization,
    ),
  };
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
    application,
    reach: "user-and-app-intersection",
    wiring,
    leftovers: report.leftovers,
    ssh: report.ssh,
  });
}

function statusText(status: GithubStatus): string {
  if (status.state === "off")
    return "GitHub sign-in pilot (decision F48): off. gh and Git work as everywhere.";
  if (status.state === "unreadable")
    return "GitHub sign-in pilot (decision F48): its configuration cannot be read; gh and Git refuse until it is repaired or removed.";
  const lines = ["GitHub sign-in pilot (decision F48): on", sharedReach];
  for (const organization of status.application === null
    ? []
    : [status.application]) {
    const name = `${organization.login} (owning installation)`;
    const signIn = organization.signIn;
    lines.push(
      signIn.state === "signed-in"
        ? `  ${name}: signed in as ${signIn.account}; renews itself (current token until ${time(signIn.accessTokenExpiresAt)}, sign-in valid until ${time(signIn.refreshTokenExpiresAt)} without use)`
        : signIn.state === "unreadable"
          ? `  ${name}: the sign-in cannot be read: lazurio github sign-out, then sign in again`
          : `  ${name}: not signed in: lazurio github sign-in`,
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
    "pilot enable": ["client-id"],
    "pilot wire": [],
    "pilot unwire": [],
    "pilot disable": [],
    "sign-in": [],
    "sign-out": [],
  };
  const options = Object.hasOwn(allowed, command)
    ? allowed[command]
    : undefined;
  if (
    options === undefined ||
    (values["client-id"] !== undefined && !options.includes("client-id"))
  )
    return { code: 2, stderr: `${usage}\n${githubHelp}` };

  if (command === "status") {
    const status = await pilotStatus(context, paths);
    return done(0, status, statusText(status));
  }

  const pilot = await readPilot(paths);
  // Giving gh and Git back works in every state: with the record exactly,
  // without one (an interrupted wire, a switch removed by hand, the pilot
  // off) by what the pilot's own marker and include path identify.
  if (command === "pilot unwire") {
    const host = {
      paths,
      env: context.env,
      platform: context.platform,
      run: context.run ?? runTool,
    };
    const wiring = pilot.kind === "on" ? pilot.config.wiring : null;
    if (pilot.kind !== "on" || wiring === null) {
      const left = await unwireLeftovers(host);
      if (left.gh === "none" && left.git === "none")
        return done(
          0,
          { kind: "unchanged" },
          "gh and Git are not wired to the pilot.",
        );
      return done(
        left.gh === "left" || left.git === "failed" ? 1 : 0,
        { kind: "unwired", ...left },
        [
          left.gh === "restored"
            ? "A left-over launcher was replaced by the official gh the pilot kept."
            : left.gh === "left"
              ? "~/.local/bin/gh is a launcher of the pilot, but the official gh it kept is gone: remove ~/.local/bin/gh, then lazurio tools install gh."
              : "",
          left.git === "removed"
            ? "A left-over Git include of the pilot was removed."
            : left.git === "failed"
              ? `Git's include could not be removed: git config --global --unset-all include.path (${paths.gitInclude})`
              : "",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      );
    }
    const { config } = pilot;
    const outcome = await unwire(host, wiring);
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

  if (command === "pilot enable") {
    const clientId = values["client-id"];
    if (clientId === undefined)
      return { code: 2, stderr: `${usage}\n${githubHelp}` };
    if (!isAppClientId(clientId))
      return blocked(
        "client-id-invalid",
        "--client-id must be the public client id of a GitHub App (Iv…).",
      );
    if (pilot.kind === "on")
      return blocked(
        "pilot-on",
        "The pilot already has one App. Unwire, sign out and disable it before changing the configuration.",
      );
    const environment = await work();
    if (environment.kind === "refused") return refusedEnvironment(environment);
    const config: PilotConfig = {
      schema: pilotSchema,
      application: { login: environment.organization, clientId },
      wiring: null,
    };
    await writePilot(paths, config);
    return done(
      0,
      {
        kind: "updated",
        organization: environment.organization,
        reach: "user-and-app-intersection",
      },
      `The shared GitHub App pilot is on for this Environment (owning Organization ${environment.organization}). gh and Git are unchanged.\n${sharedReach}\nNext: lazurio github sign-in`,
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
  const run = context.run ?? runTool;
  const host = { paths, env: context.env, platform: context.platform, run };

  if (command === "pilot wire") {
    const environment = await work();
    if (environment.kind === "refused") return refusedEnvironment(environment);
    const owning = config.application;
    const signedIn = await readStoredSignIn(paths, owning.login);
    if (
      signedIn === null ||
      signedIn === "unreadable" ||
      signedIn.clientId !== owning.clientId ||
      signedIn.account.id !== environment.subject.id ||
      !sameLogin(owning.login, environment.organization)
    )
      return blocked(
        "owning-not-signed-in",
        `Sign in to ${owning.login} first, so gh and Git keep working: lazurio github sign-in`,
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
      return blocked(
        outcome.reason,
        outcome.repair
          ? `${wireText[outcome.reason].replace(/ Nothing was (?:changed|replaced)\.$/, "")} The existing wiring was left as it is; lazurio github status shows what is missing.`
          : wireText[outcome.reason],
        { repair: outcome.repair },
      );
    return done(
      0,
      {
        kind: outcome.repaired ? "repaired" : "wired",
        gh: outcome.wiring.gh.previous,
      },
      [
        outcome.repaired
          ? "gh and Git: the pilot's wiring is in place again."
          : `gh and Git now use this Environment's shared App sign-in through official gh (${outcome.wiring.gh.real}) and HTTPS Git. ${sharedReach}`,
        "Back as before: lazurio github pilot unwire",
      ].join("\n"),
    );
  }

  if (command === "pilot disable") {
    let lock: Awaited<ReturnType<typeof lockSignIn>>;
    try {
      lock = await lockSignIn(paths);
    } catch {
      return blocked(
        "busy",
        "Another GitHub sign-in operation is running here. Try again.",
      );
    }
    try {
      const current = await readPilot(paths);
      if (
        current.kind !== "on" ||
        current.config.application.clientId !== config.application.clientId ||
        !sameLogin(current.config.application.login, config.application.login)
      )
        return blocked(
          "pilot-changed",
          "The pilot configuration changed. Check lazurio github status and retry.",
        );
      if (current.config.wiring !== null)
        return blocked(
          "wired",
          "gh and Git are wired: lazurio github pilot unwire first.",
        );
      const credentials = await readSettledSignIn(
        paths,
        config.application.login,
      );
      if (credentials === "unreadable")
        return blocked(
          "state-unreadable",
          "Existing credentials were preserved. Resolve their local recovery before disabling the pilot.",
        );
      if (credentials !== null)
        return blocked(
          "signed-in",
          "This Environment is still signed in: lazurio github sign-out first.",
        );
      // Keep the kernel lock file: unlinking it would create two lock domains.
      await removePilot(paths);
      return done(0, { kind: "disabled" }, "The GitHub sign-in pilot is off.");
    } finally {
      await lock.release();
    }
  }

  if (command === "sign-in") {
    const organization = config.application;
    const environment = await work();
    if (environment.kind === "refused") return refusedEnvironment(environment);
    if (!sameLogin(organization.login, environment.organization))
      return blocked(
        "owning-organization-changed",
        "The Environment's owning Organization changed. Unwire, sign out and disable this pilot before configuring it again.",
      );
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
      final.kind === "signed-in" && !final.already && config.wiring === null
        ? ["Next: lazurio github pilot wire"]
        : [];
    return done(
      final.kind === "signed-in" ? 0 : 1,
      final,
      [...signInLines(final), ...next].join("\n"),
    );
  }

  // sign-out
  const organization = config.application;
  const result: SignOutResult = await signOut({ paths, organization, http });
  const text =
    result.kind === "not-signed-in"
      ? `Not signed in to GitHub for ${result.organization} here.`
      : result.kind === "failed"
        ? result.reason === "state-unreadable"
          ? "Existing GitHub credentials do not match this pilot; they were preserved. Resolve their local recovery before retrying."
          : `Another sign-in or sign-out of ${result.organization} is running here. Try again.`
        : result.revoked
          ? `Signed out of GitHub for ${result.organization} here; GitHub revoked both tokens and tells you so by email.`
          : `Signed out of GitHub for ${result.organization} here (nothing of it is kept). GitHub did not confirm the revocation: if this sign-in must end at GitHub too, revoke the app under GitHub Settings → Applications → Authorized GitHub Apps (that ends its sign-ins in all your Environments).`;
  const wiredOwning = result.kind === "signed-out" && config.wiring !== null;
  return done(
    result.kind === "failed" ? 1 : 0,
    result,
    wiredOwning
      ? `${text}\ngh and Git refuse GitHub requests here until you sign in again: lazurio github sign-in`
      : text,
  );
}
