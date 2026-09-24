import {
  type MachineBinding,
  type MachinePeer,
  parseMachineBinding,
} from "./machine-binding";
import { manualEntries } from "./outputs";
import {
  type PresetName,
  parsePresetName,
  presetReference,
  presetVersion,
  validatePresetComposition,
  workspacePreset,
} from "./presets";
import { type FolderProfile, parseFolderProfile } from "./profile";
import type { FolderPreferences } from "./state";
import { stateFields } from "./state-fields";

// Version the template set (AGENTS.md and the manual) independently from
// future persisted preference schemas.
export const instructionTemplateRevision = "base-instructions-4";

// Template revisions are ordered by their number. A Folder rendered by an
// older revision is re-rendered by the next change of the generated Folder
// (a refresh or a profile change) when every file still has its recorded
// digest (decision F14). A revision this product does not know, a newer one
// or one of another form, is never re-rendered or downgraded by it.
function templateRevisionNumber(revision: string): number | null {
  const match = /^base-instructions-([1-9][0-9]{0,8})$/.exec(revision);
  return match === null ? null : Number(match[1]);
}

export function isOlderTemplateRevision(revision: string): boolean {
  const recorded = templateRevisionNumber(revision);
  const current = templateRevisionNumber(instructionTemplateRevision);
  return recorded !== null && current !== null && recorded < current;
}

// What the renderer needs and nothing else: the preset, the immutable Machine
// binding (null on a workstation) and the profile. Validated as one composition.
export type InstructionSource = Readonly<{
  preset: PresetName;
  machine: MachineBinding | null;
  profile: FolderProfile;
}>;

export function parseInstructionSource(input: unknown): InstructionSource {
  const value = stateFields(input, ["preset", "machine", "profile"]);
  const preset = parsePresetName(value.preset);
  const machine = parseMachineBinding(value.machine);
  const profile = parseFolderProfile(value.profile);
  validatePresetComposition(presetReference(preset, machine), machine, profile);
  return Object.freeze({ preset, machine, profile });
}

export function instructionSource(
  preferences: FolderPreferences,
): InstructionSource {
  return Object.freeze({
    preset: preferences.preset.name,
    machine: preferences.machine,
    profile: preferences.profile,
  });
}

export type Text = Readonly<{ cs: string; en: string }>;
const peerKinds: Readonly<Record<MachinePeer["kind"], Text>> = {
  "personal-vm": { cs: "osobní VM", en: "personal VM" },
  "workspace-vm": { cs: "pracovní VM", en: "work VM" },
  "client-device": { cs: "klientské zařízení", en: "client device" },
  "conglomerate-host": { cs: "Conglomerate Host", en: "Conglomerate Host" },
};
const peerZones: Readonly<Record<"personal" | "work", Text>> = {
  personal: { cs: "osobní zóna", en: "personal zone" },
  work: { cs: "pracovní zóna", en: "work zone" },
};
const sshDirections: Readonly<
  Record<NonNullable<MachinePeer["ssh"]>["direction"], Text>
> = {
  outbound: { cs: "SSH odsud na", en: "SSH from here to" },
  inbound: { cs: "SSH sem z", en: "SSH to this Machine from" },
  both: { cs: "SSH oběma směry s", en: "SSH both ways with" },
};

// One line per recorded peer, shared by AGENTS.md and the manual: who the peer
// is, then the SSH edge (TCP 22, relative to this Machine) and the HTTPS
// gateway hostnames this Machine may reach. Exactly what the handover says.
export function peerLine(peer: MachinePeer, locale: "cs" | "en"): string {
  const pick = (text: Text) => text[locale];
  const who = [
    pick(peerKinds[peer.kind]),
    ...(peer.zone === null ? [] : [pick(peerZones[peer.zone])]),
    ...(peer.organization === null
      ? []
      : [
          pick({
            cs: `Organizace \`${peer.organization}\``,
            en: `Organization \`${peer.organization}\``,
          }),
        ]),
  ].join(", ");
  const ssh =
    peer.ssh === null
      ? pick({ cs: "bez SSH", en: "no SSH" })
      : `${pick(sshDirections[peer.ssh.direction])} \`${peer.ssh.host}\`${
          peer.ssh.user === null
            ? ""
            : pick({
                cs: ` jako \`${peer.ssh.user}\``,
                en: ` as \`${peer.ssh.user}\``,
              })
        }`;
  const https =
    peer.https.length === 0
      ? pick({ cs: "bez HTTPS", en: "no HTTPS" })
      : `HTTPS ${peer.https.map((host) => `\`${host}\``).join(", ")}`;
  return `- \`${peer.name}\` (${who}): ${ssh}; ${https}.`;
}

// The assignment line of an Organization work VM: rendered only when the
// handover carries `owner.assignment`, exactly as recorded.
export function assignmentLine(
  machine: MachineBinding,
  locale: "cs" | "en",
): string[] {
  if (machine.owner.kind !== "organization") return [];
  const { assignment } = machine.owner;
  if (assignment === undefined) return [];
  const text: Text =
    assignment.kind === "team"
      ? {
          cs: "- Přiřazení: sdílená Teamem.",
          en: "- Assignment: shared by the Team.",
        }
      : {
          cs: `- Přiřazení: přiřazená Operátorovi \`${assignment.githubLogin}\` (GitHub id ${assignment.githubId}).`,
          en: `- Assignment: assigned to operator \`${assignment.githubLogin}\` (GitHub id ${assignment.githubId}).`,
        };
  return [text[locale]];
}

// One short factual document: context for every agent starting inside the
// Folder, not a manual (that is `manual/`, rendered from the same inputs).
// Everything about the Machine comes from the recorded handover; everything
// about behavior from the preset and the profile.
function machineSection(
  preset: PresetName,
  machine: MachineBinding | null,
  locale: FolderProfile["locale"],
): string[] {
  const pick = (text: Text) => text[locale];
  const lines = [
    pick({ cs: "## Tahle Mašina", en: "## This Machine" }),
    pick({
      cs: `- Preset: \`${preset}\` (verze ${presetVersion}).`,
      en: `- Preset: \`${preset}\` (version ${presetVersion}).`,
    }),
  ];
  if (machine === null)
    return [
      ...lines,
      pick({
        cs: "- Pracovní stanice Principála bez handoveru; Owner i Principál je přihlášený uživatel.",
        en: "- The Principal's own workstation, no handover; the signed-in user is both Owner and Principal.",
      }),
    ];
  // The recorded binding keeps the handover's Team untouched; the Owner line
  // names it only when the preset says the Machine is shared by that Team.
  // Under hosted-organization-personal the Team is the handover value that
  // does not decide assignment (see machineAssignment), so it is not rendered.
  const owner =
    machine.owner.kind === "principal"
      ? pick({
          cs: `- Owner: Principál s GitHub loginem \`${machine.owner.githubLogin}\` (id ${machine.owner.githubId}). Je to jeho jediná osobní hostovaná Mašina.`,
          en: `- Owner: the Principal with GitHub login \`${machine.owner.githubLogin}\` (id ${machine.owner.githubId}). This is their one personal hosted Machine.`,
        })
      : machine.owner.team === null || preset !== "hosted-organization-team"
        ? pick({
            cs: `- Owner: Organizace \`${machine.owner.organization}\`.`,
            en: `- Owner: Organization \`${machine.owner.organization}\`.`,
          })
        : pick({
            cs: `- Owner: Organizace \`${machine.owner.organization}\`, Team \`${machine.owner.team}\`.`,
            en: `- Owner: Organization \`${machine.owner.organization}\`, Team \`${machine.owner.team}\`.`,
          });
  const principal = {
    "hosted-personal": {
      cs: "- Principál: Owner Mašiny. Agenti tu jednají za něj v jeho právech; Buddy je volitelný rezident téže Mašiny.",
      en: "- Principal: the Machine's Owner. Agents here act for them within their rights; a Buddy is an optional resident of this same Machine.",
    },
    "hosted-organization-personal": {
      cs: "- Principál: jediný Operátor, kterému Organizace tuhle pracovní VM přiřadila. Agenti jednají za něj v jeho živých právech.",
      en: "- Principal: the one operator the Organization assigned this work VM to. Agents act for them within their live rights.",
    },
    "hosted-organization-team": {
      cs: "- Principál: Kolega, který se právě připojil. OS účet je sdílený členy Teamu a není osoba; změny se připisují Teamu přes brokerovanou identitu Organizace.",
      en: "- Principal: whichever Team member is connected now. The OS account is shared by the Team and is not a person; changes are attributed to the Team through the brokered Organization identity.",
    },
    local: { cs: "", en: "" },
  }[preset];
  lines.push(
    pick({
      cs: `- Mašina: \`${machine.name}\` (${machine.kind}).`,
      en: `- Machine: \`${machine.name}\` (${machine.kind}).`,
    }),
    owner,
    ...assignmentLine(machine, locale),
    pick(principal),
    machine.network === null
      ? pick({
          cs: "- Tailnet: handover neuvádí identitu v tailnetu.",
          en: "- Tailnet: the handover records no tailnet identity.",
        })
      : pick({
          cs: `- Tailnet: Headscale node \`${machine.network.headscaleHostname}\`.`,
          en: `- Tailnet: Headscale node \`${machine.network.headscaleHostname}\`.`,
        }),
    pick({
      cs: `- Host: ${machine.host.kind} \`${machine.host.id}\`; vyšší doména správy a obnovy než tahle Mašina.`,
      en: `- Host: ${machine.host.kind} \`${machine.host.id}\`; a higher administration and recovery domain than this Machine.`,
    }),
  );
  if (machine.relationships !== undefined)
    lines.push(
      pick({ cs: "### Vztahy k dalším Mašinám", en: "### Related Machines" }),
      pick({
        cs: `Peers v tailnetu podle handoveru (${peerZones[machine.relationships.zone].cs} této Mašiny); vynucuje je Headscale, ne Lazurio.`,
        en: `Tailnet peers as the handover records them (this Machine is in the ${peerZones[machine.relationships.zone].en}); Headscale enforces them, Lazurio does not.`,
      }),
      ...machine.relationships.peers.map((peer) => peerLine(peer, locale)),
    );
  return lines;
}

function boundarySection(
  preset: PresetName,
  pick: (text: Text) => string,
): string[] {
  const { personalspace, providerIdentity } = workspacePreset(preset);
  return [
    pick({ cs: "## Hranice", en: "## Boundaries" }),
    personalspace === "present"
      ? pick({
          cs: "- Personalspace: `personalspace/` je intimní prostor právě jednoho Principála a jeho volitelného Buddyho. Nikdo cizí ho nečte a nikdy se nesdílí.",
          en: "- Personalspace: `personalspace/` is the intimate space of exactly one Principal and their optional Buddy. Nobody else reads it and it is never shared.",
        })
      : pick({
          cs: "- Personalspace: na Mašině vlastněné Organizací nikdy není. Nezakládej ho, nemountuj ho a nekopíruj sem osobní data ani přihlášení.",
          en: "- Personalspace: never present on an Organization-owned Machine. Do not create or mount one and never copy personal data or sign-ins here.",
        }),
    preset === "hosted-personal"
      ? pick({
          cs: "- Organizace: na osobní Mašině nejsou namountovaná žádná repa Organizací. Práce v Organizaci (kód, repozitáře, běhy) probíhá přes SSH na pracovní VM, kterou ti Principál potvrdí jako přiřazenou jemu; repozitáře Organizací sem nikdy neklonuj.",
          en: "- Organizations: no Organization repositories are mounted on a personal Machine. Organization work (code, repositories, runs) happens over SSH on a work VM the Principal confirms is assigned to them; never clone Organization repositories here.",
        })
      : pick({
          cs: "- Organizace: repozitáře žijí v `organizations/<org>/`; každá Organizace je vlastní access hranice a vlastní git repozitář.",
          en: "- Organizations: repositories live under `organizations/<org>/`; each Organization is its own access boundary and its own git repository.",
        }),
    providerIdentity === "own-sign-in"
      ? pick({
          cs: "- Identita: Principálova vlastní přihlášení; GitHub je jediná autorita přístupů.",
          en: "- Identity: the Principal's own sign-ins; GitHub is the only access authority.",
        })
      : pick({
          cs: "- Identita: brokerovaná identita Organizace s krátkodobými tokeny; žádná osobní přihlášení, session ani credentials sem nikdy nepatří.",
          en: "- Identity: the brokered Organization identity with short-lived tokens; no personal sign-ins, sessions or credentials ever belong here.",
        }),
  ];
}

// Two rules every hosted Machine needs before an agent acts: how to reach
// another Machine, and who updates this one. `manual/` has the details.
function hostedLines(pick: (text: Text) => string): string[] {
  return [
    pick({
      cs: "- SSH na jinou Mašinu jen na její tailnet hostname, s pinnutým host klíčem a po ověření aktivního tailnetu, nikdy na holou adresu `100.64.0.x` (`manual/this-machine.md`).",
      en: "- SSH to another Machine only to its tailnet hostname, with a pinned host key and after verifying the active tailnet, never to a bare `100.64.0.x` address (`manual/this-machine.md`).",
    }),
    pick({
      cs: "- Verzi produktu, nástroje i tenhle Folder aktualizuje provozovatel Machines (Machines operator) přes pinnutý release. Nespouštěj tu `lazurio update` ani žádný self-update; co je zastaralé, nahlas Principálovi (`manual/troubleshooting.md`).",
      en: "- The product version, the tools and this Folder are updated by the Machines operator through the pinned release. Do not run `lazurio update` or any self-update here; report what is outdated to the Principal (`manual/troubleshooting.md`).",
    }),
  ];
}

export function renderInstructions(input: unknown): string {
  const { preset, machine, profile } = parseInstructionSource(input);
  const pick = (text: Text) => (profile.locale === "cs" ? text.cs : text.en);
  return [
    "# Lazurio",
    `<!-- ${instructionTemplateRevision}; ${JSON.stringify({ preset, profile })} -->`,
    ...machineSection(preset, machine, profile.locale),
    ...boundarySection(preset, pick),
    pick({ cs: "## Jak se tu pracuje", en: "## How work is done here" }),
    pick({
      cs: "- Komunikuj česky, pokud uživatel nepožádá jinak.",
      en: "- Communicate in English unless the user requests otherwise.",
    }),
    profile.detail === "concise"
      ? pick({
          cs: "- Začni výsledkem a vysvětluj stručně.",
          en: "- Lead with the outcome and explain concisely.",
        })
      : pick({
          cs: "- Začni výsledkem a připoj relevantní technické vysvětlení a důkazy.",
          en: "- Lead with the outcome and include relevant technical explanation and evidence.",
        }),
    profile.coordination === "coordinator"
      ? pick({
          cs: "- Deleguj jen s dostupnými nástroji a v rozsahu zadání; ověř výsledek a práci dokonči. Bez delegace pokračuj lokálně, pokud to lze.",
          en: "- Delegate only with available tools and within task scope; verify results and finish the work. Without delegation, continue locally when possible.",
        })
      : pick({
          cs: "- Pracuj přímo v rozsahu zadání a dostupných nástrojů.",
          en: "- Work directly within task scope and available tools.",
        }),
    pick({
      cs: "- Tvoje práce je Draft ve worktree a pull requestu; Publikace (merge, nasazení, odeslání) patří Principálovi a vyžaduje jeho explicitní pokyn v aktuálním threadu.",
      en: "- Your work is a Draft in a worktree and a pull request; Publication (merge, deploy, send) belongs to the Principal and needs their explicit instruction in the current thread.",
    }),
    pick({
      cs: "- Před prací v Organizaci načti její aktuální AGENTS.md v `organizations/<org>/`; pravidla Organizace platí uvnitř jejího checkoutu a tenhle dokument je nenahrazuje. Z rootu Folderu se v konkrétní Organizaci nepracuje.",
      en: "- Before Organization work, load its current AGENTS.md under `organizations/<org>/`; the Organization's rules apply inside its checkout and this document does not replace them. Never work in a specific Organization from the Folder root.",
    }),
    pick({
      cs: `- Ověř systém provádějící Mašiny (${profile.os}); přístup ${profile.access} nemění identitu ani oprávnění. Pro připojené operace ověř živou identitu a práva; lokální checkout není důkaz oprávnění.`,
      en: `- Verify the execution Machine's OS (${profile.os}); ${profile.access} access changes neither identity nor permissions. Verify live identity and rights for connected operations; a local checkout is not proof of permission.`,
    }),
    pick({
      cs: "- Profil neuděluje přístup, publikační mandát ani oprávnění k práci na pozadí. Nečti cizí Personalspace a nekopíruj přihlašovací údaje.",
      en: "- A profile grants no access, publication mandate or background-work authority. Do not read another Principal's Personalspace or copy credentials.",
    }),
    pick({
      cs: "- Zachovej existující cesty a obsah Organizations a Personalspace. Jazyk profilu nepřejmenovává složky ani nepřekládá uživatelská data.",
      en: "- Preserve existing Organizations and Personalspace paths and content. Profile language neither renames folders nor translates user data.",
    }),
    pick({
      cs: "- Chybějící nástroje, neověřená práva a neznámý stav přiznej; nevymýšlej dostupné schopnosti ani úspěšné dokončení.",
      en: "- Report missing tools, unverified rights and unknown state; do not invent available capabilities or successful completion.",
    }),
    ...(machine === null ? [] : hostedLines(pick)),
    ...manualSection(profile.locale),
    "",
  ].join("\n");
}

// The manual is the complete reference for an agent on this Machine, shipped
// with the product and rendered next to this file in the same locale.
function manualSection(locale: FolderProfile["locale"]): string[] {
  return [
    locale === "cs" ? "## Manuál" : "## Manual",
    locale === "cs"
      ? "Úplný manuál pro agenty na téhle Mašině je v `manual/` (generuje ho produkt, needituj ho):"
      : "The complete agent manual for this Machine is in `manual/` (generated by the product, do not edit):",
    ...manualEntries.map(
      (entry) =>
        `- [${entry.title[locale]}](${entry.path}) — ${entry.summary[locale]}.`,
    ),
  ];
}
