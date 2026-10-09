import type { PresetName } from "../folder/presets";
import {
  type ComposioPolicy,
  environmentComposioPolicy,
} from "../integrations/policy";
import type { OrganizationSettingsValues } from "../organizations/organization-settings";
import type { ToolNotes } from "../tools/catalog";

// What an Organization's settings govern on an Environment (root decision
// 0194 point 5, decision F45), as pure rules over the settings the Folder
// records. One rule for every surface: the Folder's instructions, Settings →
// Tools, the Integrace page and `lazurio tools`.

/** Whether an Organization's settings govern an Environment of this preset:
 * every Environment of an Organization (a work, Team or Automated one).
 * A personal Environment and the person's own computer decide alone, and
 * ignore Organization settings. */
export function organizationGoverns(preset: PresetName): boolean {
  return preset !== "local" && preset !== "hosted-personal";
}

/** The catalog tools the settings do not allow on this Environment: Composio
 * where the Organization does not allow connecting through it (root
 * decision 0162, addendum of 2026-10-09, point 4). */
export function forbiddenTools(
  settings: OrganizationSettingsValues,
): readonly string[] {
  return settings.integrations?.composio?.allowed === false ? ["composio"] : [];
}

/** What the settings say about one tool, when they say anything. */
export function toolGovernance(
  name: string,
  settings: OrganizationSettingsValues,
): Readonly<{ allowed: boolean }> | null {
  if (name !== "composio") return null;
  const allowed = settings.integrations?.composio?.allowed;
  return allowed === undefined ? null : Object.freeze({ allowed });
}

/** The tools agents are told to use: the person's own selection without the
 * ones the settings do not allow. The selection itself stays as it is, so
 * the Organization allowing a tool again brings the person's choice back. */
export function effectiveTools(
  tools: readonly string[],
  settings: OrganizationSettingsValues,
): readonly string[] {
  const forbidden = forbiddenTools(settings);
  return forbidden.length === 0
    ? tools
    : Object.freeze(tools.filter((tool) => !forbidden.includes(tool)));
}

/** The person's notes on the tools agents are told to use. */
export function effectiveNotes(
  notes: ToolNotes,
  settings: OrganizationSettingsValues,
): ToolNotes {
  const forbidden = forbiddenTools(settings);
  return forbidden.length === 0
    ? notes
    : Object.freeze(
        Object.fromEntries(
          Object.entries(notes).filter(([name]) => !forbidden.includes(name)),
        ),
      );
}

/** The one representation of a settings section: keys sorted at every
 * level and groups that govern nothing left out, so that two equal sections
 * are equal bytes. */
export function canonicalSettings(
  settings: OrganizationSettingsValues,
): OrganizationSettingsValues {
  const canonical = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return value;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = canonical((value as Record<string, unknown>)[key]);
      if (
        typeof member === "object" &&
        member !== null &&
        !Array.isArray(member) &&
        Object.keys(member).length === 0
      )
        continue;
      result[key] = member;
    }
    return Object.freeze(result);
  };
  return canonical(settings) as OrganizationSettingsValues;
}

/** Whether this Environment may connect apps through Composio, and who
 * decided: the Organization where its recorded settings say so, otherwise
 * the Environment (allowed, as since decision F18). */
export function composioPolicyOf(
  preset: PresetName,
  settings: OrganizationSettingsValues,
): ComposioPolicy {
  if (!organizationGoverns(preset)) return environmentComposioPolicy;
  const allowed = settings.integrations?.composio?.allowed;
  return allowed === undefined
    ? environmentComposioPolicy
    : Object.freeze({ allowed, source: "organization" as const });
}
