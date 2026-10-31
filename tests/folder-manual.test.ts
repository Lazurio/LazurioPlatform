import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBuddyLayer } from "../src/folder/buddy";
import { FolderAdoptionError } from "../src/folder/handover-layout";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { renderManual } from "../src/folder/manual";
import {
  buddyLayerPaths,
  buddyRulesPath,
  manualPaths,
  outputFile,
  outputPaths,
} from "../src/folder/outputs";
import { executionOs } from "../src/folder/platform";
import {
  allowedPresets,
  githubIdentity,
  presetProfile,
} from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import {
  buddyChatRouting,
  buddyPublicationRules,
  networkLine,
  ownSignInIdentity,
  publicationRules,
  questionTool,
  threadsRule,
  visitorsOf,
} from "../src/folder/render";
import { resumeInitialization } from "../src/folder/resume-initialization";
import { updateProfile } from "../src/folder/update-profile";
import { journeys } from "./fixtures/journeys";
import {
  assignments,
  binding,
  bindings,
  entries,
  personalRelationships,
  personalWithEntry,
  withBuddy,
  workRelationships,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";
import { runChild } from "./fixtures/run-child";
import { tryBinding } from "./fixtures/try-environments";

const os = executionOs(process.platform);

// The manual follows the Folder locale under the same file names. Both
// languages are written paragraph by paragraph side by side, so they have the
// same lines and the same sections; only `this-machine.md`, `working-here.md`
// and `troubleshooting.md` differ between presets. Review the snapshots when the
// wording changes deliberately.
test("the manual follows the locale with the same structure in both languages and names no legacy source", () => {
  for (const journey of journeys) {
    const render = (locale: "cs" | "en") =>
      renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
    const cs = render("cs");
    const en = render("en");
    expect(Object.keys(cs)).toEqual(Object.keys(en));
    for (const path of manualPaths) {
      for (const text of [cs[path], en[path]]) {
        expect(text).not.toContain("undefined");
        expect(text.endsWith("\n")).toBe(true);
      }
      expect(cs[path]).not.toEqual(en[path]);
      const lines = { cs: cs[path].split("\n"), en: en[path].split("\n") };
      expect(lines.cs.length).toBe(lines.en.length);
      expect(lines.cs.map((line) => /^#+ /.exec(line)?.[0] ?? "")).toEqual(
        lines.en.map((line) => /^#+ /.exec(line)?.[0] ?? ""),
      );
    }
    expect(cs["manual/lazurio.md"]).toContain("## Co je Lazurio");
    expect(en["manual/lazurio.md"]).toContain("## What Lazurio is");
  }
  // The Platform manual is the authority for an agent on the Machine; it never
  // points at the retired root repository (decision F14).
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      for (const path of outputPaths)
        expect(outputs[path]).not.toMatch(/HumanAndMachines\/Lazurio/);
    }
});

test("device admission and desktop handoff distinguish personal and Organization paths", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const manual = outputs["manual/this-machine.md"];
      expect(manual).toContain("Headscale");
      expect(manual).toContain("Conglomerate Host");
      expect(manual).not.toContain(
        "In the Organization overview check both computers",
      );
      expect(manual).not.toContain(
        "V Přehledu Organizace zkontroluj oba počítače",
      );
      expect(manual).toContain(
        locale === "cs"
          ? "Osobní Prostředí bez tailnetu a SSH"
          : "A personal Environment without tailnet or SSH",
      );
      if (journey.machine !== null) {
        expect(manual).toContain(
          locale === "cs"
            ? "prostě názvem Organizace"
            : "simply be named after the Organization",
        );
        expect(manual).toContain("ChatGPT Desktop");
        expect(outputs["AGENTS.md"]).toContain(
          locale === "cs"
            ? "Připojení počítače a projektu v ChatGPT Desktopu"
            : "Connecting a computer and a ChatGPT Desktop project",
        );
      }
    }
});

// The hosted rules of base-instructions-4: SSH only by tailnet hostname with a
// pinned key, updates by the Machines pin, content sync not in the product.
test("hosted presets carry the SSH and update rules; a workstation keeps its own update path", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const hosted = journey.machine !== null;
      const machine = outputs["manual/this-machine.md"];
      const troubleshooting = outputs["manual/troubleshooting.md"];
      expect(outputs["AGENTS.md"].includes("`100.64.0.x`")).toBe(hosted);
      for (const rule of [
        'HostKeyAlias="$PEER"',
        "known_hosts_lazurio",
        "CurrentTailnet.Name",
        "StrictHostKeyChecking=yes",
        "ssh-keyscan",
      ])
        expect(machine.includes(rule)).toBe(hosted);
      expect(
        troubleshooting.includes(
          locale === "cs"
            ? "Verzi Lazuria na tomhle Environmentu vlastní uživatel."
            : "The user owns the version of Lazurio in this Environment.",
        ),
      ).toBe(hosted);
      // Only the workstation, which may run the supervised unit, names the
      // result after the switch; both say there is no way back.
      expect(troubleshooting.includes("`activation-unhealthy`")).toBe(!hosted);
      expect(
        troubleshooting.includes(
          locale === "cs"
            ? "Cesta zpět neexistuje: Lazurio se nikdy nevrací na dřívější verzi."
            : "There is no way back: Lazurio never returns to an earlier version.",
        ),
      ).toBe(true);
      expect(
        outputs["manual/working-here.md"].includes(
          locale === "cs"
            ? "## Organizace a její manifest"
            : "## The Organization and its manifest",
        ),
      ).toBe(journey.preset !== "hosted-personal");
    }
});

// There is no program rollback (proposed decision F21, recovery-mode
// shaping): no generated text may offer a command, unit or retained version
// that returns to an earlier version, in any preset or locale.
test("no generated output mentions a rollback command or a way back to an earlier version", () => {
  const rollback = [
    /update rollback/i,
    /rollback/i,
    /lazurio-rollback/i,
    /--auto\b/,
    /previous version/i,
    /předchozí verzi/i,
    /\bvrátí? (na|se na)/i,
  ];
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      for (const path of outputPaths)
        for (const pattern of rollback)
          expect([
            journey.preset,
            path,
            locale,
            outputs[path].match(pattern)?.[0] ?? null,
          ]).toEqual([journey.preset, path, locale, null]);
    }
});

// The Operator owns the version of Lazurio and updates it with the one
// updater, on a hosted Machine too; the provider's pin is a minimum (decision
// F17 addendum 2026-09-28). Since the addendum of 2026-10-02 the agent runs the
// update itself, in the background at the start of every piece of work, on
// every preset. No generated text may still forbid the update, wait for the
// Operator to ask for it or hand the version to the pin. Since the addendum of
// 2026-10-30 the update refreshes the Folder itself: every text says so, none
// still has the agent run the refresh after an update, and every text names
// the refresh to run once a blocked one is resolved.
test("no generated output forbids lazurio update or gives the product version to the pin", () => {
  const forbidding = [
    /(do not|don't|never) run `lazurio (update|install)/i,
    /nespouštěj[^.\n]*`lazurio (update|install)/i,
    /owned by the Machines operator's pin/i,
    /pin selects the product release/i,
    /updated by the Machines operator through the pinned release/i,
    /the Machines operator updates the pin/i,
    /vlastní pin provozovatele Machines/i,
    /vybírá release produktu pin/i,
    /pin aktualizuje provozovatel Machines/i,
    /aktualizuje provozovatel Machines \(Machines operator\) přes pinnutý release/i,
    /only when they ask for it/i,
    /jen když o to požádá/i,
    /not on your own initiative/i,
    /ne z vlastní iniciativy/i,
  ];
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      for (const path of outputPaths)
        for (const pattern of forbidding)
          expect([path, locale, pattern.test(outputs[path])]).toEqual([
            path,
            locale,
            false,
          ]);
      const hosted = journey.machine !== null;
      const troubleshooting = outputs["manual/troubleshooting.md"];
      // The update refreshes the Folder itself, on every preset.
      expect(troubleshooting).toMatch(
        locale === "cs"
          ? /`lazurio update[^`]*` po aktualizaci sám obnoví generované soubory/
          : /After an update, `lazurio update[^`]*` itself refreshes/,
      );
      expect(troubleshooting).toContain(
        locale === "cs"
          ? "uživatele o obnovu nežádáš"
          : "never ask the user to refresh anything",
      );
      // A blocked refresh: named for the agent, resolved with the user's
      // consent, then the refresh with its real command.
      expect(troubleshooting).toContain("`folderRefresh`");
      expect(troubleshooting).toContain(
        hosted
          ? "`lazurio machine folder-refresh`"
          : "`lazurio update --folder <Folder>`",
      );
      for (const path of outputPaths)
        for (const stale of [
          /Folder refresh needed/,
          /run it as part of the same update/,
          /spusť ho jako součást téže aktualizace/,
        ])
          expect([path, locale, stale.test(outputs[path])]).toEqual([
            path,
            locale,
            false,
          ]);
    }
});

// From a personal VM the peers are named neutrally from the record: the
// handover says what Headscale lets this Machine reach, not whose a peer is,
// so nothing calls a peer the owner's and every use needs the Operator's
// confirmation.
const peer = (
  name: string,
  kind: string,
  zone: string | null,
  organization: string | null,
  direction: string,
) => ({
  name,
  kind,
  zone,
  organization,
  ssh: { host: `${name}.tailnet.example.invalid`, user: null, direction },
  https: [],
});
test("a personal VM names reachable peers neutrally from the record and requires the Operator's confirmation", () => {
  const profile = presetProfile("hosted-personal", "linux");
  const render = (machine: typeof bindings.personal, locale = profile) =>
    renderManual({ preset: "hosted-personal", machine, profile: locale })[
      "manual/this-machine.md"
    ];
  const section = (text: string) =>
    text.slice(text.indexOf("## From this personal Remote Environment"));
  const related = section(render(bindings.personalRelated));
  expect(related).toContain(
    "Peers this Environment may reach over SSH, exactly as the handover records them:",
  );
  expect(related).toContain(
    "- `example-workspace` (work Remote Environment, work zone, Organization `example`): SSH from here to `example-workspace.tailnet.example.invalid` as `operator`; HTTPS `launchpad.example-workspace.example.lazurio.io`.",
  );
  expect(related).toContain(
    "- `example-laptop` (client device, personal zone): SSH both ways with `example-laptop.tailnet.example.invalid`; no HTTPS.",
  );
  expect(related).toContain(
    "confirm with the user that it is theirs or assigned to them",
  );
  expect(related).not.toMatch(/owner's (work VM|device)/i);
  expect(render(bindings.personalRelated)).toMatchSnapshot();

  // No relationships in the handover: nothing is guessed.
  expect(section(render(bindings.personal))).toContain(
    "The handover records no peer this Environment may reach over SSH; do not look for one, tell the user.",
  );

  // A work VM of a foreign zone, peers of an unknown zone and a client device
  // outside the personal zone are listed exactly as recorded, never as the
  // Operator's; an inbound-only peer is not reachable from here.
  const mixed = section(
    render(
      binding({
        ...personal,
        relationships: {
          zone: "personal",
          peers: [
            peer("example-phone", "client-device", "personal", null, "inbound"),
            peer("foreign-vm", "workspace-vm", "personal", "other", "outbound"),
            peer("unknown-vm", "workspace-vm", null, null, "outbound"),
            peer("unzoned-device", "client-device", null, null, "both"),
            peer("work-laptop", "client-device", "work", "other", "outbound"),
          ],
        },
      }),
    ),
  );
  expect(mixed).not.toContain("example-phone");
  expect(mixed).toContain(
    "- `foreign-vm` (work Remote Environment, personal zone, Organization `other`): SSH from here to `foreign-vm.tailnet.example.invalid`; no HTTPS.",
  );
  expect(mixed).toContain(
    "- `unknown-vm` (work Remote Environment): SSH from here to `unknown-vm.tailnet.example.invalid`; no HTTPS.",
  );
  expect(mixed).toContain(
    "- `unzoned-device` (client device): SSH both ways with `unzoned-device.tailnet.example.invalid`; no HTTPS.",
  );
  expect(mixed).toContain(
    "- `work-laptop` (client device, work zone, Organization `other`): SSH from here to `work-laptop.tailnet.example.invalid`; no HTTPS.",
  );
  expect(mixed).toContain(
    "confirm with the user that it is theirs or assigned to them",
  );
  expect(mixed).not.toMatch(/owner's (work VM|device)/i);

  for (const preset of [
    "hosted-organization-personal",
    "hosted-organization-team",
  ] as const)
    expect(
      renderManual({
        preset,
        machine: bindings.related,
        profile: presetProfile(preset, "linux"),
      })["manual/this-machine.md"],
    ).not.toContain("## From this personal Remote Environment");

  // The same guidance in Czech.
  const cs = render(
    bindings.personalRelated,
    presetProfile("hosted-personal", "linux", { locale: "cs" }),
  );
  expect(cs).toContain("## Z tohohle osobního Remote Environmentu");
  expect(cs).toContain(
    "potvrď s uživatelem, že je jeho nebo že je přiřazený jemu",
  );
  expect(
    cs.slice(cs.indexOf("## Z tohohle osobního Remote Environmentu")),
  ).not.toContain("Ownerov");
  expect(cs).toMatchSnapshot();
});

// The SSH example is runnable shell, with the host-key pin always present.
test("the SSH example is a runnable command with a mandatory host-key pin", async () => {
  for (const locale of ["cs", "en"] as const) {
    const machine = renderManual({
      preset: "hosted-personal",
      machine: bindings.personalRelated,
      profile: presetProfile("hosted-personal", "linux", { locale }),
    })["manual/this-machine.md"];
    const [block = ""] = machine
      .slice(machine.indexOf("  ```sh\n") + 8)
      .split("  ```");
    const script = block
      .split("\n")
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n");
    expect(script).toContain(
      'ssh -o HostKeyAlias="$PEER" -o UserKnownHostsFile="$HOME/.ssh/known_hosts_lazurio" -o StrictHostKeyChecking=yes "$TARGET"',
    );
    const parsed = await runChild(["sh", "-n", "-c", script]);
    expect(parsed.exitCode).toBe(0);
  }
});

for (const journey of journeys.filter((entry) => entry.os !== "windows"))
  test(`rendered manual/this-machine.md snapshot: ${journey.preset}`, () => {
    expect(
      renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os),
      })["manual/this-machine.md"],
    ).toMatchSnapshot();
  });

for (const path of manualPaths.filter((p) => p !== "manual/this-machine.md"))
  test(`rendered ${path} snapshot`, () => {
    expect(
      renderManual({
        preset: "local",
        machine: null,
        profile: presetProfile("local", "linux"),
      })[path],
    ).toMatchSnapshot();
    expect(
      renderManual({
        preset: "local",
        machine: null,
        profile: presetProfile("local", "linux", { locale: "cs" }),
      })[path],
    ).toMatchSnapshot();
  });

// troubleshooting.md on a hosted Machine: updates by the Machines pin.
for (const journey of journeys.filter((entry) => entry.machine !== null))
  for (const locale of ["cs", "en"] as const)
    test(`rendered manual/troubleshooting.md snapshot: ${journey.preset} / ${locale}`, () => {
      expect(
        renderManual({
          preset: journey.preset,
          machine: journey.machine,
          profile: presetProfile(journey.preset, journey.os, { locale }),
        })["manual/troubleshooting.md"],
      ).toMatchSnapshot();
    });

test("this-machine.md renders relationships only when the binding carries them", () => {
  const profile = presetProfile("hosted-organization-personal", "linux");
  const plain = renderManual({
    preset: "hosted-organization-personal",
    machine: bindings.organization,
    profile,
  })["manual/this-machine.md"];
  expect(plain).not.toContain("## Relationships");
  const related = renderManual({
    preset: "hosted-organization-personal",
    machine: bindings.related,
    profile,
  })["manual/this-machine.md"];
  expect(related).toContain("## Relationships");
  expect(related).toContain("this Environment is in the work zone");
  expect(related).toContain(
    "- `example-laptop` (client device, personal zone): SSH to this Environment from `example-laptop.tailnet.example.invalid`; no HTTPS.",
  );
  expect(related).toContain(
    "- `example-gateway` (Conglomerate Host, Organization `example`): no SSH; HTTPS `auth.example.lazurio.io`.",
  );
  expect(related).toMatchSnapshot();
});

test("this-machine.md renders the assignment exactly as the handover carries it", () => {
  const operator = renderManual({
    preset: "hosted-organization-personal",
    machine: bindings.assignedOperator,
    profile: presetProfile("hosted-organization-personal", "linux"),
  })["manual/this-machine.md"];
  expect(operator).toContain(
    "- Assignment: assigned to user `example` (GitHub id 12345).",
  );
  expect(operator).not.toContain("sample-team");
  expect(operator).toMatchSnapshot();
  const team = renderManual({
    preset: "hosted-organization-team",
    machine: bindings.assignedTeam,
    profile: presetProfile("hosted-organization-team", "linux"),
  })["manual/this-machine.md"];
  expect(team).toContain("- Assignment: shared by the Team.");
  expect(team).toContain("Team `sample-team`");
  expect(team).toMatchSnapshot();
});

test.skipIf(process.platform === "win32")(
  "initialization writes the manual with recorded digests; a hand-edited manual file is refused by name and never overwritten",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "manual-")));
    const folder = join(parent, "Lazurio");
    const profile = presetProfile("local", os);
    try {
      await initializeFolder(folder, profile);
      // The six documents and the hidden marker of the initialization.
      expect((await readdir(join(folder, "manual"))).sort()).toEqual(
        [
          ".lazurio-generated",
          ...manualPaths.map((path) => outputFile(folder, path).name),
        ].sort(),
      );
      const manifest = JSON.parse(
        await readFile(join(folder, ".lazurio", "instructions.json"), "utf8"),
      );
      for (const path of outputPaths)
        expect(manifest.outputs[path]).toBe(
          createHash("sha256")
            .update(await readFile(join(folder, path)))
            .digest("hex"),
        );
      // Idempotent: the same inputs change nothing.
      expect(await updateProfile(folder, 1, { profile })).toEqual({
        kind: "unchanged",
      });
      // The manual follows a locale change, under the same file names.
      expect(
        await updateProfile(folder, 1, {
          profile: { ...profile, locale: "cs" },
        }),
      ).toEqual({ kind: "updated", revision: 2 });
      const roles = await readFile(join(folder, "manual", "roles.md"), "utf8");
      expect(roles.startsWith("# Role\n")).toBe(true);
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toContain(
        "## Manuál",
      );
      // An edit is refused with the file's path and preserved.
      await writeFile(
        join(folder, "manual", "roles.md"),
        `${roles}\nMy note\n`,
      );
      expect(await updateProfile(folder, 2, { profile })).toEqual({
        kind: "blocked",
        reason: "drift",
        path: "manual/roles.md",
      });
      expect(await readFile(join(folder, "manual", "roles.md"), "utf8")).toBe(
        `${roles}\nMy note\n`,
      );
      expect(await readdir(join(folder, ".lazurio"))).not.toContain(
        "transaction",
      );
      // A removed file is drift as well; nothing is recreated behind the user.
      await rm(join(folder, "manual", "glossary.md"));
      expect(await updateProfile(folder, 2, { profile })).toEqual({
        kind: "blocked",
        reason: "drift",
        path: "manual/roles.md",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "adoption refuses a foreign manual/ by name, then adopts and resumes with the manual in place",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "manual-adopt-")),
    );
    const folder = join(parent, "Lazurio");
    const source = {
      preset: "hosted-organization-personal" as const,
      machine: bindings.organization,
      profile: presetProfile("hosted-organization-personal", os),
    };
    try {
      await mkdir(folder, { mode: 0o700 });
      await mkdir(join(folder, "organizations"), { mode: 0o700 });
      await mkdir(join(folder, "manual"), { mode: 0o700 });
      await writeFile(join(folder, "manual", "notes.md"), "operator notes");
      await expect(initializeHandoverFolder(folder, source)).rejects.toThrow(
        new FolderAdoptionError("foreign-entry", "manual"),
      );
      expect(await readFile(join(folder, "manual", "notes.md"), "utf8")).toBe(
        "operator notes",
      );
      await rm(join(folder, "manual"), { recursive: true });
      await expect(
        initializeHandoverFolder(folder, source, async (step) => {
          if (step === "manual") throw new Error("interrupted");
        }),
      ).rejects.toThrow("interrupted");
      expect(await resumeInitialization(folder)).toEqual({
        kind: "recovered",
        revision: 1,
      });
      expect(await initializeHandoverFolder(folder, source)).toMatchObject({
        kind: "already-adopted",
        revision: 1,
      });
      const machine = await readFile(
        join(folder, "manual", "this-machine.md"),
        "utf8",
      );
      expect(machine).toContain("hosted-organization-personal");
      expect(machine).toContain(`\`${bindings.organization.name}\``);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

// How the Operator sees an agent's work follows the handover, never a guess
// (decision F14 addendum 2026-10-02). Only ChatGPT Desktop's built-in browser
// reaches a `localhost` port of the Environment, through a tunnel it opens
// itself and that OpenAI does not document; T3 Code and Lazurio MausBot
// forward nothing. Without SSH no client reaches `localhost`; without recorded
// peers the handover's silence is said. A workstation has no such section.
test("previews follow how the Operator connects: only ChatGPT Desktop over SSH reaches localhost, and only through its built-in browser", () => {
  const { team: _, ...owner } = organization.owner;
  const gatewayOnly = binding({
    ...organization,
    owner,
    relationships: {
      zone: "work",
      peers: [
        {
          name: "example-gateway",
          kind: "conglomerate-host",
          zone: null,
          organization: "example",
          ssh: null,
          https: ["auth.example.lazurio.io"],
        },
      ],
    },
  });
  const render = (machine: typeof bindings.related) =>
    renderOutputs({
      preset: "hosted-organization-personal",
      machine,
      profile: presetProfile("hosted-organization-personal", "linux"),
    });
  const overSsh = render(bindings.related);
  expect(overSsh["AGENTS.md"]).toContain(
    "- The user connects here over SSH. Only the built-in browser of ChatGPT Desktop (formerly Codex Desktop) opens `localhost` from here, through a tunnel it opens to the port itself; T3 Code and Lazurio MausBot forward no port.",
  );
  const machine = overSsh["manual/this-machine.md"];
  for (const sentence of [
    "Per the handover, the user connects here over SSH.",
    "works with you in the clients they prefer, possibly several at once: ChatGPT Desktop (formerly Codex Desktop) over SSH, T3 Code on the web or in its desktop app, and Lazurio MausBot.",
    "the user may be working in another one meanwhile.",
    "OpenAI does not document this and older versions cannot do it, so check that the page really loaded.",
    "When you run in T3 Code or Lazurio MausBot, no port reaches the user.",
  ])
    expect(machine).toContain(sentence);
  // The claim the review rejected: forwarding is not a documented fact.
  expect(machine).not.toContain(
    "Codex forwards the port to the operator itself",
  );
  const browserOnly = render(gatewayOnly);
  expect(browserOnly["AGENTS.md"]).toContain(
    "- The user does not connect here over SSH: they cannot open `localhost` from here and no port is forwarded.",
  );
  expect(browserOnly["manual/this-machine.md"]).toContain(
    "the user cannot open them and no client forwards them.",
  );
  expect(browserOnly["manual/this-machine.md"]).not.toContain(
    "built-in browser",
  );
  const unknown = render(bindings.organization);
  expect(unknown["AGENTS.md"]).toContain(
    "- `localhost` exists only here. Only the built-in browser of ChatGPT Desktop (formerly Codex Desktop) connected over SSH opens it",
  );
  expect(unknown["manual/this-machine.md"]).toContain(
    "The handover does not record where the user connects from.",
  );
  for (const journey of journeys)
    expect(
      renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os),
      })["manual/this-machine.md"].includes("## How the user works with you"),
    ).toBe(journey.machine !== null);
});

// A work Environment belongs to the Organization and serves work only; the
// agent says so on a personal request (decision F14 addendum 2026-10-02). A
// personal Remote Environment has no such rule.
test("a work Environment tells the Operator it serves work only", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const machine = renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      })["manual/this-machine.md"];
      expect(
        machine.includes(
          locale === "cs" ? "- **Jen pro práci.**" : "- **Work only.**",
        ),
      ).toBe(journey.machine !== null && journey.preset !== "hosted-personal");
    }
});

// A work product that belongs in no repository goes to the Operator's own
// Documents folder of the OS, never into the Folder (Matěj 2026-10-02: a
// standard folder, not an invented one).
test("work products go to the Documents folder of the execution OS", () => {
  for (const journey of journeys) {
    const agents = renderOutputs({
      preset: journey.preset,
      machine: journey.machine,
      profile: presetProfile(journey.preset, journey.os),
    })["AGENTS.md"];
    expect(agents).toContain(
      journey.os === "windows"
        ? "in the Documents folder (`[Environment]::GetFolderPath('MyDocuments')`)"
        : "in `~/Documents/<task>/`",
    );
    expect(agents).toContain(
      "never write anything at the top level of the Folder",
    );
  }
});

// Decision F35: where the Folder records a hosted entry, the Operator reaches
// the Documents folder through the Launchpad's Files page, so agents hand over
// the link `lazurio files link` prints, never a path. Without an entry (a
// workstation, or a Remote Environment whose handover has none yet) no browser
// reaches that page and agents keep giving the full path.
test("with a hosted entry agents hand over the Files link; without one the full path", () => {
  const organizationOrigin = "https://launchpad.workspace.example.lazurio.io";
  const withEntry = [
    [
      "hosted-personal",
      bindings.personalEntry,
      "https://launchpad.example.lazurio.io",
    ],
    [
      "hosted-organization-personal",
      bindings.organizationEntry,
      organizationOrigin,
    ],
    [
      "hosted-organization-team",
      binding({ ...organization, entry: entries.organization }),
      organizationOrigin,
    ],
    [
      "hosted-organization-steward",
      binding({
        ...organization,
        owner: { ...organization.owner, assignment: assignments.automation },
        entry: entries.organization,
      }),
      organizationOrigin,
    ],
  ] as const;
  for (const [preset, machine, origin] of withEntry)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset,
        machine,
        profile: presetProfile(preset, "linux", { locale }),
      });
      const agents = outputs["AGENTS.md"];
      const manual = outputs["manual/this-machine.md"];
      expect(agents).toContain(
        locale === "cs"
          ? "Uživateli místo cesty předej odkaz, který vypíše `lazurio files link <cesta>`: otevře se mu v prohlížeči a soubor stáhne."
          : "Hand the user the link `lazurio files link <path>` prints instead of the path: it opens in their browser and downloads the file.",
      );
      expect(agents).toContain(`\`${origin}/files\``);
      expect(agents).not.toContain(
        locale === "cs" ? "uveď celou cestu" : "give the full path",
      );
      for (const sentence of locale === "cs"
        ? [
            "nikdy cestu `/home/…`",
            `stránce Soubory Launchpadu (\`${origin}/files\`)`,
            "Odkaz není veřejný: otevře ho jen ten, kdo se na tenhle Environment smí přihlásit.",
            "Soubor mimo `~/Documents` nebo se jménem začínajícím tečkou odkaz nemá",
          ]
        : [
            "never a `/home/…` path",
            `Files page (\`${origin}/files\`)`,
            "The link is not public: only someone who may sign in to this Environment opens it.",
            "A file outside `~/Documents`, or with a name that starts with a dot, has no link",
          ])
        expect(manual).toContain(sentence);
      expect(
        manual.includes(
          locale === "cs"
            ? "společná celému Teamu"
            : "shared by the whole Team",
        ),
      ).toBe(preset === "hosted-organization-team");
    }
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      for (const text of Object.values(outputs))
        expect(text).not.toContain("lazurio files link");
      expect(outputs["AGENTS.md"]).toContain(
        locale === "cs" ? "uveď celou cestu" : "give the full path",
      );
    }
});

// Decision F19 addendum 2026-10-04: where the Folder records a hosted entry,
// an agent sends the Operator to the Launchpad's Settings → Tools for the
// GitHub sign-in (with the Machine's SSH key) and for Composio, and never asks
// for a password, token or code. A Team Environment has the brokered
// Organization identity and an Automated Environment the persona's account,
// so neither is told to sign a person's GitHub account in. Without an entry no
// browser reaches the Launchpad and nothing points there.
test("with a hosted entry agents send the Operator to the Launchpad for sign-ins and connections", () => {
  const organizationOrigin = "https://launchpad.workspace.example.lazurio.io";
  const withEntry = [
    [
      "hosted-personal",
      bindings.personalEntry,
      "https://launchpad.example.lazurio.io",
      "own",
    ],
    [
      "hosted-organization-personal",
      bindings.organizationEntry,
      organizationOrigin,
      "own",
    ],
    [
      "hosted-organization-team",
      binding({ ...organization, entry: entries.organization }),
      organizationOrigin,
      "brokered",
    ],
    [
      "hosted-organization-steward",
      binding({
        ...organization,
        owner: { ...organization.owner, assignment: assignments.automation },
        entry: entries.organization,
      }),
      organizationOrigin,
      "persona",
    ],
  ] as const;
  for (const [preset, machine, origin, github] of withEntry)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset,
        machine,
        profile: presetProfile(preset, "linux", { locale }),
      });
      const cs = locale === "cs";
      const tools = `\`${origin}/settings/tools\``;
      for (const text of [
        outputs["AGENTS.md"],
        outputs["manual/this-machine.md"],
      ]) {
        expect(text).toContain(
          cs
            ? `- Launchpad tohohle Environmentu (uživatelům mu říkej Lazurio; „Lazurio“ i „Launchpad“ od uživatele znamená tuhle stránku) je na \`${origin}\` (Nástroje ${tools}, Soubory \`${origin}/files\`, Integrace \`${origin}/integrations\`): uživatel v něm otevírá aplikace, Soubory, Integrace a Nastavení (ozubené kolo vedle názvu Environmentu).`
            : `- This Environment's Launchpad (call it Lazurio towards users; „Lazurio“ and „Launchpad“ from the user both mean this page) is at \`${origin}\` (Tools ${tools}, Files \`${origin}/files\`, Integrations \`${origin}/integrations\`): there the user opens applications, Files, Integrations and Settings (the gear beside the Environment's name).`,
        );
        expect(text).toContain(
          cs
            ? "a běžíš v ChatGPT Desktopu, otevři mu přesnou adresu v integrovaném prohlížeči ChatGPT Desktopu v panelu vedle chatu; v jiném klientovi mu pošli odkaz. Přihlášení a napojení dělá uživatel sám v Launchpadu; o heslo, token ani kód nežádej."
            : "and you run in ChatGPT Desktop, open the exact address for them in ChatGPT Desktop's built-in browser in the panel beside the chat; in another client, send them the link. The user makes sign-ins and connections in the Launchpad themselves; never ask for a password, token or code.",
        );
        expect(text).toContain(
          cs
            ? "jinou neskládej a nikdy místo nich nedávej `localhost` ani `127.0.0.1`"
            : "never compose another one and never give `localhost` or `127.0.0.1` instead",
        );
        // An app is connected on its Integrace card, by the person (decision
        // F42): the routing names the page, and the agent no longer walks
        // them through Composio's setup.
        expect(text).not.toContain(
          cs
            ? "Když tu Composio zapnuté není"
            : "When Composio is not enabled here",
        );
        expect(text).not.toContain(
          cs
            ? "Aplikace jako Outlook, Teams nebo kalendář"
            : "applications such as Outlook, Teams or a calendar",
        );
        const ownSignIn = cs
          ? `otevři uživateli ${tools} jako výše. U gh klikne na Přihlásit, případně Propojit SSH klíč, a jednorázový kód zadá na github.com; sám ho nepřihlašuj.`
          : `open ${tools} for the user as above. On gh they click Sign in, or Link SSH key, and enter the one-time code on github.com; do not sign them in yourself.`;
        const brokered = cs
          ? "- GitHub: tady jednáš jako brokerovaná identita Organizace (Lazurio for GitHub) a osobní účet GitHubu se sem nepřihlašuje."
          : "- GitHub: here you act as the brokered Organization identity (Lazurio for GitHub), and no personal GitHub account is signed in here.";
        expect(text.includes(ownSignIn)).toBe(github === "own");
        expect(text.includes(brokered)).toBe(github === "brokered");
        expect(
          text.includes(
            cs
              ? "Bez toho nejsou dostupné repozitáře ani aplikace Organizace; po přihlášení aktualizuj checkouty Organizace a modulů (`git pull --ff-only`) a moduly z manifestu Organizace, které tu chybějí a k nimž má uživatel přístup, naklonuj na jejich deklarované místo podle `manual/troubleshooting.md`."
              : "Without it the Organization's repositories and applications are unavailable; after the sign-in, update the checkouts of the Organization and its modules (`git pull --ff-only`) and clone the modules of the Organization's manifest that are missing here and that the user can access into their declared places as `manual/troubleshooting.md` describes.",
          ),
        ).toBe(github === "own" && preset !== "hosted-personal");
      }
    }
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      for (const text of Object.values(outputs)) {
        expect(text).not.toContain("/settings/tools");
        expect(text).not.toContain("/integrations/app/");
      }
    }
});

// Decision F14's addendum of 2026-10-26 (Matěj: "otevři mi chat s Buddym"
// opens Buddy's chat in ChatGPT Desktop's panel beside the chat, as "otevři
// Lazurio" opens the Launchpad there; root decision 0210). Where the recorded
// entry names Buddy's origin (decision F60), which only the person's own
// Osobní Prostředí carries, AGENTS.md and the manual name his chat at exactly
// that address, right after the Launchpad's lines: what the user calls it,
// opened beside the chat in ChatGPT Desktop and linked in another client,
// never in the Environment browser, and never a channel to Buddy. Without his
// origin nothing names it.
test("where the entry names Buddy's origin, agents open his chat for the user beside the chat in ChatGPT Desktop and never write to him", () => {
  const origin = "https://buddy.example.lazurio.io";
  const withOrigin = [
    personalWithEntry(20000, false, false, true),
    personalWithEntry(20000, true, true, true),
    binding({
      ...personal,
      relationships: personalRelationships,
      entry: withBuddy(entries.personal),
    }),
  ];
  const contract = {
    cs: [
      `- Chat s Buddym, jeho konverzace s uživatelem, je na \`${origin}\`.`,
      "Tato adresa pochází z handoveru tohoto Environmentu: jinou neskládej a nikdy místo ní nedávej `localhost` ani `127.0.0.1`.",
      "Otevřená přímo vede rovnou do jeho konverzace.",
      "Když uživatel řekne „chat s Buddym“, „Buddy“ nebo Buddyho jméno (`persona.buddyName` z `lazurio buddy persona --json`), myslí tím tento chat.",
      "Když ho chce a běžíš v ChatGPT Desktopu, otevři mu přesnou adresu v integrovaném prohlížeči ChatGPT Desktopu v panelu vedle chatu; v jiném klientovi mu pošli odkaz.",
      "Přihlašuje se do něj uživatel sám.",
      "V prohlížeči Environmentu ho nikdy neotevírej, ani přes `preview_open`.",
      "Chat otevíráš jen uživateli: nic do něj nepiš a nic v něm nedělej, s Buddym dál nekomunikuješ (root decision 0210).",
      "Chce-li uživatel Buddymu něco říct, otevři mu chat a napíše mu sám.",
    ],
    en: [
      `- Buddy's chat, his conversation with the user, is at \`${origin}\`.`,
      "This address comes from this Environment's handover: never compose another one and never give `localhost` or `127.0.0.1` instead.",
      "Opened directly, it goes straight to his conversation.",
      "When the user says “chat with Buddy”, “Buddy” or Buddy's name (`persona.buddyName` from `lazurio buddy persona --json`), they mean this chat.",
      "When they want it and you run in ChatGPT Desktop, open the exact address for them in ChatGPT Desktop's built-in browser in the panel beside the chat; in another client, send them the link.",
      "The user signs in to it themselves.",
      "Never open it in the Environment browser, not even with `preview_open`.",
      "You open the chat only for the user: write nothing in it and do nothing in it, and you still do not communicate with Buddy (root decision 0210).",
      "When the user wants to tell Buddy something, open the chat for them and they write to him themselves.",
    ],
  } as const;
  const opening = {
    cs: "- Chat s Buddym, jeho konverzace s uživatelem, je na",
    en: "- Buddy's chat, his conversation with the user, is at",
  } as const;
  // The rule that agents never message Buddy stays beside it (root decision
  // 0210, its night addendum of 2026-10-20, point 4).
  const noChannel = {
    cs: "nehledáš cestu, jak mu poslat zprávu nebo ho upozornit",
    en: "do not look for a way to send Buddy a message or notify Buddy",
  } as const;
  for (const machine of withOrigin) {
    expect(machine?.entry?.buddyOrigin).toBe(origin);
    // Every preset where Buddy can exist: a personal VM takes this one only.
    expect(allowedPresets(machine)).toEqual(["hosted-personal"]);
    for (const preset of allowedPresets(machine))
      for (const locale of ["cs", "en"] as const) {
        const outputs = renderOutputs({
          preset,
          machine,
          profile: presetProfile(preset, "linux", { locale }),
        });
        for (const path of ["AGENTS.md", "manual/this-machine.md"] as const) {
          const lines = outputs[path].split("\n");
          const naming = lines.filter((line) => line.includes(origin));
          expect(naming).toEqual([buddyChatRouting(origin)[locale]]);
          const [line = ""] = naming;
          for (const sentence of contract[locale])
            expect(line).toContain(sentence);
          // Right after the Launchpad's lines: the Launchpad, then its
          // GitHub line on the person's own sign-in.
          const at = lines.indexOf(line);
          expect(lines[at - 2]).toStartWith(
            locale === "cs"
              ? "- Launchpad tohohle Environmentu (uživatelům mu říkej Lazurio;"
              : "- This Environment's Launchpad (call it Lazurio towards users;",
          );
          expect(lines[at - 1]).toStartWith("- GitHub: ");
        }
        expect(outputs["AGENTS.md"]).toContain(noChannel[locale]);
        // His origin names his chat and nothing else: no other file of the
        // Folder carries it.
        for (const [path, text] of Object.entries(outputs))
          if (path !== "AGENTS.md" && path !== "manual/this-machine.md")
            expect(text).not.toContain(origin);
      }
  }
  // Without Buddy's origin nothing names his chat: every preset with a hosted
  // entry, with the Environment browser, public and try-01, and every
  // journey without an entry.
  const withoutOrigin = (
    [
      { preset: "hosted-personal", machine: bindings.personalEntry },
      { preset: "hosted-personal", machine: bindings.personalBrowser },
      {
        preset: "hosted-organization-personal",
        machine: bindings.organizationEntry,
      },
      {
        preset: "hosted-organization-personal",
        machine: bindings.organizationBrowser,
      },
      {
        preset: "hosted-organization-personal",
        machine: bindings.organizationPublic,
      },
      { preset: "hosted-organization-personal", machine: tryBinding() },
      { preset: "hosted-organization-team", machine: bindings.teamEntry },
      { preset: "hosted-organization-team", machine: bindings.teamBrowser },
      { preset: "hosted-organization-team", machine: bindings.teamPublic },
      { preset: "hosted-organization-team", machine: tryBinding() },
      {
        preset: "hosted-organization-steward",
        machine: bindings.automatedEntry,
      },
    ] as const
  ).map((environment) => ({ ...environment, os: "linux" as const }));
  for (const { preset, machine, os } of [...withoutOrigin, ...journeys]) {
    expect(machine?.entry?.buddyOrigin).toBeUndefined();
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset,
        machine,
        profile: presetProfile(preset, os, { locale }),
      });
      for (const text of Object.values(outputs)) {
        expect(text).not.toContain("https://buddy.");
        expect(text).not.toContain("lazurio buddy persona");
        expect(text).not.toContain(opening[locale]);
      }
    }
  }
});

// Decision F19 addendum 2026-10-04: the agent clones a missing module of the
// Organization's manifest after the GitHub sign-in. That is the one named
// exception to the rule on clones, in working-here and in the current
// checkouts section alike, with its checks of access, destination and remote,
// so the two never contradict each other. A personal Remote Environment mounts
// no Organization and has neither.
test("a missing module of the manifest is the one exception to the rule on clones, with its checks", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const cs = locale === "cs";
      const organizations = journey.preset !== "hosted-personal";
      expect(
        outputs["manual/working-here.md"].includes(
          cs
            ? "Jedinou výjimkou je modul deklarovaný v manifestu Organizace, který tu chybí: ten naklonuj na jeho deklarované místo. Ten i jiný vnořený repozitář, který už tu leží, řeš podle oddílu o aktuálních checkoutech v `manual/troubleshooting.md`."
            : "The one exception is a module declared in the Organization's manifest that is missing here: clone that one into its declared place. Handle it, and any other nested repository you find here, as the section on current checkouts in `manual/troubleshooting.md` describes.",
        ),
      ).toBe(organizations);
      const troubleshooting = outputs["manual/troubleshooting.md"];
      for (const sentence of cs
        ? [
            "je jedinou výjimkou z pravidla o klonech: je to namountovaný modul, ne vnořený klon.",
            "jen když uživatel k jeho repozitáři živě má přístup (`gh repo view <vlastník>/<repozitář>`) a cílová složka neexistuje nebo je prázdná.",
            "Po klonu ověř, že `git remote get-url origin` je deklarovaný repozitář a checkout stojí na jeho výchozí branchi.",
            "která není modulem z manifestu Organizace",
          ]
        : [
            "is the one exception to the rule on clones: it is a mounted module, not a nested clone.",
            "only when the user has live access to its repository (`gh repo view <owner>/<repository>`) and the destination does not exist or is empty.",
            "After the clone, verify that `git remote get-url origin` is the declared repository and that the checkout is on its default branch.",
            "that is not a module of the Organization's manifest",
          ])
        expect(troubleshooting.includes(sentence)).toBe(organizations);
    }
});

// Decision F17 addendum 2026-10-04: the Operator's request to update is the
// consent for the tools, and above all the agent pulls every Organization and
// module; a personal Remote Environment mounts none, so it updates only
// Lazurio and the tools. Chats are deleted and archived by the Operator in
// their client; the agent never deletes session files.
test("an update the Operator asks for updates the tools and pulls every module; chats are the Operator's to delete", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const cs = locale === "cs";
      const agents = outputs["AGENTS.md"];
      expect(agents).toContain(
        cs
          ? "Když tě uživatel požádá o aktualizaci (třeba „Aktualizuj“), je to souhlas: spusť `lazurio update`"
          : "When the user asks for an update (for example „Aktualizuj“), that is the consent: run `lazurio update`",
      );
      expect(
        agents.includes(
          cs
            ? "a hlavně stáhni změny všech Organizací a modulů"
            : "and above all pull the changes of every Organization and module",
        ),
      ).toBe(journey.preset !== "hosted-personal");
      expect(
        agents.includes(
          cs
            ? "Lazurio (Launchpad) se jim na chvíli restartuje"
            : "Lazurio (the Launchpad) restarts for them for a moment",
        ),
      ).toBe(journey.preset === "hosted-organization-team");
      for (const text of Object.values(outputs))
        expect(text).not.toMatch(
          /Vzdálený chat zatím nejde|A remote chat cannot be deleted/,
        );
    }
});

// People asked how to delete a thread. ChatGPT Desktop offers "Permanently
// delete" in a thread's menu only in Codex mode; in ChatGPT mode the menu only
// archives (observed in the Windows app 2026-10-09, F14 addendum). The chats
// bullet of a Remote Environment says so in both languages, in the personal
// and the Organization variant, unless the handover rules ChatGPT Desktop out;
// a workstation has no such section.
test("the chats bullet tells how to delete a thread in ChatGPT Desktop: only in Codex mode", () => {
  const note = {
    cs: " V ChatGPT Desktopu je v nabídce vlákna (pravé tlačítko na vláknu v postranním panelu) trvalé smazání (Permanently delete) jen v režimu Codex (přepínač vlevo nahoře); v režimu ChatGPT je tam jen archivace (Archive). Když se uživatel ptá, jak vlákno smazat, řekni mu to.",
    en: " In ChatGPT Desktop, a thread's menu (right-click the thread in the sidebar) offers Permanently delete only in Codex mode (the switcher at the top left); in ChatGPT mode it offers only Archive. When someone asks how to delete a thread, tell them.",
  } as const;
  const chats = (
    preset: (typeof journeys)[number]["preset"],
    machine: typeof bindings.related | null,
    locale: "cs" | "en",
    os: (typeof journeys)[number]["os"] = "linux",
  ) => {
    const text = renderManual({
      preset,
      machine,
      profile: presetProfile(preset, os, { locale }),
    })["manual/this-machine.md"];
    return {
      text,
      line: text
        .split("\n")
        .find((line) =>
          line.startsWith(locale === "cs" ? "- **Chaty.**" : "- **Chats.**"),
        ),
    };
  };
  for (const locale of ["cs", "en"] as const) {
    for (const journey of journeys) {
      const { text, line } = chats(
        journey.preset,
        journey.machine,
        locale,
        journey.os,
      );
      if (journey.machine === null) {
        expect(text).not.toContain(note[locale].trim());
        continue;
      }
      expect([journey.preset, locale, line?.endsWith(note[locale])]).toEqual([
        journey.preset,
        locale,
        true,
      ]);
    }
    // The handover records that the Operator connects over SSH.
    expect(
      chats("hosted-organization-personal", bindings.related, locale).line,
    ).toEndWith(note[locale]);
    // The handover records no SSH from the Operator: no ChatGPT Desktop here.
    const { team: _, ...owner } = organization.owner;
    const withoutSsh = binding({
      ...organization,
      owner,
      relationships: {
        zone: "work",
        peers: workRelationships.peers.filter((peer) => peer.ssh === null),
      },
    });
    const { text, line } = chats(
      "hosted-organization-personal",
      withoutSsh,
      locale,
    );
    expect(line).toBeDefined();
    expect(text).not.toContain(note[locale].trim());
  }
});

// Decision F29 addendum (issue #173): doctor's `app-server-outdated` means
// ChatGPT Desktop still talks to an app-server it started outside the unit.
// Replacing it is the Operator's call, never the agent whose own session runs
// under it; only a Remote Environment has the unit.
test("a Remote Environment's troubleshooting manual replaces an outdated Codex app-server only with the Operator's consent", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const troubleshooting = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      })["manual/troubleshooting.md"];
      const hosted = journey.machine !== null;
      for (const sentence of locale === "cs"
        ? [
            "## Codex app-server po aktualizaci Codexu",
            "Když `lazurio doctor` hlásí u `codex-app-server` `warn app-server-outdated`, klienti ChatGPT Desktopu pořád mluví se starším app-serverem (`appServerVersion`), než je nainstalovaný Codex (`cliVersion`).",
            "Výměna na chvíli odpojí chaty ChatGPT Desktopu na tomhle Environmentu, proto je to rozhodnutí uživatele: nejdřív se ho zeptej.",
            "`find ~/.codex/sessions -type f -mmin -15` musí skončit úspěchem a nic nevypsat. Když něco vypíše, je někdo uprostřed práce, počkej; když selže, ticho neověříš, tak nic neukončuj.",
            "Pokračuj jen s právě jedním takovým procesem; když žádný není nebo jich je víc, nic neukončuj a řekni to uživateli.",
            "sám ho neukončuj: ukončil bys vlastní relaci. Řekni uživateli, ať o výměnu požádá z jiného klienta (T3 Code).",
            "- Jinak těsně před ukončením ověř, že PID pořád patří témuž procesu (`ps -o args= -p <pid>` pořád ukazuje `app-server --listen unix://` a `/proc/<pid>/exe` pořád nevede do `~/.codex/packages/app-server-daemon/`); pak ho ukonči `kill -TERM <pid>` a spusť `systemctl --user restart lazurio-codex-app-server.service`.",
            "řekni uživateli, že se ChatGPT Desktop znovu připojí při své další akci.",
          ]
        : [
            "## The Codex app-server after a Codex update",
            "When `lazurio doctor` reports `warn app-server-outdated` for `codex-app-server`, ChatGPT Desktop clients still talk to an app-server (`appServerVersion`) older than the installed Codex (`cliVersion`).",
            "Replacing it briefly disconnects ChatGPT Desktop chats in this Environment, so it is the user's call: ask them first.",
            "`find ~/.codex/sessions -type f -mmin -15` must succeed and print nothing. When it prints something, someone is mid-turn, so wait; when it fails, you cannot confirm the quiet, so end nothing.",
            "Continue only with exactly one such process; when there is none or more than one, end nothing and tell the user.",
            "do not end it yourself: you would end your own session. Tell the user to ask for the replacement from another client (T3 Code).",
            "- Otherwise, right before ending it, check that the PID still belongs to the same process (`ps -o args= -p <pid>` still shows `app-server --listen unix://` and `/proc/<pid>/exe` still does not lead into `~/.codex/packages/app-server-daemon/`); then end it with `kill -TERM <pid>` and run `systemctl --user restart lazurio-codex-app-server.service`.",
            "tell the user that ChatGPT Desktop reconnects on its next action.",
          ])
        expect([
          journey.preset,
          locale,
          sentence,
          troubleshooting.includes(sentence),
        ]).toEqual([journey.preset, locale, sentence, hosted]);
    }
});

// A missing right is escalated to a named administrator on every preset, with
// the assignment as the one exception to the issue mandate, and a refused push
// keeps the work (decision F14 addendum 2026-10-02). Only the Team Environment
// carries the rule of decision F31 (addendum 2026-10-05): the Team's identity
// belongs to no person, so a named person always approves and publishes.
test("missing rights are escalated on every preset; only the Team hands every publication to a named person", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const workingHere = outputs["manual/working-here.md"];
      expect(outputs["AGENTS.md"]).toContain(
        locale === "cs"
          ? "- Když na něco nemáš práva nebo GitHub odmítne push, práci nezahazuj."
          : "- When you lack the rights for something or GitHub refuses a push, never discard the work.",
      );
      for (const sentence of locale === "cs"
        ? [
            "## Když na něco nemáš práva",
            "`gh api \"orgs/<org>/members?role=admin\" --jq '.[].login'`",
            "Přiřazení je tu výslovná výjimka z pravidla o issues výše.",
            "- **Když GitHub odmítne push,** práci nezahazuj",
          ]
        : [
            "## When you lack the rights for something",
            "`gh api \"orgs/<org>/members?role=admin\" --jq '.[].login'`",
            "Assigning is an explicit exception to the issue rule above.",
            "- **When GitHub refuses a push,** never discard the work",
          ])
        expect(workingHere).toContain(sentence);
      const team = journey.preset === "hosted-organization-team";
      for (const sentence of locale === "cs"
        ? [
            "**Na týmovém Environmentu** jednáš na GitHubu jako identita Teamu (Lazurio for GitHub)",
            "Sám nemerguj, ani na pokyn z chatu.",
            "zeptej se uživatele nástrojem na otázky: „Komu mám říct, aby tyhle změny publikoval?“",
          ]
        : [
            "**In a Team Environment** you act on GitHub as the Team's identity (Lazurio for GitHub)",
            "Never merge yourself, not even on an instruction in the chat.",
            "ask the user with the question tool: “Whom should I ask to publish these changes?”",
          ])
        expect([
          journey.preset,
          sentence,
          workingHere.includes(sentence),
        ]).toEqual([journey.preset, sentence, team]);
      // The handoff offers no Publication in the Operator's name and no
      // merge on "Publish" in a Team Environment; elsewhere it does.
      expect([
        journey.preset,
        locale,
        workingHere.includes(
          locale === "cs"
            ? "Mám změny Publikovat vaším jménem? Nebo mám požádat jiného Kolegu o kontrolu a Publikaci?"
            : "Shall I Publish the changes in your name? Or shall I ask another Kolega to review and Publish?",
        ),
        workingHere.includes(
          locale === "cs"
            ? "- Když uživatel Publikaci dovolí (volbou „Publikovat vaším jménem“ v nástroji na otázky, slovem „publikuj“, nebo předem na tento úkol či celé vlákno a neodvolal ji): mergni"
            : "- When the user allows Publication (the option “Publish in your name” in the question tool, the word “publish”, or in advance for this task or the whole thread, not taken back): merge",
        ),
        workingHere.includes(
          locale === "cs"
            ? "- Na týmovém Environmentu nemerguj ani na „Publikuj“ v threadu"
            : "- In a Team Environment never merge, not even on “Publish” in the thread",
        ),
      ]).toEqual([journey.preset, locale, !team, !team, team]);
      // AGENTS.md says it too, after the Publication block every preset
      // shares.
      expect(
        outputs["AGENTS.md"].includes(
          `${publicationRules.map((line) => line[locale]).join("\n")}\n${
            locale === "cs"
              ? "- Pull request z týmového Environmentu vždy schválí a publikuje jmenovaný uživatel a odpovídá za něj; sám nemerguj, ani na „Publikuj“."
              : "- A named user always approves and publishes a pull request from a Team Environment and answers for it; never merge yourself, not even on “Publish”."
          }`,
        ),
      ).toBe(team);
      expect(
        outputs["AGENTS.md"].includes(
          locale === "cs"
            ? "Na týmovém Environmentu dopadne aktualizace na všechny jeho uživatele"
            : "On a Team Environment an update affects all its users",
        ),
      ).toBe(journey.preset === "hosted-organization-team");
    }
});

// Root decision 0211 (decision F14 addendum 2026-10-20): an agent asks a
// person through its harness's question tool, because a question left in the
// text of a message is missed while the thread looks busy. AGENTS.md states
// the rule once on every preset, public ones too, right after the line on how
// to report. The handoff block of `manual/working-here.md` stays text and ends
// before the closing question, which the agent asks with the tool: the pair
// with its two options and neither recommended, on a Team Environment “whom
// should I ask”, and without the tool in text, saying that it waits.
test("agents ask people through the harness's question tool, and the handoff's closing question goes through it (root decision 0211)", () => {
  const environments = [
    ...journeys,
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
  ] as const;
  for (const environment of environments)
    for (const locale of ["cs", "en"] as const) {
      const cs = locale === "cs";
      const outputs = renderOutputs({
        preset: environment.preset,
        machine: environment.machine,
        profile: presetProfile(environment.preset, environment.os, { locale }),
      });
      const where = [environment.preset, environment.machine?.name, locale];
      const lines = outputs["AGENTS.md"].split("\n");
      const rule = questionTool[locale];
      expect([...where, lines.filter((line) => line === rule).length]).toEqual([
        ...where,
        1,
      ]);
      expect([...where, lines[lines.indexOf(rule) - 1]]).toEqual([
        ...where,
        cs
          ? "- Začni výsledkem a vysvětluj stručně."
          : "- Lead with the outcome and explain concisely.",
      ]);
      for (const part of cs
        ? [
            "zeptej se nástrojem svého harnessu na otázky (Claude Code `AskUserQuestion`, Codex `request_user_input`, Hermes `clarify`), ne jen textem ve zprávě",
            // Root decision 0211, addendum of 2026-10-24: a request that the
            // user does something is a question too.
            "Stejně polož i žádost, aby uživatel něco udělal (zadal ověřovací kód, přihlásil se, něco potvrdil nebo zkontroloval)",
            "s odkazem, kódem a do kdy platí",
            "Otázka v T3 Code i v Codex Desktopu vyskočí jako upozornění, text ve zprávě ne.",
            "Nabídni 2–4 volby, doporučenou první s označením „(Doporučeno)“, a kontext napiš do zprávy nad otázku.",
            "Nejdřív udělej všechno, co na odpovědi nezávisí",
            "Volba Publikace, kterou uživatel v nástroji udělá, je jeho výslovný pokyn k Publikaci v aktuálním threadu, stejně jako „Publikuj“.",
            "Nemá-li harness nástroj na otázky nebo ho v aktuálním režimu nenabízí, zeptej se textem s očíslovanými volbami a napiš, že čekáš na odpověď",
            "Běžíš-li jako subagent, bot Lazurio MausBotu nebo automatický reviewer, uživatele v relaci nemáš: nástroj nepoužij a otázku předej ve svém výstupu tomu, kdo ti práci zadal",
          ]
        : [
            "ask through your harness's question tool (Claude Code `AskUserQuestion`, Codex `request_user_input`, Hermes `clarify`), not only in the text of a message",
            "Ask the same way when you need the user to do something (enter a verification code, sign in, confirm or check something)",
            "with the link, the code and until when it is valid",
            "A question pops up as a notification in T3 Code and in Codex Desktop; text in a message does not.",
            "Offer 2–4 options, the recommended one first marked “(Recommended)”, and write the context in the message above the question.",
            "First do everything that does not depend on the answer",
            "A choice of Publication the user makes in the tool is their explicit instruction to Publish in the current thread, just like “Publish”.",
            "When the harness has no question tool or does not offer it in the current mode, ask in text with numbered options and say that you are waiting for the answer",
            "When you run as a subagent, a Lazurio MausBot bot or an automated reviewer, there is no user in your session: do not use the tool, and pass the question in your output to whoever gave you the work",
          ])
        expect(rule).toContain(part);
      // The handoff block is text and holds no question any more.
      const workingHere = outputs["manual/working-here.md"];
      const opening = "```text\n## Handoff\n";
      const start = workingHere.indexOf(opening);
      const end = workingHere.indexOf("\n```\n", start + opening.length);
      expect([...where, start > 0, end > start]).toEqual([
        ...where,
        true,
        true,
      ]);
      expect(workingHere.slice(start, end)).toEndWith(
        cs
          ? "Lokálně nezůstává nic mimo PR."
          : "Nothing remains locally outside the PR.",
      );
      const after = workingHere.slice(end);
      const team = environment.preset === "hosted-organization-team";
      const pair = cs
        ? "Hned pod ním polož nástrojem na otázky (decision 0211) standardizovanou dvojotázku „Mám změny Publikovat vaším jménem? Nebo mám požádat jiného Kolegu o kontrolu a Publikaci?“ s volbami „Publikovat vaším jménem“ a „Požádat jiného Kolegu“. Žádnou z nich neoznačuj jako doporučenou: volbu vždy nabídni a nikdy ji nerozhoduj za uživatele. Bez nástroje na otázky napiš dvojotázku pod blok jako očíslované volby a dodej, že čekáš na odpověď."
        : "Right below it ask the standardized pair with the question tool (decision 0211): “Shall I Publish the changes in your name? Or shall I ask another Kolega to review and Publish?”, with the options “Publish in your name” and “Ask another Kolega”. Mark neither of them as recommended: always offer the choice and never decide it for the user. Without a question tool write the pair below the block as numbered options and add that you are waiting for the answer.";
      const whom = cs
        ? "Hned pod ním polož nástrojem na otázky (decision 0211) otázku „Komu mám říct, aby tyhle změny publikoval?“; bez nástroje na otázky ji napiš pod blok a dodej, že čekáš na odpověď."
        : "Right below it ask with the question tool (decision 0211): “Whom should I ask to publish these changes?”; without a question tool write it below the block and add that you are waiting for the answer.";
      expect([...where, after.includes(pair), after.includes(whom)]).toEqual([
        ...where,
        !team,
        team,
      ]);
      // The next step after a Publication is the agent's own question.
      expect(after).toContain(
        cs
          ? "- Po každé Publikaci si polož otázku „jaký je další krok a co dalšího můžeme dotáhnout?“ a odpověď stručně navrhni uživateli."
          : "- After every Publication ask yourself “what is the next step and what else can we finish?” and propose the answer to the user briefly.",
      );
      // A Team Environment's AGENTS.md asks “whom” with the tool too.
      expect([
        ...where,
        outputs["AGENTS.md"].includes(
          cs
            ? "zeptej se uživatele nástrojem na otázky „Komu mám říct, aby tyhle změny publikoval?“ a tomu uživateli předej pull request."
            : "ask the user with the question tool “Whom should I ask to publish these changes?” and hand that user the pull request.",
        ),
      ]).toEqual([
        ...where,
        team && environment.machine !== bindings.teamPublic,
      ]);
    }
});

// A chat whose client runs Codex in a sandbox without network fails every
// network call, so a connected application looks broken (issue #264). On
// every preset, Codex can be sandboxed on a workstation too, AGENTS.md has the
// agent check `CODEX_SANDBOX_NETWORK_DISABLED` right after the full-access
// rule and ask the person to switch the chat to full access, and the
// troubleshooting manual says why (decision F14 addendum 2026-10-08).
test("a chat without network asks for full access instead of reporting the application as broken, on every preset", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const cs = locale === "cs";
      const lines = outputs["AGENTS.md"].split("\n");
      const fullAccess = lines.indexOf(
        cs
          ? "- Pracuješ s plným přístupem, bez sandboxu a bez schvalování jednotlivých příkazů; hranicí je tenhle Environment (decision 0172). Je to schopnost, ne souhlas: Publikace a zápisy do napojených aplikací dál čekají na pokyn uživatele."
          : "- You work with full access, without a sandbox and without per-command approvals; this Environment is the boundary (decision 0172). It is a capability, not consent: Publication and writes to connected applications still wait for the user's instruction.",
      );
      const rule = cs
        ? "- Než použiješ cokoli, co potřebuje internet (Integrace přes Executor nebo Composio, `gh`, stahování, `git fetch` nebo `git push`), ověř proměnnou `CODEX_SANDBOX_NETWORK_DISABLED`. Když je `1`, běží chat v sandboxu bez sítě: nic nezkoušej, aplikaci nehlas jako odpojenou, nedostupnou ani s vypršeným časem a řekni uživateli srozumitelně v jeho jazyce, co má udělat; česky: „Abych se dostal k <čemu>, potřebuji plný přístup. Dole u pole pro zprávu přepněte prosím oprávnění na Plný přístup a napište mi znovu.“ Chyba sítě nebo vypršený čas v chatu s plným přístupem zůstává běžnou chybou (`manual/troubleshooting.md`)."
        : "- Before you use anything that needs the internet (Integrations through Executor or Composio, `gh`, downloads, `git fetch` or `git push`), check `CODEX_SANDBOX_NETWORK_DISABLED`. When it is `1`, the chat runs in a sandbox without network: do not try, do not report the application as disconnected, unavailable or timed out, and tell the user plainly, in their language, what to do; in English: “To reach <what>, I need full access. Please switch the permission below the message box to Full access and send me your message again.” A network error or timeout in a chat with full access stays an ordinary error (`manual/troubleshooting.md`).";
      expect([journey.preset, locale, fullAccess > 0]).toEqual([
        journey.preset,
        locale,
        true,
      ]);
      expect([journey.preset, locale, lines[fullAccess + 1]]).toEqual([
        journey.preset,
        locale,
        rule,
      ]);
      expect(lines.filter((line) => line === rule)).toHaveLength(1);
      const troubleshooting = outputs["manual/troubleshooting.md"];
      for (const sentence of cs
        ? [
            "## Chat bez sítě",
            "Agenti na Environmentu pracují s plným přístupem (decision 0172); sandbox bez sítě je volba klienta pro jednotlivý chat.",
            "Codex v něm každému příkazu nastaví `CODEX_SANDBOX_NETWORK_DISABLED=1`",
            "o přepnutí chatu na Plný přístup požádej uživatele podle `AGENTS.md`. Bez té proměnné je chyba sítě běžná chyba.",
          ]
        : [
            "## A chat without network",
            "Agents in an Environment work with full access (decision 0172); a sandbox without network is the client's choice for a single chat.",
            "In it Codex sets `CODEX_SANDBOX_NETWORK_DISABLED=1` for every command",
            "ask the user to switch the chat to Full access as `AGENTS.md` says. Without that variable a network error is an ordinary error.",
          ])
        expect([
          journey.preset,
          locale,
          troubleshooting.includes(sentence),
        ]).toEqual([journey.preset, locale, true]);
      // The section sits right before the reporting of problems.
      expect(
        troubleshooting.indexOf(
          cs ? "## Chat bez sítě" : "## A chat without network",
        ),
      ).toBeLessThan(
        troubleshooting.indexOf(
          cs ? "## Hlášení problémů" : "## Reporting problems",
        ),
      );
    }
});

// How a secret reaches the agents (root decision 0198 point 9, DEV-6631 task
// 652): never through chat or a file. On a Remote Environment the manual
// gives the order a, b, c and the enabled `bitwarden` tool the commands; this
// computer has no vault yet, so its manual names none.
test("secrets reach agents by the paths a, b and c on a Remote Environment, never through chat or a file", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
        tools: journey.preset === "local" ? [] : ["bitwarden"],
      });
      const working = outputs["manual/working-here.md"];
      const machine = outputs["manual/this-machine.md"];
      expect(working).toContain(
        locale === "cs"
          ? "**O tajemství nikdy nežádej v chatu** a neber ho ze souboru ani ze zprávy."
          : "**Never ask for a secret in chat,** and never take one from a file or a message.",
      );
      if (journey.preset === "local") {
        expect(working).not.toContain("lazurio vault");
        continue;
      }
      // The manual: the vault's state checked again, then a, b and c in
      // this order.
      const steps = [
        "`lazurio vault status`",
        locale === "cs"
          ? "rozšíření Bitwarden, požádej uživatele, ať se ke službě přihlásí tam"
          : "has the Bitwarden extension, ask the user to sign in to the service there",
        locale === "cs"
          ? "vytvořit sám v přihlášené relaci"
          : "create the secret yourself in a signed-in session",
        "`lazurio vault request`",
        "`lazurio vault request status <id>`",
      ].map((step) => working.indexOf(step));
      expect([journey.preset, locale, steps.includes(-1)]).toEqual([
        journey.preset,
        locale,
        false,
      ]);
      expect(steps).toEqual([...steps].sort((a, b) => a - b));
      // The tool: the commands of each path, the item never on argv.
      for (const command of [
        "`lazurio vault status`",
        'eval "$(lazurio vault env)"',
        "`bw create item`",
        "`lazurio vault request --item",
        "--field <",
        "`lazurio vault request status <id>`",
      ])
        expect([locale, command, machine.includes(command)]).toEqual([
          locale,
          command,
          true,
        ]);
      expect(machine).toContain(
        locale === "cs" ? "nikdy jako argument" : "never as an argument",
      );
    }
});

// Where a secret belongs on an Organization's Environment (root decision
// 0203's addendum of 2026-10-20, F54's note of the same day): the intent
// first, the three kinds of vault, collections never the boundary, the words
// for people, how an Environment joins a shared vault, and a supplier's bulk
// file as the fourth path, the one file a secret comes from, named an
// exception to the tool `bitwarden`'s same rule too, whose text stays one for
// every Environment. A Team or Automated Environment adds nobody to its
// vault, and everyone who enters it has its passwords. A personal
// Environment (its person's own Bitwarden), a public Environment (no vault)
// and this computer keep their text without the kinds.
test("an Organization's Environment asks who needs a secret before it names one of three kinds of vault; a personal or public Environment and this computer do not", () => {
  const cases = [
    { preset: "local", machine: null, os: "macos", kinds: false },
    {
      preset: "hosted-personal",
      machine: bindings.personal,
      os: "linux",
      kinds: false,
    },
    {
      preset: "hosted-organization-personal",
      machine: bindings.organization,
      os: "linux",
      kinds: true,
      agentsOnly: false,
    },
    {
      preset: "hosted-organization-team",
      machine: bindings.team,
      os: "linux",
      kinds: true,
      agentsOnly: true,
    },
    {
      preset: "hosted-organization-steward",
      machine: bindings.automated,
      os: "linux",
      kinds: true,
      agentsOnly: true,
    },
    {
      preset: "hosted-organization-personal",
      machine: bindings.organizationPublic,
      os: "linux",
      kinds: false,
    },
    {
      preset: "hosted-organization-team",
      machine: bindings.teamPublic,
      os: "linux",
      kinds: false,
    },
  ] as const;
  for (const [index, entry] of cases.entries())
    for (const locale of ["cs", "en"] as const) {
      const cs = locale === "cs";
      const outputs = renderOutputs({
        preset: entry.preset,
        machine: entry.machine,
        profile: presetProfile(entry.preset, entry.os, { locale }),
        tools: entry.preset === "local" ? [] : ["bitwarden"],
      });
      const working = outputs["manual/working-here.md"];
      const heading = cs ? "## Tajné údaje" : "## Secrets";
      const start = working.indexOf(heading);
      const section = working.slice(
        start,
        working.indexOf("\n## ", start + heading.length),
      );
      const where = [index, entry.preset, locale] as const;
      // In this order: the intent, the three kinds, the drawer, the words
      // for people, the shared vault through the Admin with the account's
      // address from the status (the page does not show it yet), what
      // removal leaves, then the paths with d last.
      const rules = cs
        ? [
            "**Kam tajemství patří: nejdřív se zeptej na záměr.**",
            "zjisti, kdo ho potřebuje (jen uživatelé, agenti tohoto Environmentu, nebo agenti víc Environmentů) a kdo ho mění",
            "**Trezor Organizace** je jen pro uživatele",
            "**Trezor Prostředí**",
            "**Sdílený trezor pro účel**",
            "Firemní ani osobní hesla do něj nepatří.",
            "**Kolekce je šuplík, ne zámek.**",
            "Přístup kolekcemi nikdy neodděluj",
            "„Není trezor jako trezor.",
            "**Do sdíleného trezoru Environment přizve jen Admin Organizace.**",
            "`lazurio vault status --json` v poli `account`; stránka Trezor ji zatím neukazuje",
            "co si agenti mezitím stáhli nebo použili, jim zůstane",
            "  - (a) ",
            "  - (b) ",
            "  - (c) ",
            "Žádost ukládá jen do Trezoru Prostředí",
            "  - (d) Dodal-li dodavatel tajemství hromadně v souboru",
            "(Apps → Soubory, uloží se do `~/Documents/`), nikdy do chatu",
            "a soubor hned smaž",
            "ber jen `id`",
            "Aplikace berou tajné údaje jen z Trezoru Prostředí, ne ze sdíleného trezoru",
          ]
        : [
            "**Where a secret belongs: ask about the intent first.**",
            "find out who needs it (users only, this Environment's agents, or the agents of several Environments) and who changes it",
            "**The Organization vault** is for users only",
            "**The Environment vault**",
            "**A shared vault for a purpose**",
            "Company and personal passwords do not belong in it.",
            "**A collection is a drawer, not a lock.**",
            "Never separate access by collections",
            "“Not every vault is the same.",
            "**Only the Organization's Admin brings an Environment into a shared vault.**",
            "`lazurio vault status --json` prints the account's address as `account`; the Vault page does not show it yet",
            "what agents fetched or used meanwhile stays with them",
            "  - (a) ",
            "  - (b) ",
            "  - (c) ",
            "A request saves into the Environment vault only",
            "  - (d) When a supplier delivered secrets in bulk in a file",
            "(Apps → Files, which saves it into `~/Documents/`), never into chat",
            "and delete the file right away",
            "take only the `id`",
            "Applications take secrets only from the Environment vault, not from a shared vault",
          ];
      const exception = cs
        ? "a neber ho ze souboru ani ze zprávy. Jedinou výjimkou, i ze stejného pravidla u nástroje `bitwarden`, je hromadný soubor od dodavatele, cesta (d) níže."
        : "and never take one from a file or a message. The one exception, also to the same rule of the tool `bitwarden`, is a supplier's bulk file, path (d) below.";
      expect([...where, start > 0]).toEqual([...where, true]);
      if (!entry.kinds) {
        // The paths a, b and c stay where a vault is; nothing of the kinds.
        expect([
          ...where,
          rules.filter(
            (rule) =>
              !/^ {2}- \([abc]\) $/.test(rule) && section.includes(rule),
          ),
        ]).toEqual([...where, []]);
        expect([...where, section.includes(exception)]).toEqual([
          ...where,
          false,
        ]);
        continue;
      }
      const at = rules.map((rule) => section.indexOf(rule));
      expect([...where, rules.filter((_, i) => at[i] === -1)]).toEqual([
        ...where,
        [],
      ]);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect([...where, section.includes(exception)]).toEqual([...where, true]);
      // Who uses this Environment's vault: its agents and the people with
      // access to it, or on a Team or Automated Environment its agents only.
      const agentsOnly = cs
        ? [
            "uživatele do něj tenhle Environment zatím nepřidává, ale jeho hesla má každý, kdo do Environmentu vstoupí",
            "Trezor tohoto Prostředí používají jeho agenti a jeho hesla vidí každý, kdo do Prostředí vstoupí.",
          ]
        : [
            "this Environment adds no users to it yet, but everyone who enters this Environment has its passwords",
            "This Environment's vault is used by its agents, and everyone who enters this Environment sees its passwords.",
          ];
      const withPeople = cs
        ? [
            "je pro agenty tohoto Environmentu a uživatele s přístupem do něj",
            "Trezor tohoto Prostředí používají jeho agenti a uživatelé, kteří do Prostředí mají přístup.",
          ]
        : [
            "is for this Environment's agents and the users with access to it",
            "This Environment's vault is used by its agents and the users who have access to this Environment.",
          ];
      expect([
        ...where,
        agentsOnly.map((text) => section.includes(text)),
        withPeople.map((text) => section.includes(text)),
      ]).toEqual([
        ...where,
        agentsOnly.map(() => entry.agentsOnly),
        withPeople.map(() => !entry.agentsOnly),
      ]);
    }
});

// Matěj's decisions of 2026-10-24 (decision F14's addendum of that day), on
// every preset and both public Environments, in both locales, over every
// generated file and Buddy's layer:
// - "Draft" is no Lazurio term (it collides with GitHub's Draft PR); only
//   GitHub's own Draft PR keeps the word, and Publication stays as defined;
// - the pull-request lifecycle: a Draft PR where the repository's GitHub plan
//   allows one, else a normal pull request that says it is in progress, then
//   marked ready after verification;
// - GitHub is the authority for source code, the Lazurio account holds entry
//   and Headscale the network (root decision 0192); no text says GitHub is
//   the only access authority;
// - "AI Kolega" and the AI seat are gone, and so is the retired name
//   "Automated Environment": an Environment with automations is an ordinary
//   work Environment named Henry, which the glossary says once (root decision
//   0170, addendum of 2026-10-19);
// - the Git and GitHub rules and the fork guidance in the manual, with one
//   pointer in AGENTS.md wherever something can be merged or pushed;
// - the safe habits: disk space only with certainty, a time from `date -u`,
//   nothing that must survive in `/tmp` (not on Windows), and on a macOS
//   workstation the missing `timeout`.
test("the agent's work is a pull request, GitHub is the authority for source code, and every agent has the Git, fork and safety rules (decisions of 2026-10-24)", () => {
  const environments = [
    ...journeys,
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
  ] as const;
  const retired = [
    // The Lazurio term "Draft", in any form; GitHub's own Draft pull request
    // and its Draft state stay ("Draft PR", "Draft pull request", „z Draftu
    // na Ready“, "from Draft to Ready" in the Publication block, F14 addendum
    // of 2026-10-28).
    /\bDraft(?!(?: PR| pull request|u na Ready| to Ready)\b)/,
    /\bAI[ -]Koleg/i,
    /\bAI colleague/i,
    /\bAI seat/i,
    /jediná autorita přístupů|only access authority/i,
    /automatizovan\p{L}* Environment|\bautomated Environment/iu,
    /přístupy určuje GitHub|GitHub decides (?:access|membership)/i,
  ];
  for (const environment of environments)
    for (const locale of ["cs", "en"] as const) {
      const cs = locale === "cs";
      const composition = {
        preset: environment.preset,
        machine: environment.machine,
        profile: presetProfile(environment.preset, environment.os, { locale }),
      };
      const outputs = renderOutputs(composition);
      const layer = renderBuddyLayer(composition);
      const where = [environment.preset, environment.os, locale];
      const identity = githubIdentity(environment.preset, environment.machine);
      const isPublic = identity === "none";
      const clock =
        environment.os === "windows"
          ? "`[DateTime]::UtcNow.ToString('u')`"
          : "`date -u`";
      for (const [path, text] of [
        ...Object.entries(outputs),
        ...buddyLayerPaths.map((path) => [path, layer[path]] as const),
      ])
        for (const pattern of retired)
          expect([...where, path, pattern.exec(text)?.[0] ?? null]).toEqual([
            ...where,
            path,
            null,
          ]);

      const agents = outputs["AGENTS.md"];
      const workingHere = outputs["manual/working-here.md"];
      // The glossary says once what a Henry Environment is.
      const henry = outputs["manual/glossary.md"]
        .split("\n")
        .filter((line) =>
          line.startsWith(
            cs ? "| Environment Henry |" : "| Henry Environment |",
          ),
        );
      expect([
        ...where,
        henry.length,
        henry.every((line) =>
          line.includes(
            cs
              ? "Obyčejný pracovní Environment Organizace s nastavenými automatizacemi"
              : "An ordinary work Environment of an Organization with automations set up",
          ),
        ),
        henry.every((line) => line.includes("0170")),
      ]).toEqual([...where, 1, true, true]);
      // Publication stays exactly as defined, and the user allows it (the
      // Publication block, F14 addendum of 2026-10-28).
      for (const sentence of cs
        ? [
            "- **Publikace** je akt, kterým se tvoje práce stává těžko vratnou nebo viditelnou navenek: merge, odeslání, nasazení;",
            "- Publikuješ, až když ti to uživatel dovolí, třeba slovem „publikuj“.",
            "e-mail uložený jako koncept",
          ]
        : [
            "- **Publication** is the act that makes your work hard to revert or visible outside: a merge, sending, deploying;",
            "- Publish only once the user allows it, for example with the word “publish”.",
            "an e-mail saved as a draft",
          ])
        expect([...where, sentence, workingHere.includes(sentence)]).toEqual([
          ...where,
          sentence,
          true,
        ]);
      // The lifecycle follows what the repository's GitHub plan allows.
      for (const sentence of cs
        ? [
            "jako GitHub Draft PR (`gh pr create --draft`), kde ho plán GitHubu pro repozitář dovoluje",
            "otevři běžný pull request a v jeho popisu napiš, že je rozpracovaný",
            "Draft PR přepneš na Ready for review (`gh pr ready`), u běžného pull requestu to napíšeš do jeho popisu",
          ]
        : [
            "as a GitHub Draft PR (`gh pr create --draft`) where the repository's GitHub plan allows one",
            "open a normal pull request and say in its description that it is in progress",
            "a Draft PR you switch to Ready for review (`gh pr ready`), and for a normal pull request you say so in its description",
          ])
        expect([...where, sentence, workingHere.includes(sentence)]).toEqual([
          ...where,
          sentence,
          true,
        ]);
      // GitHub for source code, the Lazurio account for entry, Headscale for
      // the network: in the identity line where the user's own sign-ins are
      // used, and in full in `manual/lazurio.md`.
      expect([
        ...where,
        agents.includes(ownSignInIdentity[locale]),
        outputs["manual/this-machine.md"].includes(ownSignInIdentity[locale]),
      ]).toEqual([
        ...where,
        identity === "own-sign-in",
        identity === "own-sign-in",
      ]);
      for (const sentence of cs
        ? [
            "- **Každý přístup má svou autoritu.** O zdrojovém kódu rozhoduje GitHub",
            "Vstup do Environmentů a jejich aplikací drží Lazurio účet, členství v Organizaci a konkrétní grant",
            "Žádné druhé, vymyšlené ACL neexistuje",
            "## Kdo rozhoduje o přístupu",
          ]
        : [
            "- **Every access has its own authority.** GitHub decides on source code",
            "Entry to Environments and their applications is held by the Lazurio account, membership in the Organization and the exact grant",
            "There is no second, invented ACL",
            "## Who decides access",
          ])
        expect([
          ...where,
          sentence,
          outputs["manual/lazurio.md"].includes(sentence),
        ]).toEqual([...where, sentence, true]);
      // The Git and GitHub rules and the fork guidance, in the manual.
      for (const sentence of cs
        ? [
            "## Git a GitHub",
            "samotné `reviewDecision` není důkaz",
            "`gh pr merge <číslo> --match-head-commit <sha headu>`",
            "Na soubor v konfliktu nikdy nepoužívej `git checkout --ours` ani `--theirs`",
            "(`--body-file <soubor>`, krátce `-F <soubor>`), nikdy v uvozovkách přímo v příkazu",
            "`gh pr edit <číslo> --base main`",
            "### Fork",
            "- **Distribuční fork** je tenká vrstva nad přesným releasem upstreamu.",
            "- **Plný fork** jde vlastním směrem",
            "- **Nejdřív model Lazuria.**",
            "`git log --oneline <nová>..<stará>`",
          ]
        : [
            "## Git and GitHub",
            "`reviewDecision` alone is no proof",
            "`gh pr merge <number> --match-head-commit <head sha>`",
            "Never run `git checkout --ours` or `--theirs` on a conflicted file",
            "(`--body-file <file>`, short `-F <file>`), never in quotes inside the command",
            "`gh pr edit <number> --base main`",
            "### A fork",
            "- **A distribution fork** is a thin overlay on an exact upstream release.",
            "- **A full fork** follows its own direction",
            "- **The Lazurio model first.**",
            "`git log --oneline <new>..<old>`",
          ])
        expect([...where, sentence, workingHere.includes(sentence)]).toEqual([
          ...where,
          sentence,
          true,
        ]);
      // One pointer in AGENTS.md, wherever something can be merged or pushed.
      expect([
        ...where,
        agents.includes(
          cs
            ? "se řiď oddílem Git a GitHub v `manual/working-here.md`."
            : "follow the section Git and GitHub in `manual/working-here.md`.",
        ),
      ]).toEqual([...where, !isPublic]);
      // The safe habits: in AGENTS.md in one line, in the manual in full.
      for (const [text, sentence] of cs
        ? ([
            [
              agents,
              "- Místo na disku uvolňuj jen tím, o čem víš jistě, že se nepoužívá;",
            ],
            [
              agents,
              `Než zapíšeš čas do PR, plánu nebo poznámky, spusť ${clock}`,
            ],
            [workingHere, "- **Místo na disku jen s jistotou.**"],
            [workingHere, "- **Čas podle hodin.**"],
          ] as const)
        : ([
            [
              agents,
              "- Free disk space only with what you know for certain is unused;",
            ],
            [
              agents,
              `Before you write a time into a PR, a plan or a note, run ${clock}`,
            ],
            [workingHere, "- **Disk space only with certainty.**"],
            [workingHere, "- **Time from the clock.**"],
          ] as const))
        expect([...where, sentence, text.includes(sentence)]).toEqual([
          ...where,
          sentence,
          true,
        ]);
      expect([
        ...where,
        agents.includes("`/tmp`"),
        agents.includes(
          cs
            ? "- macOS sám příkaz `timeout` nemá"
            : "- macOS itself has no `timeout` command",
        ),
      ]).toEqual([
        ...where,
        environment.os !== "windows",
        environment.preset === "local" && environment.os === "macos",
      ]);
    }
});

// Decision F14's addendum of 2026-10-28: Publication as one block in the
// Owner's words replaces the rule and its scope line of 2026-10-27. The whole
// block is in AGENTS.md on every Environment but a public one and in the
// manual's Publication section; Buddy, who delegates and does not code, and a
// public Environment's manual get the bullets from the definition on. Each
// appears once and in one piece, a Team Environment's merge line follows the
// block, and no generated file keeps an earlier wording.
test("Publication is one block in the Owner's words in AGENTS.md, the manual and Buddy's rules, and the earlier wordings are gone (F14 addendum of 2026-10-28)", () => {
  const environments = [
    ...journeys,
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
  ] as const;
  const retired = [
    "požádal rovnou „pošli“",
    "asked you straight away to “send”",
    "jednoznačné „odešli to“",
    "an unambiguous “send it”",
    "Nejdřív připravit, pak Publikovat",
    "Prepare first, then Publication",
    "sdílení mimo Organizaci",
    "share outside the Organization",
    "bez výslovného pokynu uživatele nebo mandátu",
    "the user's explicit instruction or a mandate",
    "Nic nevratného bez „Publikuj“.",
    "Nothing irreversible without “Publish”.",
    "Příprava Publikace není",
    "Preparing is not Publication",
    "Nepublikuješ bez výslovného „Publikuj“",
    "You never publish without the user's explicit “Publish”",
    // Consumers that asked for a fresh "Publish" every time, against consent
    // given in advance (Pablo's review of #695).
    "bez výslovného „Publikuj“ uživatele k tomu konceptu",
    "without the user's explicit “Publish” for that draft",
    "jen jako rozhodnutí uživatele o tomto konkrétním PR",
    "only as the user's decision on that exact PR",
    "merguj až na jeho výslovné „Publikuj“",
    "merge only on their explicit “Publish”",
    "merguj až na výslovné „Publikuj“",
    "merge only on an explicit “Publish”",
    "dokonči až na výslovné „Publikuj“",
    "only on an explicit “Publish” (the section",
    "kterou uživatel výslovně schválil",
    "a Publication the user explicitly approved",
  ];
  const count = (text: string, part: string) => text.split(part).length - 1;
  for (const environment of environments)
    for (const locale of ["cs", "en"] as const) {
      const composition = {
        preset: environment.preset,
        machine: environment.machine,
        profile: presetProfile(environment.preset, environment.os, { locale }),
      };
      const outputs = renderOutputs(composition);
      const layer = renderBuddyLayer(composition);
      const isPublic =
        githubIdentity(environment.preset, environment.machine) === "none";
      const team = environment.preset === "hosted-organization-team";
      const where = [environment.preset, environment.os, isPublic, locale];
      const block = `${publicationRules.map((line) => line[locale]).join("\n")}\n`;
      const consent = `${buddyPublicationRules.map((line) => line[locale]).join("\n")}\n`;
      const worktree = publicationRules[0]?.[locale] ?? "";
      expect([
        ...where,
        count(outputs["AGENTS.md"], block),
        count(outputs["manual/working-here.md"], block),
        count(outputs["manual/working-here.md"], consent),
        count(layer[buddyRulesPath], consent),
        count(layer[buddyRulesPath], worktree),
      ]).toEqual([...where, isPublic ? 0 : 1, isPublic ? 0 : 1, 1, 1, 0]);
      // A Team Environment's named publisher right after the block.
      expect([
        ...where,
        outputs["AGENTS.md"].includes(
          `${block}${
            locale === "cs"
              ? "- Pull request z týmového Environmentu vždy schválí a publikuje jmenovaný uživatel a odpovídá za něj; sám nemerguj, ani na „Publikuj“."
              : "- A named user always approves and publishes a pull request from a Team Environment and answers for it; never merge yourself, not even on “Publish”."
          }`,
        ),
      ]).toEqual([...where, team && !isPublic]);
      // What the block says about consent: an order to write is no consent,
      // consent given in advance holds for a task or the whole thread until
      // it is taken back, and the latest word counts.
      for (const part of locale === "cs"
        ? [
            "„Napiš mu“ nebo „odpověz mu“ je zadání připravit koncept, ne souhlas s odesláním.",
            "na začátku úkolu nebo pro celé vlákno, publikuješ po dokončení sám a znovu se neptáš",
            "Platí to, dokud to neodvolá. Vždy platí jeho poslední slovo.",
          ]
        : [
            "“Write to him” or “reply to him” is a request to prepare a draft, not permission to send it.",
            "at the start of a task or for the whole thread, publish on your own when you're done and don't ask again",
            "This holds until they take it back. Their latest word always counts.",
          ])
        expect([...where, part, consent.includes(part)]).toEqual([
          ...where,
          part,
          true,
        ]);
      // The handoff asks the Publication pair only when consent was not
      // given in advance (not on a Team Environment, whose named user always
      // publishes).
      expect([
        ...where,
        outputs["manual/working-here.md"].includes(
          locale === "cs"
            ? "Když ti uživatel Publikaci dovolil předem, na tento úkol nebo pro celé vlákno, a neodvolal ji, dvojotázku nepokládej"
            : "When the user allowed Publication in advance, for this task or the whole thread, and has not taken it back, do not ask the pair",
        ),
      ]).toEqual([...where, !team]);
      // Buddy's own "never" line and the line for work he hands over say the
      // same consent.
      expect([
        ...where,
        layer[buddyRulesPath].includes(
          locale === "cs"
            ? "- Publikuješ jen se souhlasem uživatele: na „publikuj“, nebo když ti to dovolil předem."
            : "- You publish only with the user's consent: on “publish”, or when they allowed it in advance.",
        ),
      ]).toEqual([...where, true]);
      for (const [path, text] of [
        ...Object.entries(outputs),
        ...buddyLayerPaths.map((path) => [path, layer[path]] as const),
      ])
        for (const sentence of retired)
          expect([...where, path, sentence, text.includes(sentence)]).toEqual([
            ...where,
            path,
            sentence,
            false,
          ]);
    }
});

// The root's agent rules of 2026-10-31 in every Environment: threads do not
// coordinate with each other (root decision 0218, addendum of 2026-10-31), an
// agent never switches the Environment's own network (root decision 0217,
// addendum of 2026-10-31), and one worktree belongs to one pull request, a
// plan may own several (0218's addendum, point 2). The network line takes the
// place of the Headscale, laptop and SSH lines it absorbs; who keeps the
// order on GitHub is the Organization's, so no generated text names the
// root's coordinator.
test("threads do not coordinate, the Environment's network is never switched, and a worktree belongs to one pull request (root addenda of 2026-10-31)", () => {
  const environments = [
    ...journeys,
    {
      preset: "hosted-organization-team",
      machine: bindings.teamBrowser,
      os: "linux",
    },
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
    { preset: "hosted-organization-team", machine: tryBinding(), os: "linux" },
  ] as const;
  const retired = [
    "Při přidávání počítače do Headscale nejdřív čti",
    "When adding a computer to Headscale, first read",
    "ani aktivní tailnet sám neměň",
    "or switch its active tailnet yourself",
    "Profil Tailscale sám nepřepínej",
    "Never switch the Tailscale profile yourself",
  ];
  const count = (text: string, part: string) => text.split(part).length - 1;
  for (const environment of environments)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: environment.preset,
        machine: environment.machine,
        profile: presetProfile(environment.preset, environment.os, { locale }),
      });
      const agents = outputs["AGENTS.md"];
      const working = outputs["manual/working-here.md"];
      const machine = outputs["manual/this-machine.md"];
      const hosted = environment.machine !== null;
      const isPublic =
        githubIdentity(environment.preset, environment.machine) === "none";
      const where = [environment.preset, environment.machine?.name, locale];
      // Threads: once in AGENTS.md right after the Publication block (after
      // a Team Environment's named publisher), and in full in the manual;
      // neither on a public Environment, which has nothing on GitHub.
      const block = publicationRules.map((line) => line[locale]).join("\n");
      const before =
        environment.preset === "hosted-organization-team"
          ? locale === "cs"
            ? "„Komu mám říct, aby tyhle změny publikoval?“ a tomu uživateli předej pull request."
            : "“Whom should I ask to publish these changes?” and hand that user the pull request."
          : block;
      expect([
        ...where,
        count(agents, threadsRule[locale]),
        agents.includes(`${before}\n${threadsRule[locale]}\n`),
        working.includes(
          locale === "cs"
            ? "## Vlákna se mezi sebou nekoordinují (root rozhodnutí 0218, dodatek 2026-10-31)"
            : "## Threads do not coordinate with each other (root decision 0218, addendum 2026-10-31)",
        ),
        working.includes(
          locale === "cs"
            ? "Delegace tvé vlastní práce na tvé subagenty koordinací není."
            : "Delegating your own work to your subagents is not coordination.",
        ),
      ]).toEqual([...where, isPublic ? 0 : 1, !isPublic, !isPublic, !isPublic]);
      // The network: one line in AGENTS.md on every Environment, public ones
      // included, with SSH and the laptop only where the Environment is
      // hosted; in full among the manual's boundaries, where Lazurio Machines
      // manages a hosted Environment's Tailscale.
      expect([
        ...where,
        count(agents, networkLine(hosted)[locale]),
        count(agents, "`100.64.0.x`"),
        machine.includes(
          locale === "cs"
            ? "- Síť: Tailscale tohoto Environmentu je jeden pro všechna vlákna a relace tady"
            : "- Network: this Environment's Tailscale is one for every thread and session here",
        ),
        machine.includes(
          locale === "cs"
            ? "a spravuje ho Lazurio Machines. Nikdy ho nepřepínej, neodhlašuj, nepřesměrovávej na jiný login server ani nevypínej"
            : ", and Lazurio Machines manages it. Never switch it, sign it out, point it at another login server or stop it",
        ),
      ]).toEqual([...where, 1, hosted ? 1 : 0, true, hosted]);
      // One worktree per pull request, several per plan, each cleaned up
      // with its own pull request.
      for (const sentence of locale === "cs"
        ? [
            "Jeden worktree je jedna branch a jeden pull request; plán jich smí mít několik, každý s vlastním `<slug>`.",
            "Rozhoduje jeho pull request, ne plán: worktree mergnutého PR ukliď hned, i když plán dál běží v jiných worktrees.",
          ]
        : [
            "One worktree is one branch and one pull request; a plan may own several, each with its own `<slug>`.",
            "Its pull request decides, not the plan: clean up the worktree of a merged PR right away, even while the plan goes on in other worktrees.",
          ])
        expect([...where, sentence, working.includes(sentence)]).toEqual([
          ...where,
          sentence,
          true,
        ]);
      for (const [path, text] of Object.entries(outputs)) {
        expect([...where, path, text.includes("Pablo")]).toEqual([
          ...where,
          path,
          false,
        ]);
        for (const sentence of retired)
          expect([...where, path, sentence, text.includes(sentence)]).toEqual([
            ...where,
            path,
            sentence,
            false,
          ]);
      }
    }
});

// That the Lazurio account holds entry to Environments is root decision 0192's
// target, not today's gate everywhere: until the move to the account's grants
// is done, the existing path still decides, a Team Environment's GitHub Team
// for one (docs/environment-access.md, Pablo's review of #621). So every line
// of a generated file, Buddy's layer included, that names the Lazurio account
// as the entry authority also names the existing path. The texts are where
// they must be: in `manual/lazurio.md` on every Environment, and in AGENTS.md
// and `manual/this-machine.md` where the user's own sign-ins are used or the
// visitors' section renders (try-01).
test("every statement that the Lazurio account holds entry also names the existing path until the move", () => {
  const environments = [
    ...journeys,
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
    { preset: "hosted-organization-team", machine: tryBinding(), os: "linux" },
    {
      preset: "hosted-organization-personal",
      machine: tryBinding(),
      os: "linux",
    },
  ] as const;
  const authority = {
    cs: /vst(?:up|oup)\p{L}* do (?:Environment|Prostředí)\p{L}*.*Lazurio účet|Lazurio účet.*vst(?:up|oup)\p{L}* do (?:Environment|Prostředí)/iu,
    en: /\b(?:entry to|enters? an?) Environments?\b.*\bLazurio account\b|\bLazurio account\b.*\b(?:entry to|enters? an?) Environments?\b/i,
  };
  const existingPath = { cs: "dosavadní cesta", en: "the existing path" };
  for (const environment of environments)
    for (const locale of ["cs", "en"] as const) {
      const composition = {
        preset: environment.preset,
        machine: environment.machine,
        profile: presetProfile(environment.preset, environment.os, { locale }),
      };
      const outputs = renderOutputs(composition);
      const layer = renderBuddyLayer(composition);
      const where = [environment.preset, environment.machine?.name, locale];
      const statements = (text: string) =>
        text.split("\n").filter((line) => authority[locale].test(line));
      for (const [path, text] of [
        ...Object.entries(outputs),
        ...buddyLayerPaths.map((path) => [path, layer[path]] as const),
      ])
        for (const line of statements(text))
          expect([...where, path, line.includes(existingPath[locale])]).toEqual(
            [...where, path, true],
          );
      const named =
        githubIdentity(environment.preset, environment.machine) ===
          "own-sign-in" || visitorsOf(environment.machine) !== null;
      expect([
        ...where,
        statements(outputs["manual/lazurio.md"]).length >= 2,
        statements(outputs["AGENTS.md"]).length > 0,
        statements(outputs["manual/this-machine.md"]).length > 0,
      ]).toEqual([...where, true, named, named]);
    }
});
