import { bindings } from "./machine-bindings";

// Every preset on every OS it is offered for. A fixture of its own: a test
// file that imported it from another test file would register that file's
// tests again as its own.
export const journeys = [
  { preset: "local", machine: null, os: "windows" },
  { preset: "local", machine: null, os: "macos" },
  { preset: "hosted-personal", machine: bindings.personal, os: "linux" },
  {
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    os: "linux",
  },
  { preset: "hosted-organization-team", machine: bindings.team, os: "linux" },
  {
    preset: "hosted-organization-steward",
    machine: bindings.automated,
    os: "linux",
  },
] as const;
