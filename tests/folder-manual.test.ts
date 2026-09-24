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
import { binding, bindings } from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";
import { journeys } from "./folder-render.test";

const os = executionOs(process.platform);

// The manual follows the Folder locale under the same file names. Both
// languages are written paragraph by paragraph side by side, so they have the
// same lines and the same sections; only `this-machine.md` and
// `troubleshooting.md` differ between presets. Review the snapshots when the
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
      // The pull-request lifecycle the Principal decided on 2026-09-22 (F14):
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
            ? "Nespouštěj tu `lazurio update`"
            : "Do not run `lazurio update`",
        ),
      ).toBe(hosted);
      expect(
        troubleshooting.includes(
          "`lazurio update rollback` switches back to the previous version",
        ),
      ).toBe(!hosted && locale === "en");
      expect(
        troubleshooting.includes(
          locale === "cs" ? "## Obsah Organizací" : "## Organization content",
        ),
      ).toBe(journey.preset !== "hosted-personal");
    }
});

// From a personal VM the peers are named neutrally from the record: the
// handover says what Headscale lets this Machine reach, not whose a peer is,
// so nothing calls a peer the owner's and every use needs the Principal's
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
test("a personal VM names reachable peers neutrally from the record and requires the Principal's confirmation", () => {
  const profile = presetProfile("hosted-personal", "linux");
  const render = (machine: typeof bindings.personal, locale = profile) =>
    renderManual({ preset: "hosted-personal", machine, profile: locale })[
      "manual/this-machine.md"
    ];
  const section = (text: string) =>
    text.slice(text.indexOf("## From this personal VM"));
  const related = section(render(bindings.personalRelated));
  expect(related).toContain(
    "Peers this Machine may reach over SSH, exactly as the handover records them:",
  );
  expect(related).toContain(
    "- `example-workspace` (work VM, work zone, Organization `example`): SSH from here to `example-workspace.tailnet.example.invalid` as `operator`; HTTPS `launchpad.example-workspace.example.lazurio.io`.",
  );
  expect(related).toContain(
    "- `example-laptop` (client device, personal zone): SSH both ways with `example-laptop.tailnet.example.invalid`; no HTTPS.",
  );
  expect(related).toContain(
    "Reachability is decided by Headscale and is neither identity nor mandate",
  );
  expect(related).toContain(
    "confirm with the Principal that it is theirs or assigned to them",
  );
  expect(related).toContain("Never clone an Organization repository");
  expect(related).not.toMatch(/owner's (work VM|device)/i);
  expect(render(bindings.personalRelated)).toMatchSnapshot();

  // No relationships in the handover: nothing is guessed.
  expect(section(render(bindings.personal))).toContain(
    "The handover records no peer this Machine may reach over SSH; do not look for one, tell the Principal.",
  );

  // A work VM of a foreign zone, peers of an unknown zone and a client device
  // outside the personal zone are listed exactly as recorded, never as the
  // Principal's; an inbound-only peer is not reachable from here.
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
    "- `foreign-vm` (work VM, personal zone, Organization `other`): SSH from here to `foreign-vm.tailnet.example.invalid`; no HTTPS.",
  );
  expect(mixed).toContain(
    "- `unknown-vm` (work VM): SSH from here to `unknown-vm.tailnet.example.invalid`; no HTTPS.",
  );
  expect(mixed).toContain(
    "- `unzoned-device` (client device): SSH both ways with `unzoned-device.tailnet.example.invalid`; no HTTPS.",
  );
  expect(mixed).toContain(
    "- `work-laptop` (client device, work zone, Organization `other`): SSH from here to `work-laptop.tailnet.example.invalid`; no HTTPS.",
  );
  expect(mixed).toContain(
    "confirm with the Principal that it is theirs or assigned to them",
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
    ).not.toContain("## From this personal VM");

  // The same guidance in Czech.
  const cs = render(
    bindings.personalRelated,
    presetProfile("hosted-personal", "linux", { locale: "cs" }),
  );
  expect(cs).toContain("## Z téhle osobní VM");
  expect(cs).toContain(
    "Dosažitelnost rozhoduje Headscale a není to identita ani mandát",
  );
  expect(cs).toContain(
    "potvrď s Principálem, že je jeho nebo že je přiřazený jemu",
  );
  expect(cs.slice(cs.indexOf("## Z téhle osobní VM"))).not.toContain("Ownerov");
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
  expect(related).toContain("this Machine is in the work zone");
  expect(related).toContain(
    "- `example-laptop` (client device, personal zone): SSH to this Machine from `example-laptop.tailnet.example.invalid`; no HTTPS.",
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
    "- Assignment: assigned to operator `example` (GitHub id 12345).",
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
