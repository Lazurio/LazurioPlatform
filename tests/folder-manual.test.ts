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
import { FolderAdoptionError } from "../src/folder/handover-layout";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { renderManual } from "../src/folder/manual";
import { manualPaths, outputFile, outputPaths } from "../src/folder/outputs";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { resumeInitialization } from "../src/folder/resume-initialization";
import { updateProfile } from "../src/folder/update-profile";
import {
  assignments,
  binding,
  bindings,
  entries,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";
import { journeys } from "./folder-render.test";

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
      // The pull-request lifecycle Matěj decided on 2026-09-22 (F14):
      // Draft PR while in progress, Ready for review when finished and
      // verified, and the PR assigned to the user whose verification is asked
      // for. A snapshot alone cannot drop these sentences.
      const workingHere = outputs["manual/working-here.md"];
      for (const sentence of {
        en: [
          "from the first push the work is visible as a GitHub Draft PR while it is in progress",
          "you mark the pull request Ready for review yourself",
          "assign the pull request (the GitHub assignee, plus the review request) to the GitHub user whose verification you are asking for",
          "The assignee is the owner of the next step.",
          "Finished work never stays a Draft",
        ],
        cs: [
          "od prvního pushe je rozpracovaná práce vidět jako GitHub Draft PR",
          "přepneš pull request na Ready for review sám",
          "pull request přiřadíš (GitHub assignee a k tomu žádost o review) GitHub uživateli, jehož ověření žádáš",
          "Assignee vlastní další krok.",
          "Hotová práce nikdy nezůstává jako Draft",
        ],
      }[locale])
        expect(workingHere).toContain(sentence);
    }
});

// The two working rules of root decision 0163, in both languages and both
// outputs: the short form in AGENTS.md, the full form in the manual's
// `working-here.md`. No output may still say that filing an issue needs the
// Operator's mandate. A snapshot alone cannot drop these sentences.
test("AGENTS.md and the manual carry the issue rule and the review rule of decision 0163", () => {
  const rules = {
    cs: {
      agents: [
        "zapiš bez ptaní jako GitHub Issue do přesného owning repozitáře",
        "Pak pokračuj na všem, co na odpovědi nestojí",
        "Issue bez pokynu Operátora nezavírej ani neprioritizuj a přiřazuj ho jen při eskalaci chybějících práv",
        "Nálezy z review přijímej s úsudkem. Skutečnou vadu oprav hned",
        "věcnou námitkou v PR, a požádej o verdikt na nezměněném headu",
        "Trvá-li reviewer na svém, předlož obě stanoviska Operátorovi",
      ],
      manual: [
        "## Otevřené otázky jdou do GitHub Issues a práci nezastavují (decision 0163)",
        "Je to tvůj trvalý mandát: předem se neptáš",
        "- **Issue práci nezastavuje.**",
        "- **Mandát platí jen pro zápis.**",
        "## Nálezy z review přijímej s úsudkem (decision 0163)",
        "- **Skutečnou vadu oprav hned.**",
        "Pak požádej o verdikt na nezměněném headu.",
        "Review ani branch rules nikdy neobcházej.",
      ],
    },
    en: {
      agents: [
        "as a GitHub Issue in the exact owning repository, without asking first",
        "Then continue with everything that does not depend on the answer",
        "Do not close or prioritize an issue without the Operator's instruction, and assign one only to escalate missing rights",
        "Take review findings with judgment. Fix a real defect at once",
        "with a factual objection on the PR, and ask for a verdict on the unchanged head",
        "If the reviewer still insists, put both positions to the Operator",
      ],
      manual: [
        "## Open questions go to GitHub Issues and do not stop the work (decision 0163)",
        "This is your standing mandate: you do not ask first",
        "- **An issue does not stop the work.**",
        "- **The mandate covers filing only.**",
        "## Take review findings with judgment (decision 0163)",
        "- **Fix a real defect at once.**",
        "Then ask for a verdict on the unchanged head.",
        "Never bypass the review or the branch rules.",
      ],
    },
  } as const;
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      for (const sentence of rules[locale].agents)
        expect(outputs["AGENTS.md"]).toContain(sentence);
      for (const sentence of rules[locale].manual)
        expect(outputs["manual/working-here.md"]).toContain(sentence);
      for (const path of outputPaths)
        expect(outputs[path]).not.toMatch(
          /issue nebo komentáře je Publikace|issue or a comment is a Publication/,
        );
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
            ? "Verzi Lazuria na tomhle Environmentu vlastní Operátor."
            : "The Operator owns the version of Lazurio in this Environment.",
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
// Operator to ask for it or hand the version to the pin, and every text names
// the refresh that follows.
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
      // The refresh after an update is named with its real command.
      expect(troubleshooting).toContain(
        hosted
          ? "`lazurio machine folder-refresh`"
          : "`lazurio profile-update`",
      );
      expect(troubleshooting).toContain("Folder refresh needed");
      expect(outputs["AGENTS.md"]).toContain(
        locale === "cs"
          ? "- Na začátku práce spusť na pozadí `lazurio update`"
          : "- At the start of work, run `lazurio update` in the background",
      );
      expect(troubleshooting).toContain(
        locale === "cs"
          ? "sám na pozadí na začátku každé práce"
          : "in the background at the start of every piece of work",
      );
      if (hosted) {
        expect(troubleshooting).toContain(
          locale === "cs"
            ? "Pin provozovatele hostingu (Lazurio Machines) je jen minimum"
            : "The hosting operator's pin (Lazurio Machines) is only a minimum",
        );
      }
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
    "Reachability is decided by Headscale and is neither identity nor mandate",
  );
  expect(related).toContain(
    "confirm with the Operator that it is theirs or assigned to them",
  );
  expect(related).toContain("Never clone an Organization repository");
  expect(related).not.toMatch(/owner's (work VM|device)/i);
  expect(render(bindings.personalRelated)).toMatchSnapshot();

  // No relationships in the handover: nothing is guessed.
  expect(section(render(bindings.personal))).toContain(
    "The handover records no peer this Environment may reach over SSH; do not look for one, tell the Operator.",
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
    "confirm with the Operator that it is theirs or assigned to them",
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
    "Dosažitelnost rozhoduje Headscale a není to identita ani mandát",
  );
  expect(cs).toContain(
    "potvrď s Operátorem, že je jeho nebo že je přiřazený jemu",
  );
  expect(
    cs.slice(cs.indexOf("## Z tohohle osobního Remote Environmentu")),
  ).not.toContain("Ownerov");
  expect(cs).toMatchSnapshot();
});

// The SSH example is runnable shell, with the host-key pin always present.
test("the SSH example is a runnable command with a mandatory host-key pin", () => {
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
    const parsed = Bun.spawnSync(["sh", "-n", "-c", script]);
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
  expect(related).toContain("Lazurio enforces none of this");
  expect(related).toMatchSnapshot();
});

test("this-machine.md renders the assignment exactly as the handover carries it", () => {
  const operator = renderManual({
    preset: "hosted-organization-personal",
    machine: bindings.assignedOperator,
    profile: presetProfile("hosted-organization-personal", "linux"),
  })["manual/this-machine.md"];
  expect(operator).toContain(
    "- Assignment: assigned to Operator `example` (GitHub id 12345).",
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
// (decision F14 addendum 2026-10-02). Only Codex Desktop's built-in browser
// reaches a `localhost` port of the Environment, through a tunnel it opens
// itself and that OpenAI does not document; T3 Code and Lazurio MausBot
// forward nothing. Without SSH no client reaches `localhost`; without recorded
// peers the handover's silence is said. A workstation has no such section.
test("previews follow how the Operator connects: only Codex Desktop over SSH reaches localhost, and only through its built-in browser", () => {
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
    "- The Operator connects here over SSH. Only Codex Desktop's built-in browser opens `localhost` from here, through a tunnel it opens to the port itself; T3 Code and Lazurio MausBot forward no port.",
  );
  const machine = overSsh["manual/this-machine.md"];
  for (const sentence of [
    "Per the handover, the Operator connects here over SSH.",
    "works with you in the clients they prefer, possibly several at once: Codex Desktop over SSH, T3 Code on the web or in its desktop app, and Lazurio MausBot.",
    "the Operator may be working in another one meanwhile.",
    "OpenAI does not document this and older versions cannot do it, so check that the page really loaded.",
    "When you run in T3 Code or Lazurio MausBot, no port reaches the Operator.",
  ])
    expect(machine).toContain(sentence);
  // The claim the review rejected: forwarding is not a documented fact.
  expect(machine).not.toContain(
    "Codex forwards the port to the operator itself",
  );
  const browserOnly = render(gatewayOnly);
  expect(browserOnly["AGENTS.md"]).toContain(
    "- The Operator does not connect here over SSH: they cannot open `localhost` from here and no port is forwarded.",
  );
  expect(browserOnly["manual/this-machine.md"]).toContain(
    "the Operator cannot open them and no client forwards them.",
  );
  expect(browserOnly["manual/this-machine.md"]).not.toContain(
    "built-in browser",
  );
  const unknown = render(bindings.organization);
  expect(unknown["AGENTS.md"]).toContain(
    "- `localhost` exists only here. Only the built-in browser of Codex Desktop connected over SSH opens it",
  );
  expect(unknown["manual/this-machine.md"]).toContain(
    "The handover does not record where the Operator connects from.",
  );
  for (const journey of journeys)
    expect(
      renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os),
      })["manual/this-machine.md"].includes(
        "## How the Operator works with you",
      ),
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
          ? "Operátorovi místo cesty předej odkaz, který vypíše `lazurio files link <cesta>`: otevře se mu v prohlížeči a soubor stáhne."
          : "Hand the Operator the link `lazurio files link <path>` prints instead of the path: it opens in their browser and downloads the file.",
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

// How Lazurio is built is rendered wherever Organizations are mounted; a
// personal Remote Environment mounts none. Connected applications, secrets and
// the guard against installing from source are on every preset.
test("the building rules follow the Organizations; applications, secrets and the installation guard are everywhere", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      const workingHere = outputs["manual/working-here.md"];
      const withOrganizations = journey.preset !== "hosted-personal";
      for (const heading of locale === "cs"
        ? [
            "## Než postavíš něco nového",
            "## Moduly a Lazurio Module Standard (decision 0171)",
            "## Plán a testy drží záměr",
            "## Přestavbu dělá agent (decision 0173)",
            "## Vývoj Lazuria",
          ]
        : [
            "## Before you build something new",
            "## Modules and the Lazurio Module Standard (decision 0171)",
            "## The plan and the tests hold the intent",
            "## A restructuring is done by an agent (decision 0173)",
            "## Developing Lazurio",
          ])
        expect(workingHere.includes(heading)).toBe(withOrganizations);
      expect(workingHere).toContain(
        locale === "cs"
          ? "spusť `composio link <toolkit>`"
          : "run `composio link <toolkit>`",
      );
      expect(workingHere).toContain(
        locale === "cs"
          ? "**Vlastní integraci nestav**"
          : "**Do not build your own integration**",
      );
      expect(workingHere).toContain(
        locale === "cs" ? "## Tajné údaje" : "## Secrets",
      );
      expect(outputs["manual/troubleshooting.md"]).toContain(
        locale === "cs"
          ? "Lazurio nikdy neinstaluj ani nestav ze zdrojů"
          : "Never install or build Lazurio from source",
      );
      // Composio is part of Lazurio once enabled in the Launchpad settings.
      expect(workingHere).toContain(
        locale === "cs"
          ? "Composio je součást Lazuria, jakmile ho Operátor zapne a přihlásí v Launchpadu (Nastavení → Nástroje)."
          : "Composio is part of Lazurio once the Operator enables it and signs it in in the Launchpad (Settings → Tools).",
      );
      // The agent of an Operator with the rights creates a module on their
      // explicit instruction; nothing says an agent never may.
      expect(workingHere.includes("not an agent")).toBe(false);
      expect(workingHere.includes("ne agent.")).toBe(false);
      expect(
        workingHere.includes(
          locale === "cs"
            ? "Agent Operátora s těmito právy to udělá na jeho výslovný pokyn"
            : "The agent of an Operator with those rights does it on their explicit instruction",
        ),
      ).toBe(withOrganizations);
      // Until content synchronization exists the agent keeps the checkouts
      // current and resolves a diverged one without losing work.
      expect(
        outputs["manual/troubleshooting.md"].includes(
          locale === "cs"
            ? "## Aktuální checkouty Organizací a modulů"
            : "## Current checkouts of Organizations and modules",
        ),
      ).toBe(withOrganizations);
    }
});

// Decision F30: the Operator replaces the Principal. No generated output, in
// any preset or locale, still names the Principal.
test("no generated output says Principal", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      for (const path of outputPaths)
        expect([path, locale, /Princip[aá]l/.test(outputs[path])]).toEqual([
          path,
          locale,
          false,
        ]);
      expect(outputs["manual/roles.md"]).toContain(
        locale === "cs" ? "## Operátor" : "## Operator (Operátor)",
      );
    }
});

// A missing right is escalated to a named administrator on every preset, with
// the assignment as the one exception to the issue mandate, and a refused push
// keeps the work (decision F14 addendum 2026-10-02). Only the Team Environment
// carries the rule of decision F31: it publishes under the Team's identity.
test("missing rights are escalated on every preset; only the Team publishes under its identity", () => {
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
      expect(
        workingHere.includes(
          locale === "cs"
            ? "**Na týmovém Environmentu** jednáš na GitHubu jako brokerovaná identita Organizace"
            : "**In a Team Environment** you act on GitHub as the brokered Organization identity",
        ),
      ).toBe(journey.preset === "hosted-organization-team");
      expect(
        outputs["AGENTS.md"].includes(
          locale === "cs"
            ? "Na týmovém Environmentu dopadne aktualizace na všechny jeho Operátory"
            : "On a Team Environment an update affects all its Operators",
        ),
      ).toBe(journey.preset === "hosted-organization-team");
    }
});

// Accumulated worktrees can be traced and cleaned up: every worktree keeps a
// sidecar with the plan, the pull request and the agent session that made it
// (root decision 0049).
test("every worktree keeps a sidecar with the plan, the pull request and the session", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const workingHere = renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      })["manual/working-here.md"];
      for (const fragment of [
        "`<PLAN>-<slug>.worktree.json`",
        "`companiesascode.worktree.v1`",
        "`conversation_origin`",
        "`CODEX_THREAD_ID`",
        "`CLAUDE_CODE_SESSION_ID`",
      ])
        expect(workingHere).toContain(fragment);
    }
});
