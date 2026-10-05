import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renderManual } from "../src/folder/manual";
import { presetProfile } from "../src/folder/presets";
import { planInstructions } from "../src/folder/reconcile";
import { renderInstructions } from "../src/folder/render";
import { bindings } from "./fixtures/machine-bindings";

// Every preset on every OS it is offered for, in both languages.
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

test("all launch journeys render both languages without undefined fragments", () => {
  for (const journey of journeys) {
    for (const locale of ["cs", "en"] as const) {
      const input = {
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      };
      const output = renderInstructions(input);
      expect(output).not.toContain("undefined");
      expect(output).toEqual(renderInstructions(input));
      expect(output).toContain(
        locale === "cs"
          ? "Profil neuděluje přístup"
          : "A profile grants no access",
      );
      expect(output.endsWith("\n")).toBe(true);
    }
  }
});

test("localized profile output deterministically feeds reconciliation", () => {
  const profile = presetProfile("hosted-organization-team", "linux", {
    locale: "cs",
    detail: "technical",
    coordination: "coordinator",
  });
  const source = {
    preset: "hosted-organization-team",
    machine: bindings.team,
    profile,
  };
  const cs = renderInstructions(source);
  const en = renderInstructions({
    ...source,
    profile: { ...profile, locale: "en" },
  });
  expect(cs).toContain("Komunikuj česky");
  expect(en).toContain("Communicate in English");
  expect(cs).not.toEqual(en);
  const reordered = Object.fromEntries(Object.entries(profile).reverse());
  expect(renderInstructions({ ...source, profile: reordered })).toEqual(cs);
  for (const output of [cs, en]) {
    expect(output).toContain("Organizations");
    expect(output).toContain("Personalspace");
    const digest = createHash("sha256").update(output).digest("hex");
    expect(
      planInstructions("AGENTS.md", null, digest, { kind: "absent" }),
    ).toEqual({ kind: "create", path: "AGENTS.md" });
    expect(
      planInstructions("AGENTS.md", digest, digest, {
        kind: "regular",
        digest,
      }),
    ).toEqual({ kind: "unchanged" });
  }
  expect(() =>
    renderInstructions({
      ...source,
      profile: { ...profile, locale: "invalid" },
    }),
  ).toThrow();
  // A preset the Machine does not allow never renders.
  expect(() =>
    renderInstructions({ ...source, preset: "hosted-personal" }),
  ).toThrow("not allowed");
  expect(() => renderInstructions({ ...source, machine: null })).toThrow(
    "not allowed",
  );
});

// The generated document per preset and language, on the OS each preset is
// offered for. Review the snapshot when the wording changes deliberately.
for (const journey of journeys.filter((entry) => entry.os !== "windows"))
  for (const locale of ["cs", "en"] as const)
    test(`rendered AGENTS.md snapshot: ${journey.preset} / ${locale}`, () => {
      expect(
        renderInstructions({
          preset: journey.preset,
          machine: journey.machine,
          profile: presetProfile(journey.preset, journey.os, { locale }),
        }),
      ).toMatchSnapshot();
    });

// Decision F28 and its addendum of 2026-10-05: towards people the place an
// agent works in is the Environment, and Czech-speaking agents may also say
// „prostředí“. Every preset, both locales.
test("towards people the place is the Environment, in Czech also „prostředí“", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const)
      expect(
        renderInstructions({
          preset: journey.preset,
          machine: journey.machine,
          profile: presetProfile(journey.preset, journey.os, { locale }),
        }).split("\n"),
      ).toContain(
        locale === "cs"
          ? "- Lidem říkej tomu, kde pracuješ, Environment (česky i prostředí; ten Environment, na tomto Environmentu) a hostovanému Remote Environment; slova Mašina, VM ani server jim neříkej. Machine zůstává technický pojem pro hranici, na které Environment běží (příkazy jako `lazurio machine …`, identifikátory, architektura)."
          : "- Towards people, call the place you work in the Environment (in Czech also „prostředí“), and a hosted one a Remote Environment; do not say Machine, VM or server to them. Machine stays the technical term for the boundary an Environment runs on (commands such as `lazurio machine …`, identifiers, the architecture).",
      );
});

test("relationships render only when the recorded binding carries them, one line per peer", () => {
  const profile = presetProfile("hosted-personal", "linux");
  const plain = renderInstructions({
    preset: "hosted-personal",
    machine: bindings.personal,
    profile,
  });
  expect(plain).not.toContain("### Tailnet peers");
  const related = renderInstructions({
    preset: "hosted-personal",
    machine: bindings.personalRelated,
    profile,
  });
  expect(related).toContain("### Tailnet peers");
  expect(related).toContain(
    "- `example-laptop` (client device, personal zone): SSH both ways with `example-laptop.tailnet.example.invalid`; no HTTPS.",
  );
  expect(related).toContain(
    "- `example-workspace` (work Remote Environment, work zone, Organization `example`): SSH from here to `example-workspace.tailnet.example.invalid` as `operator`; HTTPS `launchpad.example-workspace.example.lazurio.io`.",
  );
  expect(related).toContain("Headscale enforces them, Lazurio does not.");
  expect(related).toMatchSnapshot();
  const work = renderInstructions({
    preset: "hosted-organization-personal",
    machine: bindings.related,
    profile: presetProfile("hosted-organization-personal", "linux", {
      locale: "cs",
    }),
  });
  expect(work).toContain("### Peers v tailnetu");
  expect(work).toContain(
    "- `example` (osobní Remote Environment, osobní zóna): SSH sem z `example.tailnet.example.invalid` jako `operator`; bez HTTPS.",
  );
  expect(work).toContain(
    "- `example-gateway` (Conglomerate Host, Organizace `example`): bez SSH; HTTPS `auth.example.lazurio.io`.",
  );
});

// owner.assignment (Machines v0.12.61) is rendered exactly as recorded and
// only when present; the Owner line rule is unchanged by it.
test("the Assignment line renders the handover's owner.assignment and nothing else", () => {
  const without = renderInstructions({
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    profile: presetProfile("hosted-organization-personal", "linux"),
  });
  expect(without).not.toContain("Assignment");
  const operator = renderInstructions({
    preset: "hosted-organization-personal",
    machine: bindings.assignedOperator,
    profile: presetProfile("hosted-organization-personal", "linux"),
  });
  expect(operator).toContain(
    "- Assignment: assigned to Operator `example` (GitHub id 12345).",
  );
  expect(operator).toContain("- Owner: Organization `example`.\n");
  expect(operator).not.toContain("sample-team");
  expect(operator).toMatchSnapshot();
  const team = renderInstructions({
    preset: "hosted-organization-team",
    machine: bindings.assignedTeam,
    profile: presetProfile("hosted-organization-team", "linux"),
  });
  expect(team).toContain("- Assignment: shared by the Team.");
  expect(team).toContain("Team `sample-team`");
  expect(team).toMatchSnapshot();
  expect(
    renderInstructions({
      preset: "hosted-organization-team",
      machine: bindings.assignedTeam,
      profile: presetProfile("hosted-organization-team", "linux", {
        locale: "cs",
      }),
    }),
  ).toContain("- Přiřazení: sdílený Teamem.");
  expect(
    renderInstructions({
      preset: "hosted-organization-personal",
      machine: bindings.assignedOperator,
      profile: presetProfile("hosted-organization-personal", "linux", {
        locale: "cs",
      }),
    }),
  ).toContain(
    "- Přiřazení: přiřazený Operátorovi `example` (GitHub id 12345).",
  );
});

// The real canary shape: a Team-bearing handover on an individual work VM,
// adopted with the explicit personal preset. The binding keeps the Team; the
// Owner line names it only under hosted-organization-team.
test("the Owner line names the Team only under hosted-organization-team", () => {
  for (const locale of ["cs", "en"] as const) {
    const personal = renderInstructions({
      preset: "hosted-organization-personal",
      machine: bindings.team,
      profile: presetProfile("hosted-organization-personal", "linux", {
        locale,
      }),
    });
    expect(personal).toContain(
      locale === "cs"
        ? "- Owner: Organizace `example`.\n"
        : "- Owner: Organization `example`.\n",
    );
    expect(personal).not.toContain("sample-team");
    expect(personal).toEqual(
      renderInstructions({
        preset: "hosted-organization-personal",
        machine: bindings.organization,
        profile: presetProfile("hosted-organization-personal", "linux", {
          locale,
        }),
      }),
    );
    expect(
      renderInstructions({
        preset: "hosted-organization-team",
        machine: bindings.team,
        profile: presetProfile("hosted-organization-team", "linux", { locale }),
      }),
    ).toContain("Team `sample-team`");
  }
  expect(
    renderInstructions({
      preset: "hosted-organization-personal",
      machine: bindings.team,
      profile: presetProfile("hosted-organization-personal", "linux"),
    }),
  ).toMatchSnapshot();
});

// Decisions 0161 and F17: the generated AGENTS.md rule and the manual section
// it points at say the same thing on every hosted preset. The Operator owns
// the version of Lazurio and the pin is a minimum (addendum 2026-09-28); the
// agent runs `lazurio update` itself, in the background at the start of every
// piece of work, and updates a tool only with the Operator's consent (addendum
// 2026-10-02). The old "no self-update of any tool" wording is gone from both.
test("the hosted update rule in AGENTS.md agrees with the manual under decisions 0161 and F17", () => {
  for (const journey of journeys) {
    if (journey.machine === null) continue;
    for (const locale of ["cs", "en"] as const) {
      const profile = presetProfile(journey.preset, journey.os, { locale });
      const instructions = renderInstructions({
        preset: journey.preset,
        machine: journey.machine,
        profile,
      });
      const manual = renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile,
      })["manual/troubleshooting.md"] as string;
      for (const text of [instructions, manual]) {
        expect(text).toMatch(/decisions? 0161/);
        expect(text).not.toMatch(/žádný self-update|any self-update/);
        expect(text).toMatch(
          locale === "cs" ? /až s jeho souhlasem/ : /only with their consent/,
        );
        expect(text).toMatch(/na pozadí|in the background/);
      }
      expect(instructions).toContain(
        locale === "cs"
          ? "- Na začátku práce spusť na pozadí `lazurio update`"
          : "- At the start of work, run `lazurio update` in the background",
      );
      expect(manual).toContain(
        locale === "cs"
          ? "Pin provozovatele hostingu (Lazurio Machines) je jen minimum"
          : "The hosting operator's pin (Lazurio Machines) is only a minimum",
      );
    }
  }
});

// Decision 0169: the Automated Environment names its GitHub identity (the
// persona's own machine account, signed in by the responsible operator), the
// bot team in Lazurio MausBot and the publication rule; no other preset says
// any of it, and the others render exactly as before (their snapshots above
// are unchanged and the template revision is the same).
test("the Steward preset renders the persona, its bot team and the publication rule; no other preset does", () => {
  const steward = (locale: "cs" | "en") =>
    renderInstructions({
      preset: "hosted-organization-steward",
      machine: bindings.automated,
      profile: presetProfile("hosted-organization-steward", "linux", {
        locale,
      }),
    });
  const en = steward("en");
  for (const line of [
    "- Assignment: an automated Environment of an Organization persona; responsible Operator `example` (GitHub id 12345).",
    "- Identity: the persona's own GitHub user account, a bot account, signed in to `gh` by the responsible Operator, who also holds its two-factor authentication and recovery. Every tool, T3 Code and every bot acts as that account within its live GitHub rights. Never sign in the Operator's own account or anyone else's here; GitHub is the only access authority.",
    "## Persona bot team",
    "`/lazurio publish`",
    "Organization `example`",
  ])
    expect(en).toContain(line);
  const cs = steward("cs");
  expect(cs).toContain("## Tým botů persony");
  expect(cs).toContain("`/lazurio publish`");
  // Issue #99: the text this preset adds says Environment, never Machine.
  const manual = (locale: "cs" | "en") =>
    renderManual({
      preset: "hosted-organization-steward",
      machine: bindings.automated,
      profile: presetProfile("hosted-organization-steward", "linux", {
        locale,
      }),
    })["manual/this-machine.md"];
  for (const [document, from, to] of [
    [en, "## Persona bot team", "## How work is done here"],
    [cs, "## Tým botů persony", "## Jak se tu pracuje"],
    [manual("en"), "## Lazurio MausBot", "## Enabled tools"],
    [manual("cs"), "## Lazurio MausBot", "## Zapnuté nástroje"],
  ] as const) {
    const section = document.slice(
      document.indexOf(from),
      document.indexOf(to),
    );
    expect(section.length).toBeGreaterThan(from.length);
    expect(section).not.toMatch(/Mašin|Machine|\bVM\b|server/);
  }
  for (const document of [en, cs])
    for (const line of document.split("\n"))
      if (
        /^- (Assignment|Přiřazení|Operator|Operátor|Identity|Identita):/.test(
          line,
        )
      )
        expect(line).not.toMatch(/Mašin|Machine|\bVM\b|server/);
  for (const journey of journeys.filter(
    (entry) => entry.preset !== "hosted-organization-steward",
  ))
    for (const locale of ["cs", "en"] as const) {
      const output = renderInstructions({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      // Lazurio MausBot is also an Operator client on every hosted preset;
      // the persona's bot team and its publication rule are the Steward's.
      for (const marker of [
        "## Persona bot team",
        "## Tým botů persony",
        "/lazurio publish",
      ])
        expect(output).not.toContain(marker);
      expect(output).not.toMatch(/\bperson(a|y|ou)\b/);
    }
});

// On the Team's shared Environment the agent asks for a team account before it
// connects an application, and Composio itself is signed in with a team account;
// no other preset says so (DEV-6637, 2026-10-05).
test("only the Team's shared Environment asks for a team account before connecting an application", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const output = renderInstructions({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const team = journey.preset === "hosted-organization-team";
      for (const sentence of locale === "cs"
        ? [
            "i do samotného Composia týmový účet; osobní účet sem nepatří.",
            "„Tohle napojení bude sdílené celým Teamem. Jaký týmový účet mám připojit? Svůj osobní Outlook si napojte ve svém Environmentu.“",
          ]
        : [
            "including a team account for Composio itself; a personal account does not belong here.",
            "“This connection will be shared by the whole Team. Which team account should I connect? Connect your personal Outlook in your own Environment.”",
          ])
        expect([journey.preset, locale, output.includes(sentence)]).toEqual([
          journey.preset,
          locale,
          team,
        ]);
    }
});
