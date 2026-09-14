import type { MessageKey } from "./messages";

export function discoveredApplicationChoices(input: unknown) {
  const choices: Readonly<{
    company: string;
    module: string;
    package: string;
  }>[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input))
    return Object.freeze(choices);
  const value = input as Record<string, unknown>;
  if (
    value.kind !== "applications-observed" ||
    typeof value.company !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.company) ||
    /[\r\n\0]/.test(value.company) ||
    !Array.isArray(value.entries)
  )
    return Object.freeze(choices);
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (
      entry?.kind !== "module-observed" ||
      typeof entry.module !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(entry.module) ||
      /[\r\n\0]/.test(entry.module) ||
      !Array.isArray(entry.apps)
    )
      continue;
    for (const app of entry.apps) {
      if (
        app?.kind !== "runtime-declared" ||
        typeof app.package !== "string" ||
        !/^(?:(?!\.{1,2}\/)[A-Za-z0-9._-]+\/)*package\.json$/.test(
          app.package,
        ) ||
        /[\r\n\0]/.test(app.package)
      )
        continue;
      const key = `${entry.module}/${app.package}`;
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push(
        Object.freeze({
          company: value.company,
          module: entry.module,
          package: app.package,
        }),
      );
    }
  }
  return Object.freeze(choices);
}

export function localApplicationLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function applicationMessage(
  input: unknown,
  localAccess: boolean,
): MessageKey {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return "appFailure";
  const value = input as Record<string, unknown>;
  if (value.error === "applications-unavailable") return "appUnavailable";
  if (value.error === "denied" || value.kind === "denied") return "appDenied";
  switch (value.kind) {
    case "prepared":
      return "appPrepared";
    case "preparation-unavailable":
      return "appPreparationUnavailable";
    case "preparation-preflight-failed":
      return "appPreparationPreflightFailed";
    case "preparation-cleanup-required":
    case "application-cleanup-required":
      return "appPreparationCleanupRequired";
    case "other-app-managed":
      return "appOtherAppManaged";
    case "declaration-changed":
    case "scope-changed":
      return "appDeclarationChanged";
    case "started":
    case "already-managed":
      return "appStarted";
    case "status":
      return value.observedHealthy === true ? "appHealthy" : "appNotReady";
    case "not-ready":
      return "appNotReady";
    case "not-managed":
      return "appNotManaged";
    case "group-stopped":
      return "appStopped";
    case "local-entrypoint":
      return localApplicationLink(value.url)
        ? localAccess
          ? "appLinkReady"
          : "appRemoteLink"
        : "appFailure";
    default:
      return "appFailure";
  }
}
