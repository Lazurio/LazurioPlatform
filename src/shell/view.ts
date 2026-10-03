import {
  currentEnvironment,
  type Shell,
  type ShellEnvironment,
  type ShellEnvironmentKind,
  type ShellOrganization,
} from "./contract";
import { fillShell, type ShellCopy } from "./messages";

// Pure presentation of the shell document for the rail and the app switch
// (decision F36, the target shell of docs/launchpad-development.md): what
// each element shows, in which order, linked where. The elements in
// elements.ts only draw it.

/** At most this many Environments of one folder show before "+N". */
export const folderLimit = 6;

export type RailMark =
  | Readonly<{ kind: "initials"; text: string }>
  | Readonly<{
      kind: "icon";
      icon: "laptop" | "user" | "users" | "bot";
    }>;

export type RailItem = Readonly<{
  id: string;
  /** The first line of the label. */
  label: string;
  /** The second line: Organization · kind (· you are here). */
  sub: string;
  href: string;
  active: boolean;
  mark: RailMark;
  /** The fill of the active item: the Organization's accent, or null for
   * the design system's ink (personal) or accent (Organization). */
  accent: string | null;
}>;

export type RailFolder = Readonly<{
  organization: ShellOrganization;
  /** The avatar, or the initials when there is none. */
  initials: string;
  items: readonly RailItem[];
  /** How many are folded behind "+N" (0 when all show). */
  hidden: number;
  /** Whether "less" folds them again. */
  expanded: boolean;
  hasActive: boolean;
}>;

export type RailModel = Readonly<{
  personal: readonly RailItem[];
  folders: readonly RailFolder[];
}>;

const kindIcons: Readonly<
  Record<ShellEnvironmentKind, "laptop" | "user" | "users" | "bot">
> = {
  personal: "user",
  work: "user",
  team: "users",
  automated: "bot",
  workstation: "laptop",
};

/** Up to two letters of a name: the first letters of its first two words,
 * else its first two letters. */
export function initialsOf(name: string): string {
  const words = name
    .split(/[\s_.-]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters =
    words.length >= 2
      ? [words[0]?.[0], words[1]?.[0]]
      : [...(words[0] ?? name)].slice(0, 2);
  return letters
    .filter((letter): letter is string => letter !== undefined)
    .join("")
    .toLocaleUpperCase();
}

/** The name an Environment is shown under. */
export function environmentLabel(
  environment: ShellEnvironment,
  copy: ShellCopy,
): string {
  return environment.label ?? copy.thisComputer;
}

function item(
  shell: Shell,
  environment: ShellEnvironment,
  copy: ShellCopy,
  accent: string | null,
): RailItem {
  const active = environment.id === shell.current;
  const where = environment.organizations
    .map(
      (slug) =>
        shell.organizations.find(
          (entry) => entry.slug.toLowerCase() === slug.toLowerCase(),
        )?.name ?? slug,
    )
    .join(", ");
  const personal = environment.kind === "personal";
  const mark: RailMark =
    personal && shell.operator.initials !== null
      ? { kind: "initials", text: shell.operator.initials }
      : { kind: "icon", icon: kindIcons[environment.kind] };
  return Object.freeze({
    id: environment.id,
    label: environmentLabel(environment, copy),
    sub: [
      personal && shell.operator.login !== null
        ? `@${shell.operator.login}`
        : where,
      copy.kinds[environment.kind],
      active ? copy.current : "",
    ]
      .filter((part) => part !== "")
      .join(" · "),
    href: environment.apps.apps,
    active,
    mark,
    accent,
  });
}

/** The rail: first the personal Environments (personal Remote Environments
 * and workstations, in document order), then one folder per Organization
 * with the Environments that belong to it, in the order of
 * `organizations`. A workstation holding several Organizations is personal:
 * it is the person's own computer. A folder shows the first `folderLimit`
 * Environments, plus the active one if it is further down; `expanded` lists
 * the folders the person unfolded. An Organization without an Environment
 * in the document has no folder. */
export function railModel(
  shell: Shell,
  copy: ShellCopy,
  expanded: ReadonlySet<string> = new Set(),
): RailModel {
  const personal = shell.environments
    .filter(
      (environment) =>
        environment.kind === "personal" ||
        environment.kind === "workstation" ||
        environment.organizations.length === 0,
    )
    .map((environment) => item(shell, environment, copy, null));
  const folders = shell.organizations.flatMap((organization): RailFolder[] => {
    const own = shell.environments.filter(
      (environment) =>
        environment.kind !== "personal" &&
        environment.kind !== "workstation" &&
        environment.organizations[0]?.toLowerCase() ===
          organization.slug.toLowerCase(),
    );
    if (own.length === 0) return [];
    const items = own.map((environment) =>
      item(shell, environment, copy, organization.accent),
    );
    const open = expanded.has(organization.slug);
    const visible = open
      ? items
      : items.filter((entry, index) => index < folderLimit || entry.active);
    return [
      Object.freeze({
        organization,
        initials: initialsOf(organization.name),
        items: Object.freeze(visible),
        hidden: items.length - visible.length,
        expanded: open && items.length > folderLimit,
        hasActive: items.some((entry) => entry.active),
      }),
    ];
  });
  return Object.freeze({
    personal: Object.freeze(personal),
    folders: Object.freeze(folders),
  });
}

export const shellApps = ["chat", "apps", "automate"] as const;
export type ShellApp = (typeof shellApps)[number];

export type SwitchTab = Readonly<{
  app: ShellApp;
  label: string;
  /** Null where the Environment has no such app: the tab is shown
   * disabled with `missing` as its title. */
  href: string | null;
  missing: string | null;
  active: boolean;
}>;

/** The switch Chat · Apps · Automate of the current Environment, `active`
 * being the app the switch sits in (none inside Settings). */
export function switchTabs(
  shell: Shell,
  copy: ShellCopy,
  active: ShellApp | null,
): readonly SwitchTab[] {
  const { apps } = currentEnvironment(shell);
  const href: Readonly<Record<ShellApp, string | null>> = {
    chat: apps.chat,
    apps: apps.apps,
    automate: apps.automate,
  };
  const missing: Readonly<Record<ShellApp, string | null>> = {
    chat: copy.chatMissing,
    apps: null,
    automate: copy.automateMissing,
  };
  return shellApps.map((app) =>
    Object.freeze({
      app,
      label: copy[app],
      href: href[app],
      missing: href[app] === null ? missing[app] : null,
      active: app === active,
    }),
  );
}

/** The jump list of ⌘⇧E: every Environment of the document whose label,
 * Organization or kind contains the query, the current one first. */
export function jumpList(
  shell: Shell,
  copy: ShellCopy,
  query: string,
): readonly RailItem[] {
  const model = railModel(
    shell,
    copy,
    new Set(shell.organizations.map((organization) => organization.slug)),
  );
  const all = [
    ...model.personal,
    ...model.folders.flatMap((folder) => folder.items),
  ];
  const needle = query.trim().toLocaleLowerCase();
  return all
    .filter(
      (entry) =>
        needle === "" ||
        `${entry.label} ${entry.sub}`.toLocaleLowerCase().includes(needle),
    )
    .sort((left, right) => Number(right.active) - Number(left.active));
}

/** The "+N" button's words. */
export const moreText = (
  copy: ShellCopy,
  folder: RailFolder,
): Readonly<{ text: string; label: string }> =>
  folder.expanded
    ? {
        text: copy.less,
        label: fillShell(copy.lessNamed, { name: folder.organization.name }),
      }
    : {
        text: fillShell(copy.more, { count: folder.hidden }),
        label: fillShell(copy.moreNamed, {
          count: folder.hidden,
          name: folder.organization.name,
        }),
      };
