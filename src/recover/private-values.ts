import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MachineBinding } from "../folder/machine-binding";
import type { MachineContext } from "../machine/context";
import { readCheckoutJson } from "../providers/owned-json";
import type { PrivateKind, PrivateValue } from "./sanitize";

/** The known private values of this Machine that the sanitizer replaces
 * (docs/recovery.md "What may leave the Machine"). Names only: the Folder
 * contributes the names of the entries under `organizations/` and of the
 * repositories under each Organization's `workspace/`, `productionspace/` and
 * legacy `modules/`, and from each Organization's own declaration its slug,
 * GitHub login and root repository, because the checkout directory need not
 * be the login (`<Owner>_GEN3`). No other content is read. `personalspace/`
 * is not listed.
 */
export type MachineFacts = Readonly<{
  home: string | undefined;
  user: readonly string[];
  hostname: string | undefined;
}>;

// A Folder with more is still sanitized by its first entries and by the gate,
// which refuses what a value it never learned would have caught only by luck.
const maxOrganizations = 256;
const maxRepositories = 2048;
const repositoryAreas = ["workspace", "productionspace", "modules"] as const;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

// `Owner/name` of a repository: both halves are names of something private.
function repositoryValues(value: string): PrivateValue[] {
  const [owner, name] = value.split("/");
  return [
    { kind: "repository", value },
    ...(owner ? [{ kind: "organization" as const, value: owner }] : []),
    ...(name ? [{ kind: "repository" as const, value: name }] : []),
  ];
}

const value = (
  kind: PrivateKind,
  input: string | number | null | undefined,
): PrivateValue[] =>
  input === null || input === undefined ? [] : [{ kind, value: String(input) }];

async function names(directory: string, limit: number): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => !name.startsWith("."))
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

const field = (input: unknown, ...path: readonly string[]) => {
  let value = input;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = (value as Readonly<Record<string, unknown>>)[key];
  }
  return typeof value === "string" ? value : undefined;
};

// `Owner/name` of a locator or of a git remote URL.
const ownerAndName = (input: string | undefined) =>
  /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(input ?? "")?.[1];

/** The names an Organization declares for itself: the canonical
 * `lazurio.organization.json` and the legacy `company.gen3.json`, whichever
 * exist. Read for their names only, so an invalid document still gives what
 * it can and an unreadable one gives nothing. */
async function declaredNames(directory: string): Promise<PrivateValue[]> {
  const read = (name: string) =>
    readCheckoutJson(join(directory, name)).catch(() => null);
  const canonical = await read("lazurio.organization.json");
  const legacy = await read("company.gen3.json");
  return [
    ...value("organization", field(canonical, "organization", "slug")),
    ...value(
      "organization",
      field(canonical, "organization", "forge_binding", "locator"),
    ),
    ...value("organization", field(legacy, "company", "slug")),
    ...value("organization", field(legacy, "company", "github_org")),
    ...[
      field(canonical, "root_repository", "locator"),
      field(legacy, "company", "root_repository"),
      field(legacy, "company", "repository"),
    ].flatMap((locator) => {
      const repository = ownerAndName(locator);
      return repository === undefined ? [] : repositoryValues(repository);
    }),
  ];
}

/** Organization and repository names found in the Folder. */
export async function folderNames(folder: string): Promise<PrivateValue[]> {
  const result: PrivateValue[] = [];
  const organizations = await names(
    join(folder, "organizations"),
    maxOrganizations,
  );
  let repositories = 0;
  for (const organization of organizations) {
    result.push({ kind: "organization", value: organization });
    result.push(
      ...(await declaredNames(join(folder, "organizations", organization))),
    );
    for (const area of repositoryAreas) {
      if (repositories >= maxRepositories) break;
      for (const repository of await names(
        join(folder, "organizations", organization, area),
        maxRepositories - repositories,
      )) {
        result.push({ kind: "repository", value: repository });
        repositories++;
      }
    }
  }
  return result;
}

type Peer = Readonly<{
  name: string;
  organization: string | null;
  ssh: Readonly<{ host: string; user: string | null }> | null;
  https: readonly string[];
}>;

const peerValues = (peers: readonly Peer[] | undefined): PrivateValue[] =>
  (peers ?? []).flatMap((peer) => [
    ...value("peer", peer.name),
    ...value("organization", peer.organization),
    ...value("hostname", peer.ssh?.host),
    ...value("user", peer.ssh?.user),
    ...peer.https.flatMap((host) => value("hostname", host)),
  ]);

/** The handover part a Folder records (decision F16). */
export function bindingValues(binding: MachineBinding | null): PrivateValue[] {
  if (binding === null) return [];
  const { owner } = binding;
  return [
    ...value("machine", binding.name),
    ...(owner.kind === "principal"
      ? [
          ...value("github-login", owner.githubLogin),
          ...value("github-id", owner.githubId),
        ]
      : [
          ...value("organization", owner.organization),
          ...value("team", owner.team),
          ...(owner.assignment !== undefined && owner.assignment.kind !== "team"
            ? [
                ...value("github-login", owner.assignment.githubLogin),
                ...value("github-id", owner.assignment.githubId),
              ]
            : []),
        ]),
    ...value("tailnet-node", binding.network?.headscaleHostname),
    ...value("machine-host", binding.host.id),
    ...peerValues(binding.relationships?.peers),
    ...value(
      "hostname",
      binding.entry === undefined
        ? undefined
        : hostOf(binding.entry.externalOrigin),
    ),
    ...value(
      "hostname",
      binding.entry === undefined
        ? undefined
        : hostOf(binding.entry.authCheckUrl),
    ),
  ];
}

/** The Machine handover itself, read when the Folder copy may be the part
 * that failed. */
export function contextValues(context: MachineContext | null): PrivateValue[] {
  if (context === null) return [];
  const { machine, owner, operator, host, network, installed } = context;
  return [
    ...value("machine", machine.id),
    ...value("machine", machine.name),
    ...(owner.kind === "principal"
      ? [
          ...value("github-login", owner.github_login),
          ...value("github-id", owner.github_id),
        ]
      : [
          ...value("organization", owner.organization),
          ...value("organization", owner.organization_key),
          ...value("team", owner.team),
          ...(owner.assignment?.kind === "operator"
            ? [
                ...value("github-login", owner.assignment.github_login),
                ...value("github-id", owner.assignment.github_id),
              ]
            : []),
        ]),
    ...value("user", operator.os_user),
    ...value("home", operator.home),
    ...value("folder", operator.lazurio_root),
    ...(host.kind === "virtualization-host"
      ? [
          ...value("machine-host", host.machine_id),
          ...value("machine-host", host.provider),
        ]
      : [
          ...value("machine-host", host.estate_id),
          ...value("repository", host.record_path),
        ]),
    ...repositoryValues(host.custody_repository),
    ...value("hostname", hostOf(network?.headscale_server_url ?? "")),
    ...value("tailnet-node", network?.headscale_hostname),
    ...peerValues(context.relationships?.peers),
    ...repositoryValues(installed.machines_release.repository),
  ];
}

/** The account, home and host of this process. */
export function machineValues(facts: MachineFacts): PrivateValue[] {
  const hostname = facts.hostname?.trim();
  return [
    ...value("home", facts.home),
    ...facts.user.flatMap((user) => value("user", user)),
    ...value("host", hostname),
    // The short name a journal prints for a fully qualified one.
    ...value("host", hostname?.split(".")[0]),
  ];
}
