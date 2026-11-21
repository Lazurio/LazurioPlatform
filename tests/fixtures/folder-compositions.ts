import { presetProfile } from "../../src/folder/presets";
import { activatableTools } from "../../src/tools/catalog";
import { bindings, personalWithEntry } from "./machine-bindings";
import { tryBinding } from "./try-environments";

// The compositions the generated Folder is pinned and measured on: the
// template-revision pin and the AGENTS.md budget tests render the same set.

const optionalTools = activatableTools()
  .filter((entry) => entry.activation.tier !== "required")
  .map((entry) => entry.name)
  .sort();

// Every preset on every OS it is offered for, with and without recorded
// peers and with a hosted entry, in both languages; once with the preset's
// defaults and nothing enabled, once with the other communication axes, every
// optional catalog tool and a note.
export const environments = [
  { preset: "local", machine: null, os: "windows" },
  { preset: "local", machine: null, os: "macos" },
  { preset: "hosted-personal", machine: bindings.personal, os: "linux" },
  { preset: "hosted-personal", machine: bindings.personalRelated, os: "linux" },
  // With an assigned Work Environment (root decision 0192, addendum of
  // 2026-10-26; plan DEV-6676 P2): the personal Folder's section that lists
  // its alias renders only there.
  {
    preset: "hosted-personal",
    machine: bindings.personalAssigned,
    os: "linux",
  },
  {
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    os: "linux",
  },
  {
    preset: "hosted-organization-personal",
    machine: bindings.related,
    os: "linux",
  },
  { preset: "hosted-organization-team", machine: bindings.team, os: "linux" },
  {
    preset: "hosted-organization-steward",
    machine: bindings.automated,
    os: "linux",
  },
  // With a hosted entry: the Files link and the Launchpad routing of sign-ins
  // and connections render only there (decisions F35, F19 addendum 2026-10-04).
  { preset: "hosted-personal", machine: bindings.personalEntry, os: "linux" },
  {
    preset: "hosted-organization-personal",
    machine: bindings.organizationEntry,
    os: "linux",
  },
  {
    preset: "hosted-organization-team",
    machine: bindings.teamEntry,
    os: "linux",
  },
  {
    preset: "hosted-organization-steward",
    machine: bindings.automatedEntry,
    os: "linux",
  },
  // With the Environment browser's view (root decision 0191, F38): its
  // section renders only there, with the Team line on a Team Environment.
  {
    preset: "hosted-organization-personal",
    machine: bindings.organizationBrowser,
    os: "linux",
  },
  {
    preset: "hosted-organization-team",
    machine: bindings.teamBrowser,
    os: "linux",
  },
  { preset: "hosted-personal", machine: bindings.personalBrowser, os: "linux" },
  // With Buddy GEN3's origin (decision F60): no line names it any more.
  {
    preset: "hosted-personal",
    machine: personalWithEntry(20000, true, true, true),
    os: "linux",
  },
  // Moved to Buddy GEN4 (plan LZD-0033): the lines on his window and on
  // `~/Buddy` render only there.
  {
    preset: "hosted-personal",
    machine: personalWithEntry(20000, true, true, "gen4"),
    os: "linux",
  },
  // A public Environment (root decision 0204, F55's addendum of 2026-10-17):
  // no GitHub identity, on a Team Environment and on one of one operator.
  {
    preset: "hosted-organization-team",
    machine: bindings.teamPublic,
    os: "linux",
  },
  {
    preset: "hosted-organization-personal",
    machine: bindings.organizationPublic,
    os: "linux",
  },
  // try-01, the public Environment for visitors (plan DEV-6668 slice 5,
  // F55's addendum of 2026-10-20 (3)): the visitors' section with the
  // Environment browser, its Folder recorded as Team and as Work.
  { preset: "hosted-organization-team", machine: tryBinding(), os: "linux" },
  {
    preset: "hosted-organization-personal",
    machine: tryBinding(),
    os: "linux",
  },
  // With the Organization's settings (root decision 0194, F45): a tool it does
  // not allow is left out, with the line that says why, on a work Environment
  // that has the Environment's relay and on a Team Environment.
  {
    preset: "hosted-organization-personal",
    machine: bindings.organizationRelay,
    os: "linux",
    settings: { integrations: { composio: { allowed: false } } },
  },
  {
    preset: "hosted-organization-team",
    machine: bindings.teamEntry,
    os: "linux",
    settings: { integrations: { composio: { allowed: false } } },
  },
  // With the Microsoft 365 company app recorded (F42 addendum (c) of
  // 2026-10-14): identifiers only, a fictional tenant.
  {
    preset: "hosted-organization-personal",
    machine: bindings.organizationRelay,
    os: "linux",
    settings: {
      integrations: {
        microsoft365: {
          tenant_id: "00000000-0000-4000-8000-0000000000aa",
          client_id: "00000000-0000-4000-8000-0000000000bb",
          apps: ["outlook"],
          callbacks: [],
        },
      },
    },
  },
  // ChatGPT's apps (decision F42's addendum of 2026-10-27): allowed by the
  // Organization, and turned on by the person on their own Environment and
  // on their own computer; every other composition has them off.
  {
    preset: "hosted-organization-personal",
    machine: bindings.organizationEntry,
    os: "linux",
    settings: { integrations: { chatgpt_apps: { allowed: true } } },
  },
  {
    preset: "hosted-personal",
    machine: bindings.personalEntry,
    os: "linux",
    chatgptAppsAllowed: true,
  },
  { preset: "local", machine: null, os: "macos", chatgptAppsAllowed: true },
] as const;

export function compositions() {
  const all = [];
  for (const environment of environments)
    for (const locale of ["cs", "en"] as const) {
      const settings = {
        ...("settings" in environment
          ? { organizationSettings: environment.settings }
          : {}),
        ...("chatgptAppsAllowed" in environment
          ? { chatgptAppsAllowed: environment.chatgptAppsAllowed }
          : {}),
      };
      all.push({
        preset: environment.preset,
        machine: environment.machine,
        profile: presetProfile(environment.preset, environment.os, { locale }),
        tools: [],
        toolNotes: {},
        ...settings,
      });
      all.push({
        preset: environment.preset,
        machine: environment.machine,
        profile: presetProfile(environment.preset, environment.os, {
          locale,
          detail: "technical",
          coordination: "coordinator",
        }),
        tools: optionalTools,
        toolNotes: { [optionalTools[0] ?? "gh"]: "Use it for the example." },
        ...settings,
      });
    }
  return all;
}
