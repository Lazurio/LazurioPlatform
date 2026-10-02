import {
  activeTools,
  parseEnabledTools,
  parseToolNotes,
  type ToolNotes,
  type ToolTier,
} from "../tools/catalog";
import { quoteToolNote } from "../tools/note";
import {
  type MachineBinding,
  type MachinePeer,
  parseMachineBinding,
} from "./machine-binding";
import { manualEntries } from "./outputs";
import {
  type PresetName,
  parsePresetName,
  presetVersion,
  validatePresetComposition,
  workspacePreset,
} from "./presets";
import { type FolderProfile, parseFolderProfile } from "./profile";
import { enabledTools, type FolderPreferences, toolNotes } from "./state";
import { ownDataValue, stateFields } from "./state-fields";

// Version the template set (AGENTS.md and the manual) independently from
// future persisted preference schemas.
export const instructionTemplateRevision = "base-instructions-17";

// Template revisions are ordered by their number. A Folder rendered by an
// older revision is re-rendered by the next change of the generated Folder
// (a refresh or a profile change) when every file still has its recorded
// digest (decision F14). A revision this product does not know, a newer one
// or one of another form, is never re-rendered or downgraded by it.
function templateRevisionNumber(revision: string): number | null {
  const match = /^base-instructions-([1-9][0-9]{0,8})$/.exec(revision);
  return match === null ? null : Number(match[1]);
}

/** A template revision of this product's form, whatever its number. */
export const isTemplateRevision = (revision: string) =>
  templateRevisionNumber(revision) !== null;

export function isOlderTemplateRevision(
  revision: string,
  than: string = instructionTemplateRevision,
): boolean {
  const recorded = templateRevisionNumber(revision);
  const current = templateRevisionNumber(than);
  return recorded !== null && current !== null && recorded < current;
}

// What the renderer needs and nothing else: the preset, the immutable Machine
// binding (null on a workstation), the profile, the enabled catalog tools
// (decision F18) and the operator's notes on them (F18 addendum 2026-09-27).
// Validated as one composition. A source without `tools` has nothing enabled
// and one without `toolNotes` no note; the parsed source always names both.
export type InstructionSource = Readonly<{
  preset: PresetName;
  machine: MachineBinding | null;
  profile: FolderProfile;
  tools: readonly string[];
  toolNotes: ToolNotes;
}>;

export function parseInstructionSource(input: unknown): InstructionSource {
  const withTools = ownDataValue(input, "tools") !== undefined;
  const withNotes = ownDataValue(input, "toolNotes") !== undefined;
  const value = stateFields(input, [
    "preset",
    "machine",
    "profile",
    ...(withTools ? ["tools"] : []),
    ...(withNotes ? ["toolNotes"] : []),
  ]);
  const preset = parsePresetName(value.preset);
  const machine = parseMachineBinding(value.machine);
  const profile = parseFolderProfile(value.profile);
  validatePresetComposition(preset, machine, profile);
  const tools = withTools ? parseEnabledTools(value.tools) : Object.freeze([]);
  const notes = withNotes
    ? parseToolNotes(value.toolNotes, tools)
    : Object.freeze({});
  return Object.freeze({ preset, machine, profile, tools, toolNotes: notes });
}

export function instructionSource(
  preferences: FolderPreferences,
): InstructionSource {
  return Object.freeze({
    preset: preferences.preset.name,
    machine: preferences.machine,
    profile: preferences.profile,
    tools: enabledTools(preferences),
    toolNotes: toolNotes(preferences),
  });
}

export type Text = Readonly<{ cs: string; en: string }>;
const peerKinds: Readonly<Record<MachinePeer["kind"], Text>> = {
  "personal-vm": {
    cs: "osobní Remote Environment",
    en: "personal Remote Environment",
  },
  "workspace-vm": {
    cs: "pracovní Remote Environment",
    en: "work Remote Environment",
  },
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
  inbound: { cs: "SSH sem z", en: "SSH to this Environment from" },
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
          cs: "- Přiřazení: sdílený Teamem.",
          en: "- Assignment: shared by the Team.",
        }
      : assignment.kind === "automation"
        ? {
            cs: `- Přiřazení: automatizovaný Environment persony Organizace; odpovědný Operátor \`${assignment.githubLogin}\` (GitHub id ${assignment.githubId}).`,
            en: `- Assignment: an automated Environment of an Organization persona; responsible Operator \`${assignment.githubLogin}\` (GitHub id ${assignment.githubId}).`,
          }
        : {
            cs: `- Přiřazení: přiřazený Operátorovi \`${assignment.githubLogin}\` (GitHub id ${assignment.githubId}).`,
            en: `- Assignment: assigned to Operator \`${assignment.githubLogin}\` (GitHub id ${assignment.githubId}).`,
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
    pick({ cs: "## Tenhle Environment", en: "## This Environment" }),
    pick({
      cs: `- Preset: \`${preset}\` (verze ${presetVersion}).`,
      en: `- Preset: \`${preset}\` (version ${presetVersion}).`,
    }),
  ];
  if (machine === null)
    return [
      ...lines,
      pick({
        cs: "- Pracovní stanice Operátora bez handoveru; Owner i Operátor je přihlášený uživatel.",
        en: "- The Operator's own workstation, no handover; the signed-in user is both Owner and Operator.",
      }),
    ];
  // The recorded binding keeps the handover's Team untouched; the Owner line
  // names it only when the preset says the Machine is shared by that Team.
  // Under hosted-organization-personal the Team is the handover value that
  // does not decide assignment (see machineAssignment), so it is not rendered.
  const owner =
    machine.owner.kind === "principal"
      ? pick({
          cs: `- Owner: člověk s GitHub loginem \`${machine.owner.githubLogin}\` (id ${machine.owner.githubId}). Je to jeho jediný osobní Remote Environment.`,
          en: `- Owner: the person with GitHub login \`${machine.owner.githubLogin}\` (id ${machine.owner.githubId}). This is their one personal Remote Environment.`,
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
  const operator = {
    "hosted-personal": {
      cs: "- Operátor: Owner tohohle Environmentu. Agenti tu jednají za něj v jeho právech; Buddy je volitelný rezident téhož Environmentu.",
      en: "- Operator: the Owner of this Environment. Agents here act for them within their rights; a Buddy is an optional resident of this same Environment.",
    },
    "hosted-organization-personal": {
      cs: "- Operátor: ten, komu Organizace tenhle pracovní Remote Environment přiřadila. Agenti jednají za něj v jeho živých právech.",
      en: "- Operator: the person the Organization assigned this work Remote Environment to. Agents act for them within their live rights.",
    },
    "hosted-organization-team": {
      cs: "- Operátor: člen Teamu, který je právě připojený. OS účet sdílí Team a není osoba. Na GitHubu jednáš jako brokerovaná identita Organizace, ne jako ten člověk, a změny se připisují Teamu.",
      en: "- Operator: whichever Team member is connected now. The OS account is shared by the Team and is not a person. On GitHub you act as the brokered Organization identity, not as that person, and changes are attributed to the Team.",
    },
    "hosted-organization-steward": {
      cs: "- Operátor: Owner nebo Admin Organizace, který za tenhle Automatizovaný Environment odpovídá. Pracuje tu tým botů persony; agenti jednají jako GitHub účet persony v jeho živých právech a přes SSH se sem připojuje jen Operátor, pro servisní zákroky.",
      en: "- Operator: the Owner or Admin of the Organization who answers for this Automated Environment. The persona's bot team works here; agents act as the persona's GitHub account within its live rights, and only the Operator connects over SSH, for service interventions.",
    },
    local: { cs: "", en: "" },
  }[preset];
  lines.push(
    pick({
      cs: `- Název: \`${machine.name}\` (${machine.kind}).`,
      en: `- Name: \`${machine.name}\` (${machine.kind}).`,
    }),
    owner,
    ...assignmentLine(machine, locale),
    pick(operator),
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
      cs: `- Host: ${machine.host.kind} \`${machine.host.id}\`; vyšší doména správy a obnovy než tenhle Environment.`,
      en: `- Host: ${machine.host.kind} \`${machine.host.id}\`; a higher administration and recovery domain than this Environment.`,
    }),
  );
  if (machine.relationships !== undefined)
    lines.push(
      pick({ cs: "### Peers v tailnetu", en: "### Tailnet peers" }),
      pick({
        cs: `Peers v tailnetu podle handoveru (${peerZones[machine.relationships.zone].cs} tohohle Environmentu); vynucuje je Headscale, ne Lazurio.`,
        en: `Tailnet peers as the handover records them (this Environment is in the ${peerZones[machine.relationships.zone].en}); Headscale enforces them, Lazurio does not.`,
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
          cs: "- Personalspace: `personalspace/` je intimní prostor jednoho člověka, Ownera tohohle Environmentu, a jeho volitelného Buddyho. Nikdo cizí ho nečte a nikdy se nesdílí.",
          en: "- Personalspace: `personalspace/` is the intimate space of one person, the Owner of this Environment, and their optional Buddy. Nobody else reads it and it is never shared.",
        })
      : pick({
          cs: "- Personalspace: na Environmentu vlastněném Organizací nikdy není. Nezakládej ho, nemountuj ho a nekopíruj sem osobní data ani přihlášení.",
          en: "- Personalspace: never present in an Organization-owned Environment. Do not create or mount one and never copy personal data or sign-ins here.",
        }),
    preset === "hosted-personal"
      ? pick({
          cs: "- Organizace: na osobním Remote Environmentu nejsou namountovaná žádná repa Organizací. Práce v Organizaci (kód, repozitáře, běhy) probíhá přes SSH na pracovním Remote Environmentu, který ti Operátor potvrdí jako přiřazený jemu; repozitáře Organizací sem nikdy neklonuj.",
          en: "- Organizations: no Organization repositories are mounted in a personal Remote Environment. Organization work (code, repositories, runs) happens over SSH in a work Remote Environment the Operator confirms is assigned to them; never clone Organization repositories here.",
        })
      : pick({
          cs: "- Organizace: repozitáře žijí v `organizations/<org>/`; každá Organizace je vlastní access hranice a vlastní git repozitář.",
          en: "- Organizations: repositories live under `organizations/<org>/`; each Organization is its own access boundary and its own git repository.",
        }),
    providerIdentity === "own-sign-in"
      ? pick({
          cs: "- Identita: Operátorova vlastní přihlášení; GitHub je jediná autorita přístupů.",
          en: "- Identity: the Operator's own sign-ins; GitHub is the only access authority.",
        })
      : providerIdentity === "persona-account"
        ? pick(personaIdentity)
        : pick({
            cs: "- Identita: brokerovaná identita Organizace s krátkodobými tokeny; žádná osobní přihlášení, session ani credentials sem nikdy nepatří.",
            en: "- Identity: the brokered Organization identity with short-lived tokens; no personal sign-ins, sessions or credentials ever belong here.",
          }),
  ];
}

// The identity line of the Automated Environment (decision 0169), the same in
// AGENTS.md and the manual.
export const personaIdentity: Text = {
  cs: "- Identita: vlastní GitHub uživatelský účet persony (účet bota), který v `gh` přihlašuje odpovědný Operátor a který drží i jeho dvoufázové ověření a obnovu. Všechny nástroje, T3 Code i každý bot jednají jako tento účet v jeho živých GitHub právech. Vlastní účet Operátora ani nikoho jiného sem nepřihlašuj; GitHub je jediná autorita přístupů.",
  en: "- Identity: the persona's own GitHub user account, a bot account, signed in to `gh` by the responsible Operator, who also holds its two-factor authentication and recovery. Every tool, T3 Code and every bot acts as that account within its live GitHub rights. Never sign in the Operator's own account or anyone else's here; GitHub is the only access authority.",
};

// The bot team of the Automated Environment (decision 0169) in its short form;
// `manual/this-machine.md` lists the configuration. Nothing on other presets.
function botTeamSection(
  preset: PresetName,
  machine: MachineBinding | null,
  pick: (text: Text) => string,
): string[] {
  if (workspacePreset(preset).botTeam === null || machine === null) return [];
  const organization =
    machine.owner.kind === "organization" ? machine.owner.organization : "";
  return [
    pick({ cs: "## Tým botů persony", en: "## Persona bot team" }),
    pick({
      cs: "- Lazurio MausBot provozuje tým botů persony jako službu a webovou aplikaci tohoto Environmentu vedle T3 Code. Noví boti začínají v tomhle Folderu a řídí se stejnou kaskádou AGENTS.md, plány Mission Controlu a worktrees jako agenti v T3 Code (decision 0169).",
      en: "- Lazurio MausBot runs the persona's bot team as a service and web application of this Environment next to T3 Code. New bots start in this Folder and follow the same AGENTS.md cascade, Mission Control plans and worktrees as agents in T3 Code (decision 0169).",
    }),
    pick({
      cs: `- Podle výchozího nastavení presetu sleduje napojení na GitHub pull requesty Organizace \`${organization}\` bez modelu a leaderovi týmu předá jen skutečnou práci: review nového headu pull requestu v Ready, nebo publikaci. Repozitáře infra a productionspace Organizace vynechává; hranicí jsou tak jako tak práva účtu persony. Konfiguraci uvádí \`manual/this-machine.md\`.`,
      en: `- By the preset's defaults, its GitHub intake watches pull requests of Organization \`${organization}\` without a model and hands the team leader only real work: a review on a new head of a ready pull request, or a publication. It leaves out the Organization's infra and productionspace repositories; the persona account's rights are the limit either way. \`manual/this-machine.md\` lists the configuration.`,
    }),
    pick({
      cs: "- Persona publikuje jen pull request, který jí byl přiřazen s výslovným pokynem `/lazurio publish` od člověka s právem zápisu, a to po schválení člověkem a se zelenými kontrolami; vlastní pull requesty persony schvaluje člověk (Owner, Admin nebo Steward). Kolegové s personou spolupracují přes GitHub.",
      en: "- The persona publishes only a pull request assigned to it with an explicit `/lazurio publish` instruction from a person with write access, after human approval and with green checks; a person (an Owner, Admin or Steward) approves the persona's own pull requests. Colleagues work with the persona through GitHub.",
    }),
  ];
}

// What every hosted Machine needs before an agent acts: how to reach another
// Machine and how the Operator sees the agent's work. Only Codex Desktop's
// built-in browser reaches a `localhost` port here, through an SSH tunnel it
// opens itself; T3 Code and Lazurio MausBot forward nothing (decision F14
// addendum 2026-10-02).
function hostedLines(
  pick: (text: Text) => string,
  machine: MachineBinding,
): string[] {
  const ssh = operatorConnectsOverSsh(machine);
  return [
    pick({
      cs: "- SSH na jiný Environment nebo zařízení jen na jeho tailnet hostname, s pinnutým host klíčem a po ověření aktivního tailnetu, nikdy na holou adresu `100.64.0.x` (`manual/this-machine.md`).",
      en: "- SSH to another Environment or device only to its tailnet hostname, with a pinned host key and after verifying the active tailnet, never to a bare `100.64.0.x` address (`manual/this-machine.md`).",
    }),
    pick(
      ssh === true
        ? {
            cs: "- Operátor se sem připojuje přes SSH. `localhost` odsud otevře jen integrovaný prohlížeč Codex Desktopu, který si k portu sám otevře tunel; T3 Code ani Lazurio MausBot port nepřesměrují. Aplikaci modulu odkazuj jejím `runtime.url` (`manual/this-machine.md`).",
            en: "- The Operator connects here over SSH. Only Codex Desktop's built-in browser opens `localhost` from here, through a tunnel it opens to the port itself; T3 Code and Lazurio MausBot forward no port. Link a module's application by its `runtime.url` (`manual/this-machine.md`).",
          }
        : ssh === false
          ? {
              cs: "- Operátor se sem přes SSH nepřipojuje: `localhost` odsud neotevře a žádný port se nepřesměruje. Aplikaci modulu odkazuj jejím `runtime.url` (`manual/this-machine.md`).",
              en: "- The Operator does not connect here over SSH: they cannot open `localhost` from here and no port is forwarded. Link a module's application by its `runtime.url` (`manual/this-machine.md`).",
            }
          : {
              cs: "- `localhost` existuje jen tady. Otevře ho jen integrovaný prohlížeč Codex Desktopu připojeného přes SSH, který si k portu sám otevře tunel; T3 Code ani Lazurio MausBot port nepřesměrují. Aplikaci modulu odkazuj jejím `runtime.url` (`manual/this-machine.md`).",
              en: "- `localhost` exists only here. Only the built-in browser of Codex Desktop connected over SSH opens it, through a tunnel it opens to the port itself; T3 Code and Lazurio MausBot forward no port. Link a module's application by its `runtime.url` (`manual/this-machine.md`).",
            },
    ),
  ];
}

// Keeping the Environment current (decision F17 addendum 2026-10-02): at the
// start of work the agent updates Lazurio in the background, then the clean
// checkouts, and offers the Operator a newer tool. A personal Remote
// Environment mounts no Organization; a Team Environment shares everything.
function updateLine(preset: PresetName): Text {
  const checkouts = preset !== "hosted-personal";
  const team = preset === "hosted-organization-team";
  return {
    cs: [
      checkouts
        ? "- Na začátku práce spusť na pozadí `lazurio update` a aktualizuj čisté checkouty Organizací a modulů (`git pull --ff-only`); rozjetý checkout srovnej tak, aby se žádná práce neztratila."
        : "- Na začátku práce spusť na pozadí `lazurio update`.",
      "Novější verzi nástroje (Codex, Claude Code, `gh`, Node, Bun…) Operátorovi nabídni a aktualizuj ji až s jeho souhlasem.",
      ...(team
        ? [
            "Na týmovém Environmentu dopadne aktualizace na všechny jeho Operátory: Launchpad se jim na chvíli restartuje a nástroje i checkouty jsou společné.",
          ]
        : []),
      "Postup je v `manual/troubleshooting.md` (decisions 0161 a F17).",
    ].join(" "),
    en: [
      checkouts
        ? "- At the start of work, run `lazurio update` in the background and update the clean checkouts of Organizations and modules (`git pull --ff-only`); bring a diverged checkout back so that no work is lost."
        : "- At the start of work, run `lazurio update` in the background.",
      "Offer the Operator a newer version of a tool (Codex, Claude Code, `gh`, Node, Bun…) and update it only with their consent.",
      ...(team
        ? [
            "On a Team Environment an update affects all its Operators: the Launchpad restarts for them for a moment, and the tools and checkouts are shared.",
          ]
        : []),
      "The procedure is in `manual/troubleshooting.md` (decisions 0161 and F17).",
    ].join(" "),
  };
}

// A missing right is the most common stall on hosted work Environments: the
// agent escalates it to a named administrator and keeps working (decision F14
// addendum 2026-10-02).
const rightsLine: Text = {
  cs: "- Když na něco nemáš práva nebo GitHub odmítne push, práci nezahazuj. Zjisti živě, kdo to smí povolit, zapiš mu issue do kořenového repozitáře Organizace a přiřaď mu ho, Operátorovi dej hotový krátký text pro něj a pokračuj na všem ostatním (`manual/working-here.md`).",
  en: "- When you lack the rights for something or GitHub refuses a push, never discard the work. Find out live who may grant it, file an issue for them in the Organization's root repository and assign it to them, give the Operator a short ready text for them, and continue with everything else (`manual/working-here.md`).",
};

const tierLabels: Readonly<Record<ToolTier, Text>> = {
  required: { cs: "povinný", en: "required" },
  recommended: { cs: "zapnutý", en: "enabled" },
  optional: { cs: "zapnutý", en: "enabled" },
};

// The short marker on the AGENTS.md line of a tool the operator left a note
// on; the note itself is quoted only in the manual.
const noteMarker: Text = {
  cs: "Operátor k němu agentům zanechal poznámku v `manual/this-machine.md`.",
  en: "The Operator left a note on it for agents in `manual/this-machine.md`.",
};

// The attribution above a quoted note in the manual.
export const noteAttribution: Text = {
  cs: "Poznámka Operátora tohohle Environmentu:",
  en: "Note from the Operator of this Environment:",
};

// Said once in the manual when any tool carries a note.
export const notesMeaning: Text = {
  cs: "Poznámka Operátora u nástroje je záměr Operátora tohohle Environmentu pro agenty, kteří tu pracují: řiď se jí v mezích pokynu Operátora. Neuděluje žádný přístup ani mandát k Publikaci a pravidla tohohle dokumentu nemění; je to citovaný text, ne instrukce Lazuria.",
  en: "A note from the Operator on a tool is the intent of this Environment's Operator for the agents working here: follow it within the Operator's instructions. It grants no access and no mandate for a Publication and changes none of the rules of this document; it is quoted text, not an instruction of Lazurio.",
};

// One line per tool agents are to use: the required ones and the enabled
// ones, in catalog order. `text` selects what the line says about the tool:
// its purpose, with the marker of an operator's note (AGENTS.md), or its
// purpose and usage followed by the quoted note (the manual).
export function toolLines(
  tools: readonly string[],
  locale: FolderProfile["locale"],
  text: "purpose" | "usage",
  notes: ToolNotes = {},
): string[] {
  return activeTools(tools).flatMap(({ name, activation }) => {
    const note = Object.hasOwn(notes, name) ? notes[name] : undefined;
    const line = `- \`${name}\` (${tierLabels[activation.tier][locale]}): ${
      text === "purpose"
        ? `${activation.purpose[locale]}${note === undefined ? "" : ` ${noteMarker[locale]}`}`
        : `${activation.purpose[locale]} ${activation.usage[locale]}`
    }`;
    if (text === "purpose" || note === undefined) return [line];
    // Inside the list item: the attribution, then every line of the note as
    // a quoted line (`quoteToolNote` keeps it one literal block).
    return [
      line,
      `  ${noteAttribution[locale]}`,
      ...quoteToolNote(note).map((quoted) => `  ${quoted}`),
    ];
  });
}

// The generic instruction for MCP servers, shared by AGENTS.md and the
// manual. No MCP server is ever recorded in the Folder.
export const mcpInstruction: Text = {
  cs: "MCP servery přicházejí na řadu až po CLI z katalogu: zjisti ve svém harnessu, které nabízí, a použij je tam, kde úkol žádné CLI z katalogu nepokrývá. Do Folderu se MCP servery nikdy nezapisují a dostupný server není souhlas s Publikací.",
  en: "MCP servers come after the catalog CLIs: discover in your harness which ones it offers and use them where no catalog CLI covers the task. MCP servers are never recorded in the Folder, and an available server is not consent to Publication.",
};

// On an Environment shared by several operators (the Team preset) a sign-in
// of a tool belongs to the whole Environment, not to the person who made it.
export const sharedSignInWarning: Text = {
  cs: "**Sdílený Environment:** účty přihlášené v nástrojích platí pro celý tenhle Environment a sdílí je všichni jeho Operátoři i jejich agenti. Přihlašuj tu jen účty, které mají být dostupné celému Teamu; osobní účet sem nepatří.",
  en: "**Shared Environment:** accounts signed in to the tools apply to this whole Environment and are shared by all its Operators and their agents. Sign in only accounts meant for the whole Team; a personal account does not belong here.",
};

// Whether the Environment runs on a hosted Machine: every preset but the
// local workstation.
export function hostedEnvironment(preset: PresetName): boolean {
  return preset !== "local";
}

// Whether sign-ins on this preset are shared by several operators.
export function sharedEnvironment(preset: PresetName): boolean {
  return workspacePreset(preset).providerIdentity === "brokered-organization";
}

// Whether the operator reaches this Environment over SSH, as the handover's
// peers record it: a client device or a personal Remote Environment whose SSH
// link points here. Only Codex Desktop over SSH reaches a `localhost` port here,
// through a tunnel it opens itself. `null` when the handover records no
// relationships.
export function operatorConnectsOverSsh(
  machine: MachineBinding | null,
): boolean | null {
  const relationships = machine?.relationships;
  if (relationships === undefined) return null;
  return relationships.peers.some(
    (peer) =>
      (peer.kind === "client-device" || peer.kind === "personal-vm") &&
      peer.ssh !== null &&
      peer.ssh.direction !== "outbound",
  );
}

// Where an agent saves a work product that does not belong in a repository:
// the Operator's own Documents folder of the OS, never the Folder (Matěj's
// decision 2026-10-02: a standard folder, not an invented one).
function documentsLine(os: FolderProfile["os"]): Text {
  return os === "windows"
    ? {
        cs: "- Výstup, který nepatří do repozitáře, ulož do složky Dokumenty (`[Environment]::GetFolderPath('MyDocuments')`) do podsložky úkolu a uveď celou cestu; do kořene Folderu nic neukládej.",
        en: "- Save a work product that does not belong in a repository in the Documents folder (`[Environment]::GetFolderPath('MyDocuments')`), in a subfolder for the task, and give the full path; never write anything at the top level of the Folder.",
      }
    : {
        cs: "- Výstup, který nepatří do repozitáře, ulož do `~/Documents/<úkol>/` a uveď celou cestu; do kořene Folderu nic neukládej.",
        en: "- Save a work product that does not belong in a repository in `~/Documents/<task>/` and give the full path; never write anything at the top level of the Folder.",
      };
}

// The tools of this Environment (decision F18): what to use and in which
// order. The usage of every tool is in `manual/this-machine.md`.
function toolsSection(
  tools: readonly string[],
  notes: ToolNotes,
  locale: FolderProfile["locale"],
  shared: boolean,
): string[] {
  const pick = (text: Text) => text[locale];
  return [
    pick({ cs: "## Nástroje", en: "## Tools" }),
    pick({
      cs: "Používej nejdřív tahle CLI z katalogu Lazuria, jak je popisuje `manual/this-machine.md`. Uvedený nástroj je kontext: neuděluje přístup, nic neinstaluje a nepinuje verzi.",
      en: "Use these CLIs of the Lazurio catalog first, as `manual/this-machine.md` describes them. A listed tool is context: it grants no access, installs nothing and pins no version.",
    }),
    ...toolLines(tools, locale, "purpose", notes),
    ...(shared ? [pick(sharedSignInWarning)] : []),
    pick(mcpInstruction),
  ];
}

// How agents name the place they work in when they talk to people (decision
// F28): Environment, and Remote Environment when it is hosted. "Machine" stays
// the technical term; the rule has to name the words it replaces.
export const environmentWording: Text = {
  cs: "- Lidem říkej tomu, kde pracuješ, Environment (ten Environment, na tomto Environmentu) a hostovanému Remote Environment; slova Mašina, VM ani server jim neříkej. Machine zůstává technický pojem pro hranici, na které Environment běží (příkazy jako `lazurio machine …`, identifikátory, architektura).",
  en: "- Towards people, call the place you work in the Environment, and a hosted one a Remote Environment; do not say Machine, VM or server to them. Machine stays the technical term for the boundary an Environment runs on (commands such as `lazurio machine …`, identifiers, the architecture).",
};

// Two general working rules of root decision 0163, in their short form; the
// full form is in `manual/working-here.md`.
const workingRules: readonly Text[] = [
  {
    cs: "- Otevřenou otázku, nejistotu nebo nález, který nejde hned vyřešit, zapiš bez ptaní jako GitHub Issue do přesného owning repozitáře a jeho URL uveď v handoffu. Předtím zkontroluj duplicity a odstraň secrets, Personalspace a obsah Organizace, který do toho repozitáře nepatří. Pak pokračuj na všem, co na odpovědi nestojí; zastav se jen tam, kde bez ní nejde pokračovat bezpečně nebo kde rozhodnutí patří Operátorovi. Issue bez pokynu Operátora nezavírej ani neprioritizuj a přiřazuj ho jen při eskalaci chybějících práv; plán, priorita a odpovědnost patří do Mission Controlu Organizace (`manual/working-here.md`).",
    en: "- File an open question, uncertainty or finding that cannot be resolved right away as a GitHub Issue in the exact owning repository, without asking first, and give its URL in the handoff. Before that, check for duplicates and remove secrets, Personalspace and Organization content that does not belong in that repository. Then continue with everything that does not depend on the answer; stop only where you cannot continue safely without it or where the decision belongs to the Operator. Do not close or prioritize an issue without the Operator's instruction, and assign one only to escalate missing rights; plan, priority and responsibility belong in the Organization's Mission Control (`manual/working-here.md`).",
  },
  {
    cs: "- Nálezy z review přijímej s úsudkem. Skutečnou vadu oprav hned: špatné chování, rozpor mezi texty, tvrzení bez důkazu, únik citlivého obsahu. Na drobnost bez dopadu, spekulaci o budoucí změně nebo rozšíření záběru PR neodpovídej dalším kolem oprav, ale věcnou námitkou v PR, a požádej o verdikt na nezměněném headu. Trvá-li reviewer na svém, předlož obě stanoviska Operátorovi; review ani branch rules nikdy neobcházej.",
    en: "- Take review findings with judgment. Fix a real defect at once: wrong behavior, a contradiction between texts, a claim without proof, a leak of sensitive content. Answer trivia without impact, speculation about a future change or a widening of the PR's scope not with another round of fixes but with a factual objection on the PR, and ask for a verdict on the unchanged head. If the reviewer still insists, put both positions to the Operator; never bypass the review or the branch rules.",
  },
];

export function renderInstructions(input: unknown): string {
  const {
    preset,
    machine,
    profile,
    tools,
    toolNotes: notes,
  } = parseInstructionSource(input);
  const pick = (text: Text) => (profile.locale === "cs" ? text.cs : text.en);
  return [
    "# Lazurio",
    `<!-- ${instructionTemplateRevision}; ${JSON.stringify({ preset, profile })} -->`,
    ...machineSection(preset, machine, profile.locale),
    ...boundarySection(preset, pick),
    ...botTeamSection(preset, machine, pick),
    pick({ cs: "## Jak se tu pracuje", en: "## How work is done here" }),
    pick({
      cs: "- Komunikuj česky, pokud uživatel nepožádá jinak.",
      en: "- Communicate in English unless the user requests otherwise.",
    }),
    pick(environmentWording),
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
    pick(updateLine(preset)),
    pick({
      cs: "- Tvoje práce je Draft ve worktree a pull requestu; Publikace (merge, nasazení, odeslání) patří Operátorovi a vyžaduje jeho explicitní pokyn v aktuálním threadu.",
      en: "- Your work is a Draft in a worktree and a pull request; Publication (merge, deploy, send) belongs to the Operator and needs their explicit instruction in the current thread.",
    }),
    pick({
      cs: "- Pracuješ s plným přístupem, bez sandboxu a bez schvalování jednotlivých příkazů; hranicí je tenhle Environment (decision 0172). Je to schopnost, ne souhlas: Publikace a zápisy do napojených aplikací dál čekají na pokyn Operátora.",
      en: "- You work with full access, without a sandbox and without per-command approvals; this Environment is the boundary (decision 0172). It is a capability, not consent: Publication and writes to connected applications still wait for the Operator's instruction.",
    }),
    pick(documentsLine(profile.os)),
    ...workingRules.map(pick),
    pick(rightsLine),
    pick({
      cs: "- Před prací v Organizaci načti její aktuální AGENTS.md v `organizations/<org>/`; pravidla Organizace platí uvnitř jejího checkoutu a tenhle dokument je nenahrazuje. Z rootu Folderu se v konkrétní Organizaci nepracuje.",
      en: "- Before Organization work, load its current AGENTS.md under `organizations/<org>/`; the Organization's rules apply inside its checkout and this document does not replace them. Never work in a specific Organization from the Folder root.",
    }),
    pick({
      cs: `- Ověř systém Environmentu, na kterém pracuješ (${profile.os}); přístup ${profile.access} nemění identitu ani oprávnění. Pro připojené operace ověř živou identitu a práva; lokální checkout není důkaz oprávnění.`,
      en: `- Verify the OS of the Environment you work in (${profile.os}); ${profile.access} access changes neither identity nor permissions. Verify live identity and rights for connected operations; a local checkout is not proof of permission.`,
    }),
    pick({
      cs: "- Profil neuděluje přístup, publikační mandát ani oprávnění k práci na pozadí. Nečti cizí Personalspace a nekopíruj přihlašovací údaje.",
      en: "- A profile grants no access, publication mandate or background-work authority. Do not read anyone else's Personalspace or copy credentials.",
    }),
    pick({
      cs: "- Zachovej existující cesty a obsah Organizations a Personalspace. Jazyk profilu nepřejmenovává složky ani nepřekládá uživatelská data.",
      en: "- Preserve existing Organizations and Personalspace paths and content. Profile language neither renames folders nor translates user data.",
    }),
    pick({
      cs: "- Chybějící nástroje, neověřená práva a neznámý stav přiznej; nevymýšlej dostupné schopnosti ani úspěšné dokončení.",
      en: "- Report missing tools, unverified rights and unknown state; do not invent available capabilities or successful completion.",
    }),
    ...(machine === null ? [] : hostedLines(pick, machine)),
    ...toolsSection(tools, notes, profile.locale, sharedEnvironment(preset)),
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
      ? "Úplný manuál pro agenty na tomhle Environmentu je v `manual/` (generuje ho produkt, needituj ho):"
      : "The complete agent manual for this Environment is in `manual/` (generated by the product, do not edit):",
    ...manualEntries.map(
      (entry) =>
        `- [${entry.title[locale]}](${entry.path}) — ${entry.summary[locale]}.`,
    ),
  ];
}
