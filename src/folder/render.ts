import {
  type MachineBinding,
  type MachineRelationship,
  parseMachineBinding,
} from "./machine-binding";
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

// Version the template independently from future persisted preference schemas.
export const instructionTemplateRevision = "base-instructions-2";

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

type Text = Readonly<{ cs: string; en: string }>;
const relationshipKinds: Readonly<Record<MachineRelationship["kind"], Text>> = {
  "personal-client": { cs: "osobní klient", en: "personal client" },
  "personal-vm": { cs: "osobní VM", en: "personal VM" },
  "workspace-vm": { cs: "pracovní VM", en: "work VM" },
  "work-laptop": { cs: "pracovní laptop", en: "work laptop" },
};
const relationshipAccess: Readonly<
  Record<MachineRelationship["access"], Text>
> = {
  inbound: { cs: "smí sem", en: "may reach this Machine" },
  outbound: { cs: "odsud tam", en: "reachable from here" },
  both: { cs: "oběma směry", en: "both directions" },
};

// One short factual document: context for every agent starting inside the
// Folder, not a manual. Everything about the Machine comes from the recorded
// handover; everything about behavior from the preset and the profile.
function machineSection(
  preset: PresetName,
  machine: MachineBinding | null,
  pick: (text: Text) => string,
): string[] {
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
      ...machine.relationships.map((relation) =>
        pick({
          cs: `- \`${relation.machine}\` (${relationshipKinds[relation.kind].cs}): ${relationshipAccess[relation.access].cs}.`,
          en: `- \`${relation.machine}\` (${relationshipKinds[relation.kind].en}): ${relationshipAccess[relation.access].en}.`,
        }),
      ),
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
          cs: "- Organizace: na osobní Mašině nejsou namountovaná žádná Organization repa. Práce v Organizaci probíhá na Mašinách, které Organizace vlastní.",
          en: "- Organizations: no Organization repositories are mounted on a personal Machine. Organization work happens on Machines the Organization owns.",
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

export function renderInstructions(input: unknown): string {
  const { preset, machine, profile } = parseInstructionSource(input);
  const pick = (text: Text) => (profile.locale === "cs" ? text.cs : text.en);
  return [
    "# Lazurio",
    `<!-- ${instructionTemplateRevision}; ${JSON.stringify({ preset, profile })} -->`,
    ...machineSection(preset, machine, pick),
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
      cs: "- Před prací v Organizaci načti její aktuální AGENTS.md; nadřazená pravidla drží root Lazurio (`HumanAndMachines/Lazurio`, AGENTS.md). Tenhle dokument je nenahrazuje.",
      en: "- Before Organization work, load its current AGENTS.md; the overarching rules are the Lazurio root (`HumanAndMachines/Lazurio`, AGENTS.md). This document does not replace them.",
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
    "",
  ].join("\n");
}
