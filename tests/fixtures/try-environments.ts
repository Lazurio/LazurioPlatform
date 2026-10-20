import { createHash } from "node:crypto";
import type { MachineBinding } from "../../src/folder/machine-binding";
import { visitorsChapter } from "../../src/folder/manual";
import { type PresetName, presetProfile } from "../../src/folder/presets";
import { renderOutputs } from "../../src/folder/preview";
import {
  instructionTemplateRevision,
  visitorsSection,
} from "../../src/folder/render";
import {
  assignments,
  binding,
  handoverEntry,
  withAudience,
  withBrowser,
  withEnvironmentRelay,
  withSignOut,
} from "./machine-bindings";
import services from "./machine-context-services.json";

// The handovers the Try overlay preset is checked on (plan DEV-6668 slice 4,
// decision F55's addendum of 2026-10-20), shaped as Machines writes them for
// the public reference Organization: try-01, its Team Environment for
// visitors, and four controls that must not change. Example names, invented
// hosts, ids and accounts; the shapes are what matters.

const installed = Object.freeze({
  machines_release: {
    repository: "Example/Machines",
    version: "v1.0.0",
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  deployment_head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  recorded_at: "2026-01-01T00:00:00Z",
});
const operator = Object.freeze({
  os_user: "operator",
  home: "/home/operator",
  lazurio_root: "/home/operator/Lazurio",
});
const host = Object.freeze({
  kind: "virtualization-host",
  machine_id: "example-host",
  custody_repository: "Example/infra",
  provider: "example",
});
const owner = Object.freeze({
  kind: "organization",
  organization: "example",
  organization_key: "Example",
});
const network = (name: string) =>
  Object.freeze({
    headscale_server_url: "https://network.example.invalid",
    headscale_hostname: `example-${name}`,
  });
const vault = (name: string) =>
  Object.freeze({
    server_url: "https://vaultwarden.example.lazurio.io",
    account: `vaultwarden-${name.replace(/[^a-z]/g, "").padEnd(26, "a")}@${name}.example.lazurio.io`,
    name: `Example ${name.replace(/-/g, " ")}`,
  });
const hostOf = (name: string) => `${name}.example.lazurio.io`;

/** try-01 as Machines writes it from the gateway's `public-account`
 * admission: a work VM of the Organization assigned to its Team
 * `workspace`, no tailnet (`network` absent), an entry with the person's
 * sign-out, the Environment browser and `audience: "public"`, no relay to
 * the Dashboard; with `withVault` it also carries the Environment's account
 * in the vault (slice 7 of the plan, not built yet). */
export function tryHandover(
  options: Readonly<{ withVault?: boolean; listenPort?: number }> = {},
) {
  const name = "try-01";
  const entry = withAudience(
    withSignOut(
      withBrowser(
        handoverEntry(hostOf(name), options.listenPort),
        hostOf(name),
      ),
    ),
  );
  return {
    schema_version: "lazurio.machine.v1",
    machine: { id: `example-${name}`, kind: "workspace-vm", name, vmid: 120 },
    owner: { ...owner, team: "workspace", assignment: assignments.team },
    operator,
    host,
    entry,
    ...(options.withVault === true ? { vault: vault(name) } : {}),
    installed,
    account: null,
  };
}

/** The binding of try-01's handover. */
export const tryBinding = (
  options: Readonly<{ withVault?: boolean; listenPort?: number }> = {},
) => binding(tryHandover(options));

/** What try-01's Folder may record: Work, as the live one most likely does
 * (study section 0, finding 8), and Team, which its assignment derives. */
export const tryRecorded: readonly PresetName[] = Object.freeze([
  "hosted-organization-personal",
  "hosted-organization-team",
]);

/** The four combinations of try-01 the contract names: recorded as Work and
 * as Team, without and with `vault`. */
export const tryCases = Object.freeze(
  tryRecorded.flatMap((preset) =>
    [false, true].map((withVault) =>
      Object.freeze({
        name: `try-01 recorded ${preset}${withVault ? " with vault" : ""}`,
        preset,
        withVault,
        machine: tryBinding({ withVault }),
      }),
    ),
  ),
);

/** A lab member's Work Environment (lazurio-bob's shape): assigned to one
 * operator, admitted by the gateway's public entry for members, so no
 * tailnet; an entry with the sign-out and the browser and no audience. */
export const bobHandover = Object.freeze({
  schema_version: "lazurio.machine.v1",
  machine: {
    id: "example-work-bob",
    kind: "workspace-vm",
    name: "work-bob",
    vmid: 121,
  },
  owner: {
    ...owner,
    assignment: {
      kind: "operator",
      github_login: "example-bob",
      github_id: 20002,
    },
  },
  operator,
  host,
  entry: withSignOut(
    withBrowser(handoverEntry(hostOf("work-bob")), hostOf("work-bob")),
  ),
  installed,
  account: null,
});

/** team-01: a Team Environment with the Organization's broker, on the
 * tailnet, with its relay to the Dashboard and its vault. */
export const teamHandover = Object.freeze({
  schema_version: "lazurio.machine.v1",
  machine: {
    id: "example-team-01",
    kind: "workspace-vm",
    name: "team-01",
    vmid: 122,
  },
  owner: { ...owner, team: "workspace", assignment: assignments.team },
  operator,
  host,
  network: network("team-01"),
  entry: withEnvironmentRelay(
    withSignOut(
      withBrowser(handoverEntry(hostOf("team-01")), hostOf("team-01")),
    ),
  ),
  vault: vault("team-01"),
  installed,
  account: null,
});

/** A Steward Environment: the Automated Environment of the Organization's
 * persona with one responsible operator, its bot team in Lazurio MausBot. */
export const stewardHandover = Object.freeze({
  schema_version: "lazurio.machine.v1",
  machine: {
    id: "example-henry-01",
    kind: "workspace-vm",
    name: "henry-01",
    vmid: 123,
  },
  owner: { ...owner, team: "steward", assignment: assignments.automation },
  operator,
  host,
  network: network("henry-01"),
  entry: {
    ...withSignOut(
      withBrowser(handoverEntry(hostOf("henry-01")), hostOf("henry-01")),
    ),
    mausbot: {
      external_origin: `https://mausbot.${hostOf("henry-01")}`,
      listen_port: 4102,
    },
  },
  installed,
  account: null,
});

/** The controls: none of them is public, and nothing of theirs may change. */
export const controls = Object.freeze([
  Object.freeze({
    name: "lazurio-bob's Work Environment",
    preset: "hosted-organization-personal" as const,
    machine: binding(bobHandover),
  }),
  Object.freeze({
    name: "team-01, a Team Environment with the broker",
    preset: "hosted-organization-team" as const,
    machine: binding(teamHandover),
  }),
  Object.freeze({
    name: "services-01, the services Environment of a server",
    preset: "hosted-organization-team" as const,
    machine: binding(services),
  }),
  Object.freeze({
    name: "henry-01, a Steward Environment",
    preset: "hosted-organization-steward" as const,
    machine: binding(stewardHandover),
  }),
]);

/** A generated file with its template revision masked. Every generated file
 * names the revision exactly once, in its header comment (decision F14), and
 * every change of generated bytes moves it to the next number, so a golden
 * of the bytes themselves would change on every Environment whenever any
 * Environment's text changes. Masked, the golden holds every other byte. The
 * revision must occur exactly once, in that comment, so the mask hides
 * nothing else. */
export function maskedRevision(content: string): string {
  const header = `<!-- ${instructionTemplateRevision}; `;
  const lines = content.split("\n");
  const at = lines.findIndex((line) => line.startsWith(header));
  const line = lines[at];
  if (
    line === undefined ||
    !line.endsWith(" -->") ||
    content.split(instructionTemplateRevision).length !== 2
  )
    throw new Error("The template revision is not one header comment");
  lines[at] = `<!-- <template-revision>; ${line.slice(header.length)}`;
  return lines.join("\n");
}

/** Every generated file of a Folder, by the SHA-256 of its bytes with the
 * template revision masked: equal digests are equal bytes but for the
 * revision in the header comment. `transform` sees each file first. */
export function generatedDigests(
  preset: PresetName,
  machine: MachineBinding,
  locale: "cs" | "en",
  transform: (path: string, content: string) => string = (_, content) =>
    content,
) {
  const outputs = renderOutputs({
    preset,
    machine,
    profile: presetProfile(preset, "linux", { locale }),
  });
  return Object.fromEntries(
    Object.entries(outputs).map(([path, content]) => [
      path,
      createHash("sha256")
        .update(maskedRevision(transform(path, content)))
        .digest("hex"),
    ]),
  );
}

/** A `generatedDigests` transform that takes the visitors' section (plan
 * DEV-6668 slice 5) out of AGENTS.md and `manual/this-machine.md`, where it
 * must be exactly once, and leaves every other file as it is: what is left
 * is what the Folder rendered before the section. */
export function withoutVisitors(
  machine: MachineBinding,
  locale: "cs" | "en",
): (path: string, content: string) => string {
  const sections: Readonly<Record<string, string>> = {
    "AGENTS.md": `${visitorsSection(machine, locale).join("\n")}\n`,
    "manual/this-machine.md": `\n${visitorsChapter(machine)
      .map((text) => text[locale])
      .join("\n")}`,
  };
  return (path, content) => {
    const section = sections[path];
    if (section === undefined) return content;
    if (section.trim() === "" || content.split(section).length !== 2)
      throw new Error(`${path} does not hold the visitors' section once`);
    return content.replace(section, "");
  };
}
