import type { ModuleAnswer, ModuleBlocked } from "../modules/module-operations";
import { withFile } from "./catalog-view";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of a module's lifecycle on its page (launchpad-parity B3,
// slice P5): the status dot, one sentence, the one primary action (Start or
// Stop) and the Open link. The DOM lives in catalog-panel.ts; every value from
// the server is shown as text, and a link only in its exact expected form.

/** The module lifecycle answer or refusal, when the server's body is one. */
export function parseModuleResult(
  input: unknown,
): ModuleAnswer | ModuleBlocked | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const text = (entry: unknown) => typeof entry === "string";
  if (value.kind === "blocked")
    return text(value.operation) &&
      text(value.reason) &&
      (value.file === undefined || text(value.file))
      ? (value as ModuleBlocked)
      : null;
  if (
    value.kind !== "module" ||
    !text(value.operation) ||
    !text(value.organization) ||
    !text(value.module) ||
    !text(value.app) ||
    !text(value.runner) ||
    !text(value.outcome) ||
    !["running", "starting", "stopping", "ended", "stopped"].includes(
      value.state as string,
    ) ||
    typeof value.healthy !== "boolean" ||
    typeof value.survivesLaunchpadRestart !== "boolean" ||
    !(value.runtime === null || typeof value.runtime === "object")
  )
    return null;
  return value as ModuleAnswer;
}

const loopbackHosts = ["127.0.0.1", "[::1]", "localhost"];

/** The Open link exactly as the lifecycle may report it: the root of an https
 * hostname (a hosted module origin) or of a loopback port (a workstation);
 * never credentials, a path, a query or a fragment. Null otherwise. */
export function moduleLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const loopback = loopbackHosts.includes(url.hostname);
    if (
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      (loopback && !url.port) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      value !== url.href
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

const reasonKeys: Readonly<Record<string, MessageKey>> = {
  "toolchain-missing": "moduleReasonToolchain",
  "port-occupied": "moduleReasonPortOccupied",
  "port-managed": "moduleReasonPortOccupied",
  "operation-failed": "moduleReasonFailed",
  "prerequisites-not-ready": "appPrerequisitesNotReady",
  "coordination-busy": "appCoordinationBusy",
  "service-unrecognized": "appServiceUnrecognized",
  "preparation-recovery-required": "appPreparationRecoveryRequired",
  "preparation-cleanup-required": "appPreparationCleanupRequired",
  "application-cleanup-required": "appPreparationCleanupRequired",
  "declaration-changed": "appDeclarationChanged",
  "scope-changed": "appDeclarationChanged",
  denied: "appDenied",
  "hosted-entry-missing": "moduleNoLinkEntry",
  "hosted-app-not-default": "moduleNoLinkApp",
  "no-browser-entrypoint": "moduleNoLinkBrowser",
  "declaration-not-regular": "catalogReasonDeclarationNotRegular",
  "declaration-owner": "catalogReasonDeclarationOwner",
  "declaration-too-large": "catalogReasonDeclarationTooLarge",
  "directory-not-regular": "catalogReasonDirectoryNotRegular",
  "directory-owner": "catalogReasonDirectoryOwner",
  "preparation-owner-invalid": "preparationReasonOwnerInvalid",
  "preparation-script-missing": "preparationReasonScriptMissing",
  "preparation-lockfile-missing": "preparationReasonLockfileMissing",
  "preparation-lockfile-ambiguous": "preparationReasonLockfileAmbiguous",
  "preparation-package-manager-unsupported": "preparationReasonPackageManager",
  "preparation-workspace-unqualified": "preparationReasonWorkspace",
  "preparation-dependency-outside-owner": "preparationReasonDependencyOutside",
  "preparation-toolchain-mismatch": "preparationReasonToolchainMismatch",
  "preparation-install-failed": "preparationReasonInstallFailed",
};

/** A refusal or a missing link in words; an unknown code is named by its
 * code, never guessed. A refused file of the module's checkout is named in
 * the sentence (decision F23). */
export function moduleReasonText(
  reason: string,
  copy: Copy,
  file?: string,
): string {
  const key = Object.hasOwn(reasonKeys, reason)
    ? reasonKeys[reason]
    : undefined;
  return key === undefined
    ? copy.moduleRefused.replace("{reason}", reason)
    : withFile(copy[key], file);
}

// Why a healthy app has no Open link, in words, or by its code.
function noLinkText(reason: string, copy: Copy): string {
  const key = Object.hasOwn(reasonKeys, reason)
    ? reasonKeys[reason]
    : undefined;
  return key === undefined
    ? copy.moduleNoLink.replace("{reason}", reason)
    : copy[key];
}

export type ModuleStatusView = Readonly<{
  /** The dot: `running` green, `starting` amber, `stopped` grey, `failed`
   * red, `unknown` grey without a claim. */
  dot: "running" | "starting" | "stopped" | "failed" | "unknown";
  text: string;
  /** A stable code shown next to the sentence, when there is one. */
  code: string | null;
  /** Who keeps the app running, in words; null when nothing runs. */
  ownership: string | null;
  /** The one primary action. */
  action: "start" | "stop" | null;
  /** The Open link, only while the app reports healthy and has one. */
  link: string | null;
  /** Why a healthy app has no link, in words. */
  noLink: string | null;
}>;

/** The module's status as its page shows it. `null`: not read yet, or the
 * answer could not be read. */
export function moduleStatusView(
  status: ModuleAnswer | ModuleBlocked | null,
  copy: Copy,
): ModuleStatusView {
  const none = { ownership: null, link: null, noLink: null } as const;
  if (status === null)
    return {
      dot: "unknown",
      text: copy.moduleStatusUnknown,
      code: null,
      action: null,
      ...none,
    };
  if (status.kind === "blocked")
    return {
      dot: "unknown",
      text: moduleReasonText(status.reason, copy, status.file),
      code: status.reason,
      action: null,
      ...none,
    };
  const ownership = status.survivesLaunchpadRestart
    ? copy.moduleKeepsRunning
    : copy.moduleSessionBound;
  switch (status.state) {
    case "stopped":
      return {
        dot: "stopped",
        text: copy.moduleStopped,
        code: null,
        action: "start",
        ...none,
      };
    case "ended":
      // Stop confirms the processes are gone and clears the record.
      return {
        dot: "failed",
        text: copy.moduleEnded,
        code: null,
        action: "stop",
        ...none,
        ownership,
      };
    case "stopping":
      return {
        dot: "starting",
        text: copy.moduleStopping,
        code: null,
        action: null,
        ...none,
        ownership,
      };
    default: {
      if (!status.healthy)
        return {
          dot: "starting",
          text:
            status.state === "starting"
              ? copy.moduleStarting
              : copy.moduleNotReady,
          code: null,
          action: "stop",
          ...none,
          ownership,
        };
      const link = moduleLink(status.runtime?.url);
      return {
        dot: "running",
        text: copy.moduleRunning,
        code: null,
        action: "stop",
        ownership,
        link,
        noLink:
          link !== null
            ? null
            : noLinkText(
                status.runtime !== null
                  ? "link-invalid"
                  : (status.runtimeReason ?? "not-reported"),
                copy,
              ),
      };
    }
  }
}

/** The sentence after Start or Stop: what the lifecycle did, or why not. */
export function moduleResultMessage(
  result: ModuleAnswer | ModuleBlocked | null,
  copy: Copy,
): string {
  if (result === null) return copy.appResultUnknown;
  if (result.kind === "blocked")
    return moduleReasonText(result.reason, copy, result.file);
  switch (result.outcome) {
    case "started":
      return result.healthy ? copy.moduleStartedHealthy : copy.moduleStarted;
    case "already-managed":
      return copy.moduleAlreadyRunning;
    case "group-stopped":
      return copy.moduleStoppedDone;
    case "not-managed":
      return copy.moduleNotRunning;
    default:
      return result.outcome;
  }
}

/** Whether the page keeps reading the status after a start: the app is
 * starting or running but not yet healthy. */
export const moduleSettling = (
  status: ModuleAnswer | ModuleBlocked | null,
): boolean =>
  status !== null &&
  status.kind === "module" &&
  (status.state === "starting" ||
    (status.state === "running" && !status.healthy));
