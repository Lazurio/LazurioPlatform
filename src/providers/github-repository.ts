import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { object, text } from "../modules/manifest";
import { parseProcessLaunch } from "../modules/process-launch";

const run = promisify(execFile);
const query =
  "query($owner:String!,$name:String!){viewer{id login} repository(owner:$owner,name:$name){id nameWithOwner viewerPermission isArchived isDisabled}}";
function request(input: unknown) {
  const value = object(input, ["owner", "repository", "expectedViewerId"]);
  return Object.freeze({
    owner: text(value.owner, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    repository: text(value.repository, /^[A-Za-z0-9_.-]{1,100}$/),
    expectedViewerId: text(value.expectedViewerId, /^[A-Za-z0-9_+=/-]{1,256}$/),
  });
}

// One provider response, not a role grant, local custody check or cached ACL.
export function parseGitHubRepositoryObservation(
  input: unknown,
  expected: unknown,
) {
  const target = request(expected);
  const unavailable = () => Object.freeze({ kind: "unavailable" as const });
  try {
    // GraphQL errors/partial results never become access evidence.
    const envelope = object(input, ["data"]);
    const data = object(envelope.data, ["viewer", "repository"]);
    const viewer = object(data.viewer, ["id", "login"]);
    const id = text(viewer.id, /^[A-Za-z0-9_+=/-]{1,256}$/);
    const login = text(viewer.login, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
    if (id !== target.expectedViewerId)
      return Object.freeze({ kind: "identity-mismatch" as const });
    if (data.repository === null)
      return Object.freeze({ kind: "repository-unavailable" as const });
    const repo = object(data.repository, [
      "id",
      "nameWithOwner",
      "viewerPermission",
      "isArchived",
      "isDisabled",
    ]);
    const repositoryId = text(repo.id, /^[A-Za-z0-9_+=/-]{1,256}$/);
    const name = text(repo.nameWithOwner, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
    if (
      name.toLowerCase() !==
      `${target.owner}/${target.repository}`.toLowerCase()
    )
      return Object.freeze({ kind: "repository-mismatch" as const });
    const permission =
      repo.viewerPermission === null
        ? null
        : text(repo.viewerPermission, /^(READ|TRIAGE|WRITE|MAINTAIN|ADMIN)$/);
    if (
      typeof repo.isArchived !== "boolean" ||
      typeof repo.isDisabled !== "boolean"
    )
      return unavailable();
    return Object.freeze({
      kind: "observed" as const,
      viewer: Object.freeze({ id, login }),
      repository: Object.freeze({
        id: repositoryId,
        name,
        permission,
        archived: repo.isArchived,
        disabled: repo.isDisabled,
      }),
    });
  } catch {
    return unavailable();
  }
}

export async function readGitHubRepositoryAccess(
  input: unknown,
  context: {
    executable: string;
    cwd: string;
    env: unknown;
    timeoutMs?: number;
  },
) {
  const target = request(input);
  const timeout = context.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
    throw new Error("Bounded provider timeout required");
  // The caller selects a verified gh executable and existing credential context.
  // No PATH discovery, token extraction, auth login/switch, or new secret store.
  const selected = parseProcessLaunch({
    executable: context.executable,
    cwd: context.cwd,
    args: [],
    env: context.env,
  });
  const env: Record<string, string> = Object.create(null);
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "TMPDIR",
    "TEMP",
    "TMP",
  ]) {
    if (Object.hasOwn(selected.env, key))
      env[key] = selected.env[key] as string;
  }
  Object.assign(env, {
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    LC_ALL: "C",
  });
  const startedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await run(
      selected.executable,
      [
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "--raw-field",
        `query=${query}`,
        "--raw-field",
        `owner=${target.owner}`,
        "--raw-field",
        `name=${target.repository}`,
      ],
      {
        cwd: selected.cwd,
        env,
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (stderr.trim()) return Object.freeze({ kind: "unavailable" as const });
    const result = parseGitHubRepositoryObservation(JSON.parse(stdout), target);
    return Object.freeze({
      ...result,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  } catch {
    // Do not return provider stderr, credential-bearing args/env or raw errors.
    return Object.freeze({ kind: "unavailable" as const });
  }
}
