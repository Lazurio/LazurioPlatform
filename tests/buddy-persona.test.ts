import { Database, constants as sqliteFlags } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBuddyCommand } from "../src/buddy/cli";
import {
  type ActiveWork,
  askActiveWork,
  gatewayUnitState,
  liveConversations,
  microsecondsOf,
  promptInputsPath,
  promptRefreshMarked,
  promptRefreshOwed,
  promptRefreshOwedPath,
  readPromptInputs,
  recordedPromptInputs,
  recordPromptInputs,
  refreshPrompts,
  restartPending,
} from "../src/buddy/gateway-refresh";
import {
  actingSenderMode,
  actingSenderPath,
  actingSenderText,
  buddyDisplayName,
  checkPersona,
  confirmPersona,
  isActingName,
  isPersonaName,
  type Persona,
  type PersonaLocale,
  personaFileText,
  personaFromValues,
  personaLockPath,
  personaMode,
  personaPath,
  readPersona,
  soulMode,
  soulPath,
  soulText,
  systemdQuoted,
  writePersona,
} from "../src/buddy/persona";
import {
  applyLockPath,
  type BuddyPersonaEnvironment,
  buddyPersona,
} from "../src/buddy/persona-apply";
import { buddyLayerPaths, buddyRulesPath } from "../src/folder/outputs";
import {
  initializeMachineFolder,
  refreshMachineFolder,
} from "../src/machine/cli";
import { acquireFileLock } from "../src/platform/flock";
import type { ToolsEnvironment } from "../src/tools/overview";
import type { ToolRunner } from "../src/tools/status";
import type { CliContext } from "../src/update/cli";
import goldens from "./fixtures/buddy-persona/goldens.json";
import { bindings } from "./fixtures/machine-bindings";

// Buddy's persona (decision F64): one source, `persona.json`, and one deriver,
// the Platform, byte for byte as the interim installer derives it.
//
// The goldens are the installer's own output: `buddy-install.sh` 2026-10-25.1,
// sha256 f241352974ea153b6ad21a02227676d12ab33094502dc71c617b94a1457d3c3e
// (`goldens.provenance`). `tests/fixtures/buddy-persona/generate-goldens.py`
// checked that sha256, extracted the Python helper the installer writes at run
// time (its heredoc `h.py`) into a temporary directory and ran the helper's
// own commands into real files: `persona-check`, `soul-render`,
// `acting-dropin-render` and `persona-build`, and its `sd_env` for raw values.
// 2026-10-24.2 (sha256 fdd770f3…25ea5) rendered every one of these bytes the
// same; 2026-10-25.1 adds only the refusal of lone surrogates. The installer
// lives outside this repository (an interim draft its maintainer owns, until
// Machines take the install over), so the provenance is its recorded sha256
// and these committed goldens; with the installer at hand they are produced
// again by `python3 -I tests/fixtures/buddy-persona/generate-goldens.py
// <buddy-install.sh> tests/fixtures/buddy-persona/goldens.json`. Three files
// the installer's own container tests compare with `cmp` (its
// `bob-SOUL-en.md`, `bob-SOUL-en-bobr.md` and
// `bob-lazurio-acting-sender.conf`) are among them, byte for byte. Example
// names only.

type Golden = (typeof goldens.render)[number];

const personaOf = (document: unknown): Persona => {
  const check = checkPersona(document);
  if (!check.ok) throw new Error(`not a persona: ${check.field}`);
  return check.persona;
};

const sha256 = (text: string) =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

test("the provenance of the goldens is the installer 2026-10-25.1, by its sha256", () => {
  expect(goldens.provenance.version).toBe("2026-10-25.1");
  expect(goldens.provenance.sha256).toBe(
    "f241352974ea153b6ad21a02227676d12ab33094502dc71c617b94a1457d3c3e",
  );
  // cs and en, ty and vy, with and without a tone, Buddy named Buddy, and the
  // quoting of ", \ and % all present.
  const soul = goldens.render.flatMap((golden) => Object.keys(golden.soul));
  expect(soul.filter((locale) => locale === "cs").length).toBeGreaterThan(8);
  expect(soul.filter((locale) => locale === "en").length).toBeGreaterThan(8);
});

test("SOUL.md, byte for byte as the installer renders it: cs and en, ty and vy, a tone or Lazurio's line, a Buddy named Buddy (Python's strip and casefold), free text in the tone", () => {
  let compared = 0;
  for (const golden of goldens.render as readonly Golden[]) {
    const persona = personaOf(golden.persona);
    for (const [locale, expected] of Object.entries(golden.soul) as [
      PersonaLocale,
      { text: string; sha256: string; mode: string },
    ][]) {
      const text = soulText(persona, locale);
      expect({ id: golden.id, locale, text }).toEqual({
        id: golden.id,
        locale,
        text: expected.text,
      });
      expect(sha256(text)).toBe(expected.sha256);
      expect(expected.mode).toBe(`0o${soulMode.toString(8)}`);
      compared += 1;
    }
  }
  expect(compared).toBe(28);
  // What the cases are about, read off the goldens themselves.
  const soul = (id: string, locale: PersonaLocale): string => {
    const rendered = goldens.render.find((golden) => golden.id === id)?.soul;
    return (
      (rendered as Record<string, { text: string }> | undefined)?.[locale]
        ?.text ?? ""
    );
  };
  expect(soul("buddy", "cs")).toContain("Jsi **Buddy**. Tvůj uživatel je Bob.");
  expect(soul("buddy-upper-spaced", "en")).toContain("You are **  BUDDY **.");
  // NEL is Python's whitespace, U+FEFF is not: the installer strips the one
  // and keeps the other, and so does the port, where JavaScript's trim would
  // do the opposite.
  expect(soul("buddy-nel", "cs")).toContain("Jsi **\u0085Buddy**. Tvůj");
  expect(soul("buddy-bom-char", "cs")).toContain(
    "Jsi **\ufeffBuddy**, Buddy. Tvůj",
  );
  expect(soul("rex-vy-tone", "cs")).toContain(
    "- Tón: Krátce, s humorem a bez vaty.\n",
  );
  expect(soul("tone-quoting", "en")).toContain('Říkej "ahoj", cesta C:\\Users');
});

test("the gateway's drop-in, byte for byte with the installer's quoting: % doubled, and \" and \\ escaped where no persona name can reach", () => {
  for (const golden of goldens.render as readonly Golden[]) {
    const persona = personaOf(golden.persona);
    expect({ id: golden.id, text: actingSenderText(persona) }).toEqual({
      id: golden.id,
      text: golden.actingDropin.text,
    });
    expect(golden.actingDropin.mode).toBe(`0o${actingSenderMode.toString(8)}`);
  }
  const percent = goldens.render.find(({ id }) => id === "percent-names");
  expect(percent?.actingDropin.text).toContain(
    'Environment="T3CODE_ACTING_FOR_ACCUSATIVE=Adu%%n"',
  );
  for (const { value, quoted } of goldens.sdEnv)
    expect(systemdQuoted(value)).toBe(quoted);
  // A name never carries " or \ (the installer's NAME_RE), so those are
  // checked on the quoting alone.
  expect(systemdQuoted('A"\\%')).toBe('"A\\"\\\\%%"');
  expect(isPersonaName('A"da')).toBe(false);
  expect(isPersonaName("A\\da")).toBe(false);
});

test("the persona's file, byte for byte as persona-build writes it: each value stripped as Python strips, a blank tone left out", () => {
  for (const golden of goldens.build) {
    const values = golden.values;
    const check = personaFromValues(
      {
        buddyName: values.BI_BUDDY,
        address: values.BI_ADDRESS,
        user: {
          nominative: values.BI_NOM,
          accusative: values.BI_ACC,
          dative: values.BI_DAT,
        },
        tone: values.BI_TONE,
      },
      undefined,
    );
    if (!check.ok) throw new Error(`${golden.id}: ${check.field}`);
    expect({ id: golden.id, text: personaFileText(check.persona) }).toEqual({
      id: golden.id,
      text: golden.text,
    });
    expect(golden.mode).toBe(`0o${personaMode.toString(8)}`);
  }
});

// ---- Validation parity -------------------------------------------------------

const posix = test.skipIf(process.platform === "win32");

/** Where the Platform knowingly answers otherwise than `persona_check`:
 * Python's json reads NaN, which is no JSON. */
const divergences: Readonly<Record<string, string>> = {
  "nan-member": "unreadable",
};

posix(
  "every persona the installer's persona_check takes, the Platform takes; every one it refuses, the Platform refuses for the same member, a lone surrogate in any member and the order of the checks included; one knowing exception",
  async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "persona-check-")),
    );
    try {
      await mkdir(dirname(personaPath(home)), { recursive: true });
      const outcomes: Record<string, string> = {};
      for (const golden of goldens.check) {
        await writeFile(personaPath(home), golden.text);
        const read = await readPersona(home);
        const outcome =
          read.state === "valid"
            ? "accepted"
            : read.state === "invalid"
              ? `invalid:${read.field}`
              : read.state;
        outcomes[golden.id] = outcome;
        const divergence = divergences[golden.id];
        if (divergence !== undefined) {
          expect({ id: golden.id, outcome }).toEqual({
            id: golden.id,
            outcome: divergence,
          });
          continue;
        }
        if (golden.outcome === "accepted")
          expect({ id: golden.id, outcome }).toEqual({
            id: golden.id,
            outcome: "accepted",
          });
        else if (golden.outcome === "refused")
          expect({ id: golden.id, outcome }).toEqual({
            id: golden.id,
            outcome: `invalid:${golden.field}`,
          });
        // The installer crashed on it: any refusal will do.
        else
          expect({ id: golden.id, outcome }).not.toEqual({
            id: golden.id,
            outcome: "accepted",
          });
      }
      // Lone surrogates are refused alike, member by member, in the
      // installer's order; a paired one is one character.
      expect(
        Object.fromEntries(
          Object.entries(outcomes).filter(
            ([id]) =>
              id.startsWith("lone-surrogate") ||
              id.startsWith("order-") ||
              id.includes("paired"),
          ),
        ),
      ).toEqual({
        "lone-surrogate-buddy": "invalid:buddy_name",
        "lone-surrogate-nominative": "invalid:user.nominative",
        "lone-surrogate-accusative": "invalid:user.accusative",
        "lone-surrogate-dative": "invalid:user.dative",
        "lone-surrogate-tone": "invalid:tone",
        "order-nominative-surrogate-before-accusative":
          "invalid:user.nominative",
        "valid-paired-surrogate-escape": "accepted",
      });
      expect(Object.keys(outcomes).length).toBe(goldens.check.length);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("a name as T3 Code takes it is the installer's acting_name_ok: JavaScript's trim and Python's strip differ only where a refused category decides", () => {
  for (const [name, takes] of [
    ["Ada", true],
    ["A".repeat(64), true],
    ["A".repeat(65), false],
    ["🦖".repeat(32), true],
    ["🦖".repeat(33), false],
    [" Ada", false],
    ["Ada\u00a0", false],
    // Python strips these, JavaScript keeps them: both refuse them as Cc.
    ["\u001cAda", false],
    ["\u0085Ada", false],
    // JavaScript trims this, Python keeps it: both refuse it as Cf.
    ["\ufeffAda", false],
    ["A\u200bda", false],
    ["A\ue000da", false],
    ["A\u2028da", false],
    ["Ada%", true],
  ] as const)
    expect({ name, takes: isActingName(name) }).toEqual({ name, takes });
});

// ---- Writing the persona ---------------------------------------------------

/** Ada's persona, as Začínáme sends it. */
const values = {
  buddyName: "Rex",
  address: "ty",
  user: { nominative: "Ada", accusative: "Adu", dative: "Adě" },
} as const;

const revisionOfFile = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

posix(
  "a write is atomic, 0600 in a 0700 directory, and only over the file the writer read: another revision is persona-changed and nothing is written",
  async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "persona-write-")),
    );
    try {
      const path = personaPath(home);
      // A directory someone left open is made private, as install -d -m 700.
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await chmod(dirname(path), 0o755);
      const first = await writePersona(home, values, null);
      expect(first.kind).toBe("written");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect(await readFile(path, "utf8")).toBe(
        personaFileText(personaOf(JSON.parse(await readFile(path, "utf8")))),
      );
      const revision = await revisionOfFile(path);
      expect(first).toMatchObject({ revision });
      // No temporary file stays.
      expect((await readdir(dirname(path))).sort()).toEqual([
        ".persona.lock",
        "persona.json",
      ]);

      // Absent is a revision too: a writer that saw no file writes nothing
      // over one that appeared.
      const stale = await writePersona(home, values, null);
      expect(stale).toMatchObject({
        kind: "persona-changed",
        current: { state: "valid", revision },
      });
      const other = await writePersona(
        home,
        { ...values, buddyName: "Max" },
        "0".repeat(64),
      );
      expect(other.kind).toBe("persona-changed");
      // The conflict comes first: values typed over a persona that changed
      // meanwhile are not judged, the person sees the persona as it is now.
      expect(
        await writePersona(home, { ...values, address: "oni" }, "0".repeat(64)),
      ).toMatchObject({
        kind: "persona-changed",
        current: { state: "valid", revision },
      });
      expect(await revisionOfFile(path)).toBe(revision);

      // The same values over the same revision: nothing is written.
      const before = await stat(path);
      expect(await writePersona(home, values, revision)).toMatchObject({
        kind: "unchanged",
        revision,
      });
      const after = await stat(path);
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);

      // Another writer between the read and the replace (the installer, a
      // second tab): nothing is replaced, and the answer is the file now.
      const racing = await writePersona(
        home,
        { ...values, buddyName: "Max" },
        revision,
        {
          during: async () => {
            await writeFile(
              path,
              personaFileText({
                ...personaOf({
                  schema_version: "lazurio.buddy-persona.v1",
                  buddy_name: "Bobr",
                  address: "vy",
                  user: values.user,
                }),
              }),
            );
          },
        },
      );
      expect(racing).toMatchObject({
        kind: "persona-changed",
        current: { state: "valid", persona: { buddyName: "Bobr" } },
      });
      expect((await readdir(dirname(path))).sort()).toEqual([
        ".persona.lock",
        "persona.json",
      ]);

      // A refused value names its member, and writes nothing.
      const current = await revisionOfFile(path);
      expect(
        await writePersona(
          home,
          { ...values, user: { ...values.user, accusative: "Ad\u200bu" } },
          current,
        ),
      ).toEqual({ kind: "invalid", field: "user.accusative" });
      expect(
        await writePersona(home, { ...values, address: "oni" }, current),
      ).toEqual({ kind: "invalid", field: "address" });
      expect(await revisionOfFile(path)).toBe(current);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

posix(
  "members the Platform does not know stay, the first confirmation stays, a tone is kept, replaced or left to Lazurio's line, and values are stripped",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "persona-keep-")));
    try {
      const path = personaPath(home);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(
        path,
        JSON.stringify({
          schema_version: "lazurio.buddy-persona.v1",
          buddy_name: "Rex",
          address: "ty",
          user: { nominative: "Ada", accusative: "Adu", dative: "Adě", x: 1 },
          tone: "Krátce.",
          future: { kept: true },
        }),
        { mode: 0o600 },
      );
      const clock = () => new Date("2026-10-25T08:00:00.500Z");
      const confirmed = await writePersona(
        home,
        { ...values, buddyName: "  Max\u00a0", confirm: true },
        await revisionOfFile(path),
        { now: clock },
      );
      expect(confirmed.kind).toBe("written");
      const document = JSON.parse(await readFile(path, "utf8"));
      expect(document).toEqual({
        schema_version: "lazurio.buddy-persona.v1",
        buddy_name: "Max",
        address: "ty",
        user: { nominative: "Ada", accusative: "Adu", dative: "Adě", x: 1 },
        tone: "Krátce.",
        confirmed_at: "2026-10-25T08:00:00Z",
        future: { kept: true },
      });
      // The installer's order of members.
      expect(Object.keys(document)).toEqual([
        "schema_version",
        "buddy_name",
        "address",
        "user",
        "tone",
        "confirmed_at",
        "future",
      ]);
      // A later write keeps the first confirmation, confirm or not.
      await writePersona(
        home,
        { ...values, confirm: true, tone: null },
        await revisionOfFile(path),
        { now: () => new Date("2026-11-01T00:00:00Z") },
      );
      const next = JSON.parse(await readFile(path, "utf8"));
      expect(next.confirmed_at).toBe("2026-10-25T08:00:00Z");
      expect("tone" in next).toBe(false);
      await writePersona(
        home,
        { ...values, tone: "  Vlídně. " },
        await revisionOfFile(path),
      );
      expect(JSON.parse(await readFile(path, "utf8")).tone).toBe("Vlídně.");
      await writePersona(
        home,
        { ...values, tone: "   " },
        await revisionOfFile(path),
      );
      expect("tone" in JSON.parse(await readFile(path, "utf8"))).toBe(false);
      // A confirmation the Platform cannot read is no confirmation.
      const raw = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...raw, confirmed_at: "včera" }));
      expect(await readPersona(home)).toMatchObject({
        state: "valid",
        persona: { buddyName: "Rex" },
      });
      const read = await readPersona(home);
      expect(read.state).toBe("valid");
      expect(
        read.state === "valid" ? read.persona.confirmedAt : "none",
      ).toBeUndefined();
      // A persona the installer refuses is put right by a valid one over its
      // revision, and what the Platform does not know of it stays.
      await writeFile(
        path,
        JSON.stringify({ ...raw, address: "oni", future: { kept: 2 } }),
      );
      const invalid = await readPersona(home);
      expect(invalid).toMatchObject({ state: "invalid", field: "address" });
      expect(
        await writePersona(home, values, await revisionOfFile(path)),
      ).toMatchObject({ kind: "written" });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        address: "ty",
        future: { kept: 2 },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

posix(
  "two writers of one revision: the persona's lock lets exactly one write, and the other answers persona-changed with the persona the first wrote",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "persona-race-")));
    try {
      const first = await writePersona(home, values, null);
      if (first.kind !== "written") throw new Error(first.kind);
      // Each one dwells between its read and its replace, long enough for
      // the other to read the same revision were nothing holding it back.
      const dwell = {
        during: () => new Promise<void>((done) => setTimeout(done, 200)),
      };
      const [max, bobr] = await Promise.all([
        writePersona(
          home,
          { ...values, buddyName: "Max" },
          first.revision,
          dwell,
        ),
        writePersona(
          home,
          { ...values, buddyName: "Bobr" },
          first.revision,
          dwell,
        ),
      ]);
      expect([max.kind, bobr.kind].sort()).toEqual([
        "persona-changed",
        "written",
      ]);
      const winner = max.kind === "written" ? "Max" : "Bobr";
      expect(max.kind === "written" ? bobr : max).toMatchObject({
        kind: "persona-changed",
        current: { state: "valid", persona: { buddyName: winner } },
      });
      expect(
        JSON.parse(await readFile(personaPath(home), "utf8")).buddy_name,
      ).toBe(winner);
      // A confirmation is a writer too: whichever goes first, nothing either
      // wrote is lost.
      const seen = await readPersona(home);
      if (seen.state !== "valid") throw new Error(seen.state);
      const [confirmed, renamed] = await Promise.all([
        confirmPersona(home, dwell),
        writePersona(
          home,
          { ...values, buddyName: "Rex" },
          seen.revision,
          dwell,
        ),
      ]);
      expect(confirmed.kind).toBe("written");
      const after = JSON.parse(await readFile(personaPath(home), "utf8"));
      expect(after.confirmed_at).toBeString();
      expect(after.buddy_name).toBe(
        renamed.kind === "written" ? "Rex" : winner,
      );
      expect(["written", "persona-changed"]).toContain(renamed.kind);
      // The lock stays where it is, private and empty.
      expect((await stat(personaLockPath(home))).mode & 0o777).toBe(0o600);
      expect((await stat(personaLockPath(home))).size).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

posix(
  "a writer in another process holds the lock from its read to its replace: a writer here waits for it and then answers persona-changed",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "persona-proc-")));
    try {
      const first = await writePersona(home, values, null);
      if (first.kind !== "written") throw new Error(first.kind);
      const script = join(home, "writer.ts");
      await writeFile(
        script,
        [
          `import { writePersona } from ${JSON.stringify(join(import.meta.dir, "..", "src", "buddy", "persona.ts"))};`,
          "const [home, revision] = process.argv.slice(2);",
          'const persona = { buddyName: "Bobr", address: "ty", user: { nominative: "Ada", accusative: "Adu", dative: "Ad\u011b" } };',
          "const answer = await writePersona(home, persona, revision, {",
          '  during: async () => { console.log("inside"); await Bun.sleep(400); },',
          "});",
          "console.log(answer.kind);",
        ].join("\n"),
      );
      const child = Bun.spawn(
        [process.execPath, script, home, first.revision],
        {
          stdout: "pipe",
        },
      );
      const reader = child.stdout.getReader();
      let output = "";
      while (!output.includes("inside")) {
        const { value, done } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }
      expect(output).toContain("inside");
      const here = await writePersona(
        home,
        { ...values, buddyName: "Max" },
        first.revision,
      );
      expect(here).toMatchObject({
        kind: "persona-changed",
        current: { state: "valid", persona: { buddyName: "Bobr" } },
      });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }
      expect(await child.exited).toBe(0);
      expect(output.trim().split("\n")).toEqual(["inside", "written"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

posix(
  "a link where the persona or its directory belongs is never written through",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "persona-link-")));
    try {
      const path = personaPath(home);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const outside = join(home, "outside.json");
      await writeFile(outside, "{}");
      await symlink(outside, path);
      expect(await readPersona(home)).toEqual({ state: "unreadable" });
      expect(await writePersona(home, values, null)).toEqual({
        kind: "unsafe",
      });
      expect(await readFile(outside, "utf8")).toBe("{}");
      await rm(dirname(path), { recursive: true });
      const elsewhere = join(home, "elsewhere");
      await mkdir(elsewhere);
      await symlink(elsewhere, dirname(path));
      expect(await writePersona(home, values, null)).toEqual({
        kind: "unsafe",
      });
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

// ---- An Osobní Prostředí with Buddy -----------------------------------------

const noChoices = {
  preset: undefined,
  detail: undefined,
  coordination: undefined,
} as const;

type Change = Partial<{
  buddyName: string;
  address: string;
  user: Readonly<{ nominative: string; accusative: string; dative: string }>;
  tone: string | null;
}>;

/** `us+utc`, as systemd 255 prints a timestamp. */
function usUtc(microseconds: bigint): string {
  const date = new Date(Number(microseconds / 1000n));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    date.getUTCDay()
  ];
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${day} ${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(Number(microseconds % 1_000_000n), 6)} UTC`;
}

const nowMicros = () => BigInt(Date.now()) * 1000n;

async function writtenAt(path: string): Promise<bigint> {
  try {
    return (await lstat(path, { bigint: true })).mtimeNs / 1000n;
  } catch {
    return 0n;
  }
}

/** T3 Code's ownership of its state directory, as its server takes it while
 * it runs (F61's fake). */
function own(stateDirectory: string): Database {
  const owner = new Database(
    join(stateDirectory, "server-owner.sqlite"),
    sqliteFlags.SQLITE_OPEN_READWRITE | sqliteFlags.SQLITE_OPEN_CREATE,
  );
  owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  return owner;
}

/** A row of Hermes's session store: the columns `live_sessions` reads, and
 * the stored prompt by its hash (`system_prompt_hash`, v0.22.4-lazurio.1),
 * which the Platform compares and never reads a prompt by. */
type SessionRow = readonly [
  id: string,
  source: string | null,
  parent: string | null,
  startedAt: number,
  endedAt: number | null,
  promptHash: string | null,
];

/** Hermes's session store with those columns, and an inline prompt column
 * that new rows leave empty. */
function sessionStore(hermesHome: string, rows: readonly SessionRow[]) {
  const store = new Database(join(hermesHome, "state.db"));
  store.exec(
    "create table sessions (id text primary key, source text, parent_session_id text, started_at real, ended_at real, system_prompt text, system_prompt_hash text)",
  );
  const insert = store.prepare(
    "insert into sessions values (?, ?, ?, ?, ?, null, ?)",
  );
  for (const row of rows) insert.run(...row);
  store.close();
}

/** What Hermes's `sessions repair-prompts <id> --apply --json` does in the
 * fake: clears the row's prompt (`ok`), fails and leaves it (`fail`),
 * answers it cleared and leaves it (`lie`), or finds the row gone
 * (`vanish`). */
type Repair = "ok" | "fail" | "lie" | "vanish";

/** Ada's Osobní Prostředí: a Folder initialized from the personal handover,
 * Buddy's persona and Hermes home, Hermes's launcher where its installer puts
 * it, Buddy's T3 Code's unit and runtime, and the user manager, Hermes and
 * Buddy's `t3` as fakes that keep what they were asked. */
async function osobniProstredi(locale: PersonaLocale = "cs") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "buddy-persona-")));
  const folder = join(home, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o700 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const initialized = await initializeMachineFolder(folder, bindings.personal, {
    ...noChoices,
    locale,
  });
  expect(initialized.code).toBe(0);
  // His prompts were last refreshed from the Lazurio layer the Folder holds
  // (F64's addendum of 2026-10-25), as an installed Buddy's.
  await recordPromptInputs(home, await readPromptInputs(folder));
  const hermesHome = join(home, ".hermes");
  await mkdir(hermesHome, { mode: 0o700 });
  await mkdir(dirname(personaPath(home)), { recursive: true, mode: 0o700 });
  const write = await writePersona(home, values, null);
  expect(write.kind).toBe("written");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const hermes = join(bin, "hermes");
  await writeFile(hermes, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const userdata = join(home, ".t3-buddy", "userdata");
  await mkdir(userdata, { recursive: true, mode: 0o700 });
  // Buddy's T3 Code as Machines install it: the unit names the runtime his
  // own `t3` is (F61 addendum, point 3).
  const runtimes = join(home, ".t3-buddy", "runtime", "versions");
  const t3 = join(runtimes, "0.1.1-lazurio.2", "t3");
  await mkdir(dirname(t3), { recursive: true, mode: 0o700 });
  await writeFile(t3, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const units = join(home, ".config", "systemd", "user");
  await mkdir(units, { recursive: true });
  await writeFile(
    join(units, "lazurio-t3-buddy.service"),
    `[Service]\nExecStart=${t3} serve --base-dir ${join(home, ".t3-buddy")} --port 3774\n`,
  );
  // Two live conversations that hold a stored prompt, one that holds none
  // (its id would read as an option), an ended one, a tool's and a child's.
  const an = Date.now() / 1000;
  sessionStore(hermesHome, [
    ["20261025_080000_abc123", "telegram", null, an - 60, null, "h-telegram"],
    [
      "2b7c1e0a-1111-4222-8333-444455556666",
      "acp",
      null,
      an - 30,
      null,
      "h-acp",
    ],
    ["--apply", "cli", null, an - 5, null, null],
    [
      "20261024_080000_def456",
      "telegram",
      null,
      an - 9000,
      an - 8000,
      "h-ended",
    ],
    ["20261025_080100_tool01", "tool", null, an - 20, null, "h-tool"],
    [
      "20261025_080200_child1",
      "acp",
      "2b7c1e0a-1111-4222-8333-444455556666",
      an - 10,
      null,
      "h-child",
    ],
  ]);

  const world = {
    /** The user manager answers at all. */
    systemd: true,
    gateway: {
      load: "loaded" as "loaded" | "not-found",
      running: true,
      // Since a minute ago: before anything this test writes.
      startedAt: nowMicros() - 60_000_000n,
      reloadedAt: nowMicros(),
    },
    t3: {
      unit: false,
      owner: undefined as Database | undefined,
      /** Threads of Buddy's T3 Code with a run going. */
      runs: 0,
      /** What `t3 thread list` answers otherwise: T3 Code not running (exit
       * 3) or an answer that is none. */
      answer: "list" as "list" | "not-running" | "garbage",
    },
    work: "idle" as ActiveWork,
    /** Runs whenever an apply asks systemd about the gateway, after it wrote
     * the files: another writer acting in the middle of an apply. */
    during: undefined as (() => Promise<void>) | undefined,
    repair: new Map<string, Repair>(),
    failing: new Set<string>(),
    calls: [] as string[][],
    environments: [] as Readonly<Record<string, string>>[],
  };
  const unitFiles = [soulPath(home), actingSenderPath(home)];
  const newestUnitFile = async () => {
    let newest = 0n;
    for (const path of unitFiles) {
      const at = await writtenAt(path);
      if (at > newest) newest = at;
    }
    return newest;
  };
  /** The gateway's process starts again: after every file written before. */
  const startGateway = async () => {
    const newest = await newestUnitFile();
    world.gateway.running = true;
    world.gateway.startedAt = nowMicros() > newest ? nowMicros() : newest + 1n;
  };
  const store = (body: (db: Database) => void) => {
    const db = new Database(join(hermesHome, "state.db"));
    try {
      body(db);
    } finally {
      db.close();
    }
  };
  const run: ToolRunner = async (command, _timeout, env) => {
    world.calls.push([...command]);
    world.environments.push(env);
    const [program, ...args] = command;
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const no = (code = 1, stdout = "") => ({
      exitCode: code,
      stdout,
      stderr: "",
    });
    if (program === hermes) {
      if (args[0] === "acp" && args[1] === "--check") return ok("OK\n");
      if (args[0] === "sessions" && args[1] === "repair-prompts") {
        const id = args[2] ?? "";
        const repair = world.repair.get(id) ?? "ok";
        if (repair === "fail") return no();
        if (repair === "vanish") {
          store((db) =>
            db.prepare("delete from sessions where id = ?").run(id),
          );
          return no(1, `No session matches '${id}'.\n`);
        }
        if (repair === "ok")
          store((db) =>
            db
              .prepare(
                "update sessions set system_prompt = null, system_prompt_hash = null where id = ?",
              )
              .run(id),
          );
        // Hermes v0.22.4-lazurio.1's `_payload` with --apply --json.
        return ok(
          `${JSON.stringify({ findings: [{ id, reason: "targeted clear" }], unverifiable: [], apply: true, cleared: [id] }, null, 2)}\n`,
        );
      }
      return no(2);
    }
    if (program === t3) {
      if (args[0] !== "thread" || args[1] !== "list") return no(2);
      if (world.t3.answer === "not-running") return no(3);
      if (world.t3.answer === "garbage") return ok("threads\n");
      return ok(
        JSON.stringify({
          threads: Array.from({ length: Math.min(world.t3.runs, 1) }, () => ({
            threadId: "t-1",
            status: "running",
          })),
          total: world.t3.runs,
        }),
      );
    }
    if (program !== "systemctl") return no(127);
    if (!world.systemd) throw new Error("spawn systemctl ENOENT");
    if (args[0] !== "--user") return no(2);
    const verb = args[1];
    if (world.failing.has(verb ?? "")) return no();
    if (verb === "show" && args[2] === "hermes-gateway.service") {
      await world.during?.();
      const dropin = await writtenAt(actingSenderPath(home));
      const lines = [
        `ExecMainStartTimestamp=${world.gateway.running ? usUtc(world.gateway.startedAt) : ""}`,
        `LoadState=${world.gateway.load}`,
        `ActiveState=${world.gateway.running ? "active" : "inactive"}`,
        `NeedDaemonReload=${dropin > world.gateway.reloadedAt ? "yes" : "no"}`,
      ];
      return ok(`${lines.join("\n")}\n`);
    }
    if (verb === "daemon-reload") {
      // systemd rereads every file written before the reload.
      const dropin = await writtenAt(actingSenderPath(home));
      world.gateway.reloadedAt =
        (nowMicros() > dropin ? nowMicros() : dropin) + 1n;
      return ok();
    }
    if (verb === "restart" && args[2] === "hermes-gateway.service") {
      await startGateway();
      return ok();
    }
    if (
      args[2] === "lazurio-t3-buddy.service" ||
      args[3] === "lazurio-t3-buddy.service"
    ) {
      if (verb === "is-active") return world.t3.unit ? ok() : no(3);
      if (verb === "stop") {
        world.t3.owner?.close();
        world.t3.owner = undefined;
        world.t3.unit = false;
        return ok();
      }
      if (verb === "start") {
        world.t3.owner = own(userdata);
        world.t3.unit = true;
        return ok();
      }
    }
    return no(2);
  };
  const tools: ToolsEnvironment = {
    home,
    path: "/usr/bin:/bin",
    platform: "linux",
    run,
  };
  const environment: BuddyPersonaEnvironment = {
    tools,
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      SECRET_ELSEWHERE: "never passed on",
    },
    activeWork: async () => world.work,
  };
  const t3Runs = () => {
    world.t3.owner = own(userdata);
    world.t3.unit = true;
  };
  const settings = join(userdata, "settings.json");
  /** The person changes some members in Nastavení → Buddy; the others stay
   * as they are. */
  const rename = async (change: Change) => {
    const current = await readPersona(home);
    if (current.state !== "valid") throw new Error("no persona");
    const answer = await writePersona(
      home,
      {
        buddyName: current.persona.buddyName,
        address: current.persona.address,
        user: current.persona.user,
        ...change,
      },
      current.revision,
    );
    expect(answer.kind).toBe("written");
  };
  const calls = (match: (call: string[]) => boolean) =>
    world.calls.filter(match).length;
  const repairs = () =>
    world.calls
      .filter((call) => call[1] === "sessions" && call[2] === "repair-prompts")
      .map((call) => call[3]);
  /** The stored prompt hashes of the live conversations, by id. */
  const held = () => {
    const rows: Record<string, string | null> = {};
    store((db) => {
      for (const row of db
        .query(
          "select id, system_prompt_hash as hash from sessions where ended_at is null",
        )
        .all() as { id: string; hash: string | null }[])
        rows[row.id] = row.hash;
    });
    return rows;
  };
  /** A turn in a conversation rebuilds its stored prompt from the files. */
  const turn = (id: string, hash: string) =>
    store((db) =>
      db
        .prepare("update sessions set system_prompt_hash = ? where id = ?")
        .run(hash, id),
    );
  const owed = () => promptRefreshOwed(home, folder);
  return {
    home,
    folder,
    hermes,
    hermesHome,
    userdata,
    settings,
    t3,
    world,
    tools,
    environment,
    t3Runs,
    rename,
    calls,
    repairs,
    held,
    turn,
    owed,
    /** systemd starts the gateway again by itself (after a crash), with no
     * reload of its units. */
    externalRestart: startGateway,
    dispose: async () => {
      world.t3.owner?.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

type Prostredi = Awaited<ReturnType<typeof osobniProstredi>>;

async function within(
  body: (env: Prostredi) => Promise<void>,
  locale: PersonaLocale = "cs",
) {
  const env = await osobniProstredi(locale);
  try {
    await body(env);
  } finally {
    await env.dispose();
  }
}

const apply = (env: Prostredi) =>
  buddyPersona(env.environment, { folder: env.folder, apply: true });
const read = (env: Prostredi) =>
  buddyPersona(env.environment, { folder: env.folder });

const restarts = (call: string[]) =>
  call[0] === "systemctl" && call[2] === "restart";
const settingsOf = async (env: Prostredi) =>
  JSON.parse(await readFile(env.settings, "utf8")) as {
    providerInstances: {
      buddy: {
        displayName: string;
        environment: { name: string; value: string }[];
      };
    };
  };

posix(
  "read, nothing is written; applied, SOUL.md and the drop-in hold the installer's bytes with their exact modes, the stored prompts of live conversations are cleared, verified in the store, and the gateway, which started before them, restarts once while Buddy is idle",
  () =>
    within(async (env) => {
      const before = await read(env);
      expect(before).toMatchObject({
        kind: "buddy-persona",
        state: "outdated",
        locale: "cs",
        persona: {
          buddyName: "Rex",
          address: "ty",
          user: values.user,
          confirmed: false,
        },
        files: { soul: "outdated", actingSender: "outdated" },
        restart: "none",
        chat: { state: "outdated" },
      });
      await expect(lstat(soulPath(env.home))).rejects.toThrow();
      expect(env.calls(restarts)).toBe(0);

      const persona = personaOf(
        JSON.parse(await readFile(personaPath(env.home), "utf8")),
      );
      const answer = await apply(env);
      expect(answer).toMatchObject({
        state: "applied",
        files: { soul: "written", actingSender: "written" },
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "done",
        chat: { state: "managed" },
      });
      // The store holds no prompt they held, and nothing more is owed.
      expect(env.held()).toMatchObject({
        "20261025_080000_abc123": null,
        "2b7c1e0a-1111-4222-8333-444455556666": null,
        "20261025_080100_tool01": "h-tool",
        "20261025_080200_child1": "h-child",
      });
      expect(await env.owed()).toBe(false);
      expect(await readFile(soulPath(env.home), "utf8")).toBe(
        soulText(persona, "cs"),
      );
      expect(await readFile(actingSenderPath(env.home), "utf8")).toBe(
        actingSenderText(persona),
      );
      expect((await stat(soulPath(env.home))).mode & 0o777).toBe(0o600);
      expect((await stat(actingSenderPath(env.home))).mode & 0o777).toBe(0o644);
      // Hermes's own command per live conversation that holds a stored
      // prompt, never a tool's, a child's, an ended one or one that holds
      // none; then one reload of the units and one restart, in this order.
      expect(env.repairs()).toEqual([
        "2b7c1e0a-1111-4222-8333-444455556666",
        "20261025_080000_abc123",
      ]);
      const order = env.world.calls
        .map((call) =>
          call[1] === "sessions"
            ? "repair"
            : call[0] === "systemctl"
              ? (call[2] ?? "")
              : "",
        )
        .filter((step) =>
          ["repair", "daemon-reload", "restart"].includes(step),
        );
      expect(order).toEqual(["daemon-reload", "repair", "repair", "restart"]);
      // systemctl gets the user manager's variables and nothing else.
      const systemctl = env.world.calls.findIndex(
        ([program]) => program === "systemctl",
      );
      expect(
        Object.keys(env.world.environments[systemctl] ?? {}).sort(),
      ).toEqual(["HOME", "PATH", "XDG_RUNTIME_DIR"]);
      // Buddy's T3 Code shows his name and acts for Ada.
      const settings = await settingsOf(env);
      expect(settings.providerInstances.buddy.displayName).toBe("Rex");

      // Everything in place: nothing more to do, nothing written again.
      const soulBefore = await stat(soulPath(env.home));
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        files: { soul: "in-place", actingSender: "in-place" },
        restart: "none",
        chat: { state: "managed" },
      });
      expect("prompts" in (await apply(env))).toBe(false);
      expect(env.calls(restarts)).toBe(0);
      expect(env.repairs()).toEqual([]);
      const soulAfter = await stat(soulPath(env.home));
      expect([soulAfter.ino, soulAfter.mtimeMs]).toEqual([
        soulBefore.ino,
        soulBefore.mtimeMs,
      ]);
      expect(await read(env)).toMatchObject({
        state: "in-place",
        files: { soul: "in-place", actingSender: "in-place" },
        restart: "none",
        chat: { state: "managed" },
      });
    }),
);

posix("an English Folder gets the English SOUL.md", () =>
  within(async (env) => {
    expect(await apply(env)).toMatchObject({ state: "applied", locale: "en" });
    expect(await readFile(soulPath(env.home), "utf8")).toContain(
      "You are **Rex**, Buddy. Your user is Ada.",
    );
  }, "en"),
);

posix(
  "each member reaches exactly what derives from it: SOUL.md always, the drop-in for the user's nominative and accusative, T3 Code for those and Buddy's name; a confirmation reaches nothing",
  () =>
    within(async (env) => {
      await apply(env);
      const snapshot = async () => ({
        soul: await readFile(soulPath(env.home), "utf8"),
        actingSender: await readFile(actingSenderPath(env.home), "utf8"),
        displayName: (await settingsOf(env)).providerInstances.buddy
          .displayName,
        acting: JSON.stringify(
          (await settingsOf(env)).providerInstances.buddy.environment.filter(
            ({ name }) => name.startsWith("T3CODE_ACTING_FOR"),
          ),
        ),
      });
      const changed = (a: Record<string, string>, b: Record<string, string>) =>
        Object.keys(a).filter((key) => a[key] !== b[key]);
      const matrix: [string, Change, string[]][] = [
        ["buddy_name", { buddyName: "Bobr" }, ["soul", "displayName"]],
        ["address", { address: "vy" }, ["soul"]],
        [
          "user.nominative",
          { user: { nominative: "Adéla", accusative: "Adu", dative: "Adě" } },
          ["soul", "actingSender", "acting"],
        ],
        [
          "user.accusative",
          { user: { nominative: "Adéla", accusative: "Adélu", dative: "Adě" } },
          ["soul", "actingSender", "acting"],
        ],
        [
          "user.dative",
          {
            user: { nominative: "Adéla", accusative: "Adélu", dative: "Adéle" },
          },
          ["soul"],
        ],
        ["tone", { tone: "Krátce." }, ["soul"]],
      ];
      let previous = await snapshot();
      for (const [member, update, effects] of matrix) {
        await env.rename(update);
        expect(await apply(env)).toMatchObject({ state: "applied" });
        const next = await snapshot();
        expect({ member, changed: changed(previous, next) }).toEqual({
          member,
          changed: effects,
        });
        previous = next;
      }
      const confirmed = await buddyPersona(env.environment, {
        folder: env.folder,
        apply: true,
        confirm: true,
      });
      expect(confirmed).toMatchObject({
        state: "applied",
        persona: { confirmed: true },
        files: { soul: "in-place", actingSender: "in-place" },
      });
      expect(changed(previous, await snapshot())).toEqual([]);
      // Delegace's drop-in is not the Platform's (until #616 retires it).
      await expect(
        lstat(
          join(env.home, ".config", "systemd", "user", "delegace.service.d"),
        ),
      ).rejects.toThrow();
    }),
);

posix(
  "while Buddy works, the change waits: SOUL.md is written and the stored prompts cleared at once, the restart waits for the idle moment, derived from the files' times, the refresh it owes recorded, and then the prompts are cleared again and the gateway restarts once",
  () =>
    within(async (env) => {
      await apply(env);
      // Both conversations went on: their turns built their prompts anew.
      env.turn("20261025_080000_abc123", "h-telegram-2");
      env.turn("2b7c1e0a-1111-4222-8333-444455556666", "h-acp-2");
      env.world.calls.length = 0;
      env.world.work = "busy";
      await env.rename({
        user: { ...values.user, nominative: "Adéla", accusative: "Adélu" },
      });
      expect(await apply(env)).toMatchObject({
        state: "waiting",
        files: { soul: "written", actingSender: "written" },
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "pending",
      });
      expect(env.calls(restarts)).toBe(0);
      // systemd has the new drop-in for the gateway's next start.
      expect(env.calls((call) => call[2] === "daemon-reload")).toBe(1);
      // The next reader sees the restart from the times; the refresh the
      // restart is to follow is recorded, private to the account.
      expect(await read(env)).toMatchObject({
        state: "outdated",
        files: { soul: "in-place", actingSender: "in-place" },
        prompts: { state: "owed" },
        restart: "pending",
      });
      const marker = promptRefreshOwedPath(env.home);
      expect((await stat(marker)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(marker))).mode & 0o777).toBe(0o700);
      expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({
        schema_version: "lazurio.buddy-prompt-refresh.v1",
      });
      // Still busy: still waiting, nothing restarted, nothing cleared again.
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "waiting",
        prompts: { state: "owed" },
        restart: "pending",
      });
      expect(env.calls(restarts)).toBe(0);
      expect(env.repairs()).toEqual([]);
      // No answer from Hermes counts as busy: nothing restarts blind.
      env.world.work = "unknown";
      expect(await apply(env)).toMatchObject({
        state: "waiting",
        restart: "pending",
      });
      expect(env.calls(restarts)).toBe(0);

      // Turns meanwhile built their prompts anew; the idle moment clears them
      // once more before the one restart.
      env.turn("20261025_080000_abc123", "h-turn");
      env.world.work = "idle";
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        files: { soul: "in-place", actingSender: "in-place" },
        prompts: { state: "refreshed", refreshed: 1, live: 1 },
        restart: "done",
      });
      expect(env.calls(restarts)).toBe(1);
      expect(await env.owed()).toBe(false);
      expect(await read(env)).toMatchObject({
        state: "in-place",
        restart: "none",
      });
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        restart: "none",
      });
      expect(env.calls(restarts)).toBe(0);
      expect(env.repairs()).toEqual([]);
    }),
);

posix(
  "a stopped gateway reads the files when it starts: no restart, the prompts cleared; no gateway unit at all is the same",
  () =>
    within(async (env) => {
      env.world.gateway.running = false;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed", refreshed: 2 },
        restart: "none",
      });
      expect(env.calls(restarts)).toBe(0);
      // With no gateway running, a complete refresh settles what was owed.
      expect(await env.owed()).toBe(false);
      env.world.gateway.load = "not-found";
      await env.rename({ buddyName: "Bobr" });
      expect(await apply(env)).toMatchObject({
        state: "applied",
        restart: "none",
      });
      expect(env.calls(restarts)).toBe(0);
    }),
);

posix(
  "without hermes the files still apply and the gateway restarts for them, but no prompt can be cleared: the apply fails visibly, the refresh stays owed, and hermes back clears them and restarts once more",
  () =>
    within(async (env) => {
      await rm(env.hermes);
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "prompts-incomplete",
        files: { soul: "written", actingSender: "written" },
        prompts: { state: "skipped", reason: "hermes-missing" },
        restart: "done",
        chat: { state: "unavailable", reason: "hermes-missing" },
      });
      expect(env.repairs()).toEqual([]);
      expect(await env.owed()).toBe(true);
      expect(await read(env)).toMatchObject({
        state: "outdated",
        prompts: { state: "owed" },
        restart: "pending",
      });
      await writeFile(env.hermes, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        files: { soul: "in-place", actingSender: "in-place" },
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "done",
      });
      expect(env.calls(restarts)).toBe(1);
      expect(await env.owed()).toBe(false);
    }),
);

posix(
  "a store without sessions.ended_at is skipped; without a user manager the restart is unavailable and nothing restarts",
  () =>
    within(async (env) => {
      await rm(join(env.hermesHome, "state.db"));
      const store = new Database(join(env.hermesHome, "state.db"));
      store.exec("create table sessions (id text, source text)");
      store.close();
      env.world.systemd = false;
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "prompts-incomplete",
        prompts: { state: "skipped", reason: "store-unreadable" },
        restart: "unavailable",
      });
      expect(env.calls(restarts)).toBe(0);
      expect(await env.owed()).toBe(true);
      // No store yet (Buddy has had no conversation): nothing to clear.
      await rm(join(env.hermesHome, "state.db"));
      await env.rename({ buddyName: "Bobr" });
      expect(await apply(env)).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed", refreshed: 0, live: 0 },
        restart: "unavailable",
      });
      expect(await env.owed()).toBe(false);
    }),
);

posix(
  "a restart systemd refuses fails the apply and stays pending for the next one",
  () =>
    within(async (env) => {
      env.world.failing.add("restart");
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "gateway-restart-failed",
        restart: "failed",
      });
      // The refresh it was to follow stays owed with it.
      expect(await read(env)).toMatchObject({
        restart: "pending",
        prompts: { state: "owed" },
      });
      env.world.failing.delete("restart");
      expect(await apply(env)).toMatchObject({
        state: "applied",
        restart: "done",
      });
      expect(await env.owed()).toBe(false);
    }),
);

posix(
  "when systemd does not reread the units, nothing restarts on the old ones: the apply fails, the restart stays pending even after the gateway starts again by itself, and the next apply rereads and restarts",
  () =>
    within(async (env) => {
      env.world.failing.add("daemon-reload");
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "units-reload-failed",
        files: { soul: "written", actingSender: "written" },
        restart: "failed",
      });
      expect(env.calls(restarts)).toBe(0);
      // systemd starts the gateway again by itself, on the units it holds:
      // the files' times no longer say anything, the units still do.
      await env.externalRestart();
      await rm(promptRefreshOwedPath(env.home));
      expect(await read(env)).toMatchObject({
        state: "outdated",
        restart: "pending",
      });
      env.world.failing.delete("daemon-reload");
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        restart: "done",
      });
      expect(
        env.world.calls
          .filter(([program]) => program === "systemctl")
          .map((call) => call[2])
          .filter((verb) => verb === "daemon-reload" || verb === "restart"),
      ).toEqual(["daemon-reload", "restart"]);
      expect(await read(env)).toMatchObject({
        state: "in-place",
        restart: "none",
      });
      // A stopped gateway on units systemd did not reread would start on
      // them: that is visible too, and the next apply rereads.
      env.world.gateway.running = false;
      env.world.failing.add("daemon-reload");
      await env.rename({ user: { ...values.user, nominative: "Adéla" } });
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "units-reload-failed",
        restart: "none",
      });
      expect(await read(env)).toMatchObject({ state: "outdated" });
      env.world.failing.delete("daemon-reload");
      expect(await apply(env)).toMatchObject({ state: "applied" });
      expect(await read(env)).toMatchObject({ state: "in-place" });
    }),
);

posix(
  "a stored prompt Hermes did not clear (a command that fails, or one that answers cleared and did not) leaves the refresh incomplete and owed: the apply fails visibly, the files' restart still happens once, and the next apply clears the rest and restarts once more",
  () =>
    within(async (env) => {
      env.world.repair.set("20261025_080000_abc123", "fail");
      env.world.repair.set("2b7c1e0a-1111-4222-8333-444455556666", "lie");
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "prompts-incomplete",
        prompts: {
          state: "incomplete",
          refreshed: 0,
          live: 2,
          failed: 2,
          capped: false,
        },
        restart: "done",
      });
      expect(env.calls(restarts)).toBe(1);
      expect(await env.owed()).toBe(true);
      // After that restart the files' times say nothing; the record does.
      expect(await read(env)).toMatchObject({
        state: "outdated",
        prompts: { state: "owed" },
        restart: "pending",
      });
      env.world.repair.clear();
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "done",
      });
      expect(env.calls(restarts)).toBe(1);
      expect(await env.owed()).toBe(false);
      expect(await read(env)).toMatchObject({ state: "in-place" });
    }),
);

posix(
  "a conversation gone meanwhile holds no stale prompt: the refresh is complete although its command failed; one whose id would read as an option is never passed and keeps the refresh owed",
  () =>
    within(async (env) => {
      env.world.repair.set("20261025_080000_abc123", "vanish");
      expect(await apply(env)).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
      });
      env.turn("--apply", "h-cli");
      env.turn("2b7c1e0a-1111-4222-8333-444455556666", "h-acp-2");
      await env.rename({ buddyName: "Bobr" });
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "prompts-incomplete",
        prompts: { state: "incomplete", refreshed: 1, live: 2, failed: 1 },
      });
      expect(env.repairs()).not.toContain("--apply");
      expect(await env.owed()).toBe(true);
    }),
);

posix(
  "more live conversations than one refresh clears leave it incomplete and owed; the next refresh goes on with what still holds a prompt",
  () =>
    within(async (env) => {
      const capped = { ...env.environment, promptCap: 1 };
      expect(
        await buddyPersona(capped, { folder: env.folder, apply: true }),
      ).toMatchObject({
        state: "failed",
        reason: "prompts-incomplete",
        prompts: { state: "incomplete", live: 1, failed: 0, capped: true },
      });
      expect(await env.owed()).toBe(true);
      expect(
        await buddyPersona(capped, { folder: env.folder, apply: true }),
      ).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed", refreshed: 1, live: 1 },
        restart: "done",
      });
      expect(await env.owed()).toBe(false);
      expect(env.repairs()).toEqual([
        "2b7c1e0a-1111-4222-8333-444455556666",
        "20261025_080000_abc123",
      ]);
    }),
);

posix(
  "an owed refresh outlives a restart by anyone: busy, one prompt not cleared, the gateway started again by systemd, and the next idle apply still clears and restarts",
  () =>
    within(async (env) => {
      env.world.work = "busy";
      env.world.repair.set("20261025_080000_abc123", "fail");
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "prompts-incomplete",
        restart: "pending",
      });
      await env.externalRestart();
      expect(await read(env)).toMatchObject({
        state: "outdated",
        prompts: { state: "owed" },
        restart: "pending",
      });
      env.world.repair.clear();
      env.world.work = "idle";
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed" },
        restart: "done",
      });
      expect(env.calls(restarts)).toBe(1);
      expect(await env.owed()).toBe(false);
    }),
);

// ---- His Lazurio layer (F64's addendum of 2026-10-25, #648) ----------------

/** Both live conversations that hold a stored prompt took a turn, so each
 * holds one again. */
const turns = (env: Prostredi) => {
  env.turn("20261025_080000_abc123", "h-telegram-turn");
  env.turn("2b7c1e0a-1111-4222-8333-444455556666", "h-acp-turn");
};
const bothRepaired = [
  "2b7c1e0a-1111-4222-8333-444455556666",
  "20261025_080000_abc123",
];

posix(
  "a Folder refresh that rewrites Buddy's rules owes a refresh of his stored prompts: the read reports it and writes nothing, an apply while he is busy records it and waits, the idle one clears the prompts, restarts once and records the layer, and the next apply does nothing; a Folder refresh that changes nothing owes none",
  () =>
    within(async (env) => {
      const rules = join(env.folder, buddyRulesPath);
      expect(await apply(env)).toMatchObject({ state: "applied" });
      turns(env);
      // The same release's Folder refresh renders the same rules.
      expect(
        await refreshMachineFolder(env.folder, bindings.personal),
      ).toMatchObject({ code: 0 });
      expect(await env.owed()).toBe(false);
      // His prompts were built from the previous release's rules, and the
      // update's Folder refresh writes this release's.
      await writeFile(rules, "Buddy's rules of the previous release\n");
      await recordPromptInputs(env.home, await readPromptInputs(env.folder));
      expect(
        await refreshMachineFolder(env.folder, bindings.personal),
      ).toMatchObject({ code: 0 });
      expect(await readFile(rules, "utf8")).not.toContain("previous release");
      const recorded = await readFile(promptInputsPath(env.home), "utf8");
      env.world.calls.length = 0;
      expect(await read(env)).toMatchObject({
        state: "outdated",
        files: { soul: "in-place", actingSender: "in-place" },
        prompts: { state: "owed" },
        restart: "pending",
      });
      expect("reason" in (await read(env))).toBe(false);
      // The read wrote nothing: no marker, the record as it was.
      expect(await promptRefreshMarked(env.home)).toBe(false);
      expect(await readFile(promptInputsPath(env.home), "utf8")).toBe(recorded);
      expect(env.repairs()).toEqual([]);
      expect(env.calls(restarts)).toBe(0);
      // Busy: the apply records the owed refresh, clears nothing and waits.
      env.world.work = "busy";
      expect(await apply(env)).toMatchObject({
        state: "waiting",
        files: { soul: "in-place", actingSender: "in-place" },
        prompts: { state: "owed" },
        restart: "pending",
      });
      expect(await promptRefreshMarked(env.home)).toBe(true);
      expect(await readFile(promptInputsPath(env.home), "utf8")).toBe(recorded);
      expect(env.repairs()).toEqual([]);
      expect(env.calls(restarts)).toBe(0);
      // Idle: the stored prompts cleared, one restart, the layer recorded.
      env.world.work = "idle";
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "done",
      });
      expect(env.repairs()).toEqual(bothRepaired);
      expect(env.calls(restarts)).toBe(1);
      expect(await recordedPromptInputs(env.home)).toBe(
        (await readPromptInputs(env.folder)).layerDigest,
      );
      expect(await env.owed()).toBe(false);
      // Nothing more: the next apply clears nothing and restarts nothing.
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        restart: "none",
      });
      expect(env.repairs()).toEqual([]);
      expect(env.calls(restarts)).toBe(0);
      expect(await read(env)).toMatchObject({ state: "in-place" });
    }),
);

posix(
  "no record of what his prompts were built from, as on a Buddy before this release, owes the refresh once: one apply clears, restarts and records, and then nothing is owed for good; a record that is none counts as none",
  () =>
    within(async (env) => {
      expect(await apply(env)).toMatchObject({ state: "applied" });
      turns(env);
      const path = promptInputsPath(env.home);
      await rm(path);
      expect(await env.owed()).toBe(true);
      expect(await read(env)).toMatchObject({
        state: "outdated",
        prompts: { state: "owed" },
        restart: "pending",
      });
      await expect(lstat(path)).rejects.toThrow();
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "done",
      });
      expect(env.calls(restarts)).toBe(1);
      // The record: 0600 in 0700, this schema and the layer's digest only.
      const digest = (await readPromptInputs(env.folder)).layerDigest;
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        schema_version: "lazurio.buddy-prompt-inputs.v1",
        layer_digest: digest,
      });
      expect(
        (await readdir(dirname(path))).filter((name) =>
          name.endsWith(".lazurio"),
        ),
      ).toEqual([]);
      // Settled for good.
      for (let round = 0; round < 2; round += 1) {
        turns(env);
        env.world.calls.length = 0;
        expect(await apply(env)).toMatchObject({
          state: "applied",
          restart: "none",
        });
        expect(env.repairs()).toEqual([]);
        expect(env.calls(restarts)).toBe(0);
      }
      expect(await read(env)).toMatchObject({ state: "in-place" });
      // Another schema, a digest that is none, or a record through a link
      // records nothing: owed again.
      const good = await readFile(path, "utf8");
      const elsewhere = join(env.home, "prompt-inputs-elsewhere.json");
      await writeFile(elsewhere, good);
      for (const put of [
        () =>
          writeFile(
            path,
            JSON.stringify({
              schema_version: "lazurio.buddy-prompt-inputs.v2",
              layer_digest: digest,
            }),
          ),
        () =>
          writeFile(
            path,
            JSON.stringify({
              schema_version: "lazurio.buddy-prompt-inputs.v1",
              layer_digest: digest.toUpperCase(),
            }),
          ),
        () => writeFile(path, "{"),
        async () => {
          await rm(path);
          await symlink(elsewhere, path);
        },
      ]) {
        await put();
        expect(await env.owed()).toBe(true);
        await rm(path);
        await writeFile(path, good, { mode: 0o600 });
        expect(await env.owed()).toBe(false);
      }
    }),
);

posix(
  "the record is the layer as the apply found it when it began: rules rewritten while it runs stay owed, the apply answers waiting, and the next one clears again and records the new layer",
  () =>
    within(async (env) => {
      expect(await apply(env)).toMatchObject({ state: "applied" });
      const rules = join(env.folder, buddyRulesPath);
      await writeFile(rules, "Buddy's rules of the next release\n");
      const began = (await readPromptInputs(env.folder)).layerDigest;
      // Rewritten again while the apply runs: after it read the layer and
      // wrote its files, when it asks systemd about the gateway.
      env.world.during = async () => {
        env.world.during = undefined;
        await writeFile(rules, "Buddy's rules of the release after it\n");
      };
      turns(env);
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "waiting",
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "done",
      });
      expect(env.calls(restarts)).toBe(1);
      expect(await recordedPromptInputs(env.home)).toBe(began);
      expect(await promptRefreshMarked(env.home)).toBe(false);
      expect(await env.owed()).toBe(true);
      expect(await read(env)).toMatchObject({
        state: "outdated",
        prompts: { state: "owed" },
      });
      turns(env);
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "done",
      });
      expect(env.repairs()).toEqual(bothRepaired);
      expect(env.calls(restarts)).toBe(1);
      expect(await recordedPromptInputs(env.home)).toBe(
        (await readPromptInputs(env.folder)).layerDigest,
      );
      expect(await env.owed()).toBe(false);
    }),
);

posix(
  "a file of the layer that is no regular file of its own (a link, never followed) is unreadable: it owes the refresh when it becomes so and is named layer-unreadable; the refresh records it, so it is not refreshed again; a regular file again owes the next refresh",
  () =>
    within(async (env) => {
      expect(await apply(env)).toMatchObject({ state: "applied" });
      const rules = join(env.folder, buddyRulesPath);
      const bytes = await readFile(rules);
      // The same bytes, through a link.
      const elsewhere = join(env.home, "rules-elsewhere.md");
      await writeFile(elsewhere, bytes);
      await rm(rules);
      await symlink(elsewhere, rules);
      expect(await read(env)).toMatchObject({
        state: "outdated",
        reason: "layer-unreadable",
        prompts: { state: "owed" },
      });
      turns(env);
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "layer-unreadable",
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "done",
      });
      expect(env.calls(restarts)).toBe(1);
      expect(await env.owed()).toBe(false);
      // While it stays so, nothing is refreshed again, and it is named.
      turns(env);
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "layer-unreadable",
        restart: "none",
      });
      expect(env.repairs()).toEqual([]);
      expect(env.calls(restarts)).toBe(0);
      expect(await read(env)).toMatchObject({
        state: "in-place",
        reason: "layer-unreadable",
      });
      // A regular file again, as the Folder's refresh writes it once the
      // link is gone: the next refresh is owed.
      await rm(rules);
      await writeFile(rules, bytes, { mode: 0o600 });
      expect(await env.owed()).toBe(true);
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        prompts: { state: "refreshed", refreshed: 2, live: 2 },
        restart: "done",
      });
      expect(env.calls(restarts)).toBe(1);
      expect(await env.owed()).toBe(false);
    }),
);

posix(
  "the layer's digest: each file of buddyLayerPaths by its path, then its bytes, in order, a token of its own for absent and for unreadable, the same wherever the Folder is",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "prompt-inputs-")),
    );
    try {
      const layer = (folder: string, texts: readonly (string | null)[]) =>
        Promise.all(
          buddyLayerPaths.map(async (path, index) => {
            const file = join(folder, path);
            await rm(file, { recursive: true, force: true });
            const text = texts[index] ?? null;
            if (text === null) return;
            await mkdir(dirname(file), { recursive: true, mode: 0o700 });
            await writeFile(file, text, { mode: 0o600 });
          }),
        );
      const digestOf = async (folder: string) => readPromptInputs(folder);
      const but = (
        all: readonly (string | null)[],
        changes: Readonly<Record<number, string | null>>,
      ): (string | null)[] =>
        all.map((text, index) =>
          index in changes ? (changes[index] ?? null) : text,
        );
      const texts = buddyLayerPaths.map((path) => `Text of ${path}\n`);
      const one = join(root, "one", "Lazurio");
      const other = join(root, "elsewhere", "Lazurio");
      await layer(one, texts);
      await layer(other, texts);
      const base = await digestOf(one);
      expect(base.unreadable).toBe(false);
      expect(base.layerDigest).toMatch(/^[0-9a-f]{64}$/);
      // The same layer in another place: the same digest.
      expect(await digestOf(other)).toEqual(base);
      const seen = new Set([base.layerDigest]);
      const differs = async (folder: string, unreadable: boolean) => {
        const now = await digestOf(folder);
        expect(seen.has(now.layerDigest)).toBe(false);
        expect(now.unreadable).toBe(unreadable);
        seen.add(now.layerDigest);
      };
      // One byte of a skill changed, its length the same; and one more byte.
      await layer(one, but(texts, { 3: (texts[3] ?? "").replace("\n", "!") }));
      await differs(one, false);
      await layer(one, but(texts, { 3: `${texts[3]}.` }));
      await differs(one, false);
      // Two files' bytes swapped: which file holds them counts.
      await layer(one, but(texts, { 1: texts[2] ?? "", 2: texts[1] ?? "" }));
      await differs(one, false);
      // An empty file, and none at all.
      await layer(one, but(texts, { 0: "" }));
      await differs(one, false);
      await layer(one, but(texts, { 0: null }));
      await differs(one, false);
      // A link to the same bytes is unreadable, and reads the same twice.
      await layer(one, texts);
      const rules = join(one, buddyRulesPath);
      await rm(rules);
      await writeFile(join(root, "rules.md"), texts[0] ?? "");
      await symlink(join(root, "rules.md"), rules);
      await differs(one, true);
      expect((await digestOf(one)).layerDigest).toBe(
        (await digestOf(one)).layerDigest,
      );
      await rm(rules);
      await mkdir(rules);
      const directory = await digestOf(one);
      // A link and a directory both read as unreadable: the same token.
      expect(directory.unreadable).toBe(true);
      expect(seen.has(directory.layerDigest)).toBe(true);
      // No Folder at all: every file absent.
      const none = await digestOf(join(root, "none"));
      expect(none.unreadable).toBe(false);
      expect(seen.has(none.layerDigest)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

posix(
  "each file is replaced on its own, no transaction across them: a drop-in that cannot be written fails the apply after SOUL.md was, the refresh SOUL.md calls for is owed already, and the next apply finishes it",
  () =>
    within(async (env) => {
      const directory = dirname(actingSenderPath(env.home));
      await writeFile(directory, "not a directory");
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "files-unwritable",
      });
      expect((await lstat(soulPath(env.home))).isFile()).toBe(true);
      expect(await env.owed()).toBe(true);
      expect(await read(env)).toMatchObject({
        state: "outdated",
        files: { soul: "in-place", actingSender: "outdated" },
        prompts: { state: "owed" },
      });
      await rm(directory);
      expect(await apply(env)).toMatchObject({
        state: "applied",
        files: { soul: "in-place", actingSender: "written" },
        prompts: { state: "refreshed" },
        restart: "done",
      });
      expect(await env.owed()).toBe(false);
    }),
);

/** Waits until `ready` holds, a few milliseconds at a time. */
async function until(ready: () => boolean) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 5_000) throw new Error("never ready");
    await new Promise((done) => setTimeout(done, 10));
  }
}

posix(
  "an apply that waits for its turn reads the persona only once it has it: a new name written meanwhile is the one applied, once, and nothing is claimed for the old one",
  () =>
    within(async (env) => {
      await mkdir(dirname(applyLockPath(env.home)), { recursive: true });
      const other = await acquireFileLock(applyLockPath(env.home), {
        timeoutMs: 1_000,
      });
      const waiting = apply(env);
      await new Promise((done) => setTimeout(done, 100));
      await env.rename({ buddyName: "Bobr" });
      await other.release();
      env.world.calls.length = 0;
      expect(await waiting).toMatchObject({
        state: "applied",
        persona: { buddyName: "Bobr" },
        files: { soul: "written" },
      });
      // Only the current persona was applied: one restart, not one each.
      expect(env.calls(restarts)).toBe(1);
      expect(await readFile(soulPath(env.home), "utf8")).toContain("**Bobr**");
      expect(await read(env)).toMatchObject({
        state: "in-place",
        persona: { buddyName: "Bobr" },
      });
    }),
);

posix(
  "a persona written while an apply applies the previous one: the apply sees it before it answers and applies it too, and answers for it",
  () =>
    within(async (env) => {
      let writes = 0;
      env.world.during = async () => {
        if (writes > 0) return;
        writes += 1;
        await env.rename({ buddyName: "Bobr" });
      };
      expect(await apply(env)).toMatchObject({
        state: "applied",
        persona: { buddyName: "Bobr" },
      });
      env.world.during = undefined;
      expect(await read(env)).toMatchObject({
        state: "in-place",
        persona: { buddyName: "Bobr" },
      });
    }),
);

posix(
  "a persona that changes in every round: after three the apply answers waiting (persona-changed), never applied, and the next apply finishes it",
  () =>
    within(async (env) => {
      let round = 0;
      env.world.during = async () => {
        round += 1;
        await env.rename({ buddyName: `Bobr ${round}` });
      };
      expect(await apply(env)).toMatchObject({
        state: "waiting",
        reason: "persona-changed",
      });
      expect(round).toBe(3);
      env.world.during = undefined;
      expect(await read(env)).toMatchObject({
        state: "outdated",
        persona: { buddyName: "Bobr 3" },
      });
      expect(await apply(env)).toMatchObject({
        state: "applied",
        persona: { buddyName: "Bobr 3" },
      });
      expect(await read(env)).toMatchObject({ state: "in-place" });
    }),
);

posix(
  "a second apply that finds the first under way can leave the work to it: a name written while the first applies is applied by the first",
  () =>
    within(async (env) => {
      let open!: () => void;
      const gate = new Promise<void>((done) => {
        open = done;
      });
      let asked = 0;
      env.world.during = async () => {
        asked += 1;
        if (asked === 1) await gate;
      };
      const first = apply(env);
      await until(() => asked === 1);
      await env.rename({ buddyName: "Bobr" });
      expect(await apply(env)).toMatchObject({
        state: "waiting",
        reason: "apply-running",
      });
      open();
      expect(await first).toMatchObject({
        state: "applied",
        persona: { buddyName: "Bobr" },
      });
      env.world.during = undefined;
      expect(await read(env)).toMatchObject({
        state: "in-place",
        persona: { buddyName: "Bobr" },
      });
    }),
);

posix(
  "one apply at a time: a second one finds the first under way and leaves the work to it",
  () =>
    within(async (env) => {
      await mkdir(dirname(applyLockPath(env.home)), { recursive: true });
      const first = await acquireFileLock(applyLockPath(env.home), {
        timeoutMs: 1_000,
      });
      try {
        expect(await apply(env)).toMatchObject({
          state: "waiting",
          reason: "apply-running",
        });
        await expect(lstat(soulPath(env.home))).rejects.toThrow();
      } finally {
        await first.release();
      }
      expect(await apply(env)).toMatchObject({ state: "applied" });
    }),
);

posix(
  "F61's rule, gated on Buddy's T3 Code itself: while it runs it owns its home, so the T3 change waits while any of its threads has a run going, whatever the gateway says, and once none has, its unit stops, the settings are applied and it starts again",
  () =>
    within(async (env) => {
      await apply(env);
      env.t3Runs();
      await env.rename({ buddyName: "Bobr" });
      // The gateway is idle, but a run of Buddy's T3 Code goes on: it is not
      // stopped under it.
      env.world.t3.runs = 1;
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "waiting",
        restart: "done",
        chat: { state: "waiting" },
      });
      expect((await settingsOf(env)).providerInstances.buddy.displayName).toBe(
        "Rex",
      );
      expect(env.calls((call) => call[2] === "stop")).toBe(0);
      expect(env.world.t3.unit).toBe(true);
      // T3 Code's own answer, by Buddy's own runtime and home: every
      // unfinished state, his subagents' threads included.
      expect(env.world.calls.filter(([program]) => program === env.t3)).toEqual(
        [
          [
            env.t3,
            "thread",
            "list",
            "--base-dir",
            join(env.home, ".t3-buddy"),
            // T3 Code's unfinished run states, as its contracts name them.
            ...[
              "preparing",
              "queued",
              "starting",
              "running",
              "waiting",
            ].flatMap((status) => ["--status", status]),
            "--subagents",
            "--limit",
            "1",
            "--json",
          ],
        ],
      );
      // A T3 Code that cannot say counts as busy.
      for (const answer of ["not-running", "garbage"] as const) {
        env.world.t3.answer = answer;
        expect(await apply(env)).toMatchObject({ chat: { state: "waiting" } });
      }
      env.world.t3.answer = "list";
      expect(env.calls((call) => call[2] === "stop")).toBe(0);

      // No run going: its unit stops and starts around the settings, whether
      // the gateway works or not.
      env.world.t3.runs = 0;
      env.world.work = "busy";
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        chat: { state: "managed" },
      });
      expect((await settingsOf(env)).providerInstances.buddy.displayName).toBe(
        "Bobr",
      );
      expect(
        env.world.calls
          .filter(
            (call) =>
              call[0] === "systemctl" &&
              call.includes("lazurio-t3-buddy.service"),
          )
          .map((call) => call[2]),
      ).toEqual(["is-active", "stop", "start"]);
      // It runs again, owning its home.
      expect(env.world.t3.unit).toBe(true);
      expect(() => own(env.userdata)).toThrow();

      // A T3 Code that runs outside its unit keeps its home: the change waits.
      env.world.t3.unit = false;
      await env.rename({ buddyName: "Max" });
      expect(await apply(env)).toMatchObject({
        state: "waiting",
        chat: { state: "waiting" },
      });
      expect((await settingsOf(env)).providerInstances.buddy.displayName).toBe(
        "Bobr",
      );
      // A unit that does not stop: the apply fails, nothing else is touched.
      env.world.t3.unit = true;
      env.world.work = "idle";
      env.world.failing.add("stop");
      expect(await apply(env)).toMatchObject({
        state: "failed",
        reason: "chat-restart-failed",
        chat: { state: "failed" },
      });
    }),
);

posix(
  "only a mode that differs is set: no new file, so no restart and no prompts follow; a link at SOUL.md is replaced by the file, never written through",
  () =>
    within(async (env) => {
      await apply(env);
      await chmod(soulPath(env.home), 0o644);
      env.world.calls.length = 0;
      expect(await apply(env)).toMatchObject({
        state: "applied",
        files: { soul: "mode", actingSender: "in-place" },
        restart: "none",
      });
      expect((await stat(soulPath(env.home))).mode & 0o777).toBe(0o600);
      expect(env.repairs()).toEqual([]);

      const outside = join(env.home, "outside.md");
      await writeFile(outside, "someone else's\n");
      await rm(soulPath(env.home));
      await symlink(outside, soulPath(env.home));
      expect(await apply(env)).toMatchObject({ files: { soul: "written" } });
      expect((await lstat(soulPath(env.home))).isFile()).toBe(true);
      expect(await readFile(outside, "utf8")).toBe("someone else's\n");
      // Even a link to the very bytes and mode: SOUL.md is a file of its own.
      const copy = join(env.home, "copy.md");
      await writeFile(copy, await readFile(soulPath(env.home)), {
        mode: 0o600,
      });
      await chmod(copy, 0o600);
      await rm(soulPath(env.home));
      await symlink(copy, soulPath(env.home));
      expect(await apply(env)).toMatchObject({ files: { soul: "written" } });
      expect((await lstat(soulPath(env.home))).isFile()).toBe(true);
    }),
);

posix(
  "the modes are exact whatever the umask: the drop-in 0644, SOUL.md and the persona 0600 in a 0700 directory",
  () =>
    within(async (env) => {
      const umask = process.umask(0o077);
      try {
        await rm(dirname(personaPath(env.home)), { recursive: true });
        expect((await writePersona(env.home, values, null)).kind).toBe(
          "written",
        );
        expect(await apply(env)).toMatchObject({ state: "applied" });
      } finally {
        process.umask(umask);
      }
      expect((await stat(actingSenderPath(env.home))).mode & 0o777).toBe(0o644);
      expect((await stat(soulPath(env.home))).mode & 0o777).toBe(0o600);
      expect((await stat(personaPath(env.home))).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(personaPath(env.home)))).mode & 0o777).toBe(
        0o700,
      );
    }),
);

test("Buddy's name in T3 Code is his own, trimmed as T3 Code trims it, and Buddy for a name of spaces alone", () => {
  const named = (buddy_name: string) =>
    buddyDisplayName(
      personaOf({
        schema_version: "lazurio.buddy-persona.v1",
        buddy_name,
        address: "ty",
        user: values.user,
      }),
    );
  expect(named("Rex")).toBe("Rex");
  expect(named(" Rex 🦖 ")).toBe("Rex 🦖");
  expect(named("   ")).toBe("Buddy");
  expect(named("\ufeff")).toBe("Buddy");
});

posix(
  "only on the user's own Osobní Prostředí with Buddy: another Environment is skipped, and without a usable persona or Hermes home nothing is written",
  () =>
    within(async (env) => {
      const refused = async (state: string, reason: string) =>
        expect(await apply(env)).toMatchObject({ state, reason });
      await rm(join(env.folder, ".lazurio", "preferences.json"));
      await refused("unavailable", "folder-unreadable");
      await rm(env.home, { recursive: true, force: true });
      const work = await osobniProstredi();
      try {
        await rm(join(work.hermesHome), { recursive: true });
        expect(await apply(work)).toMatchObject({
          state: "unavailable",
          reason: "hermes-home-missing",
          persona: { buddyName: "Rex" },
        });
        await mkdir(work.hermesHome);
        await writeFile(
          personaPath(work.home),
          JSON.stringify({
            ...JSON.parse(await readFile(personaPath(work.home), "utf8")),
            address: "oni",
          }),
        );
        expect(await apply(work)).toMatchObject({
          state: "unavailable",
          reason: "invalid-address",
        });
        await rm(personaPath(work.home));
        expect(await apply(work)).toMatchObject({
          state: "unavailable",
          reason: "persona-missing",
        });
        await writeFile(personaPath(work.home), "{");
        expect(await apply(work)).toMatchObject({
          state: "unavailable",
          reason: "persona-unreadable",
        });
        await expect(lstat(soulPath(work.home))).rejects.toThrow();
        await expect(lstat(actingSenderPath(work.home))).rejects.toThrow();
        expect(
          await buddyPersona(
            { ...work.environment, tools: { ...work.tools, home: undefined } },
            { folder: work.folder },
          ),
        ).toEqual({
          kind: "buddy-persona",
          state: "unavailable",
          reason: "home-unknown",
        });
      } finally {
        await work.dispose();
      }
    }),
);

posix("a work Environment is skipped and nothing is read", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "persona-work-")));
  try {
    const folder = join(home, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o700 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const initialized = await initializeMachineFolder(
      folder,
      bindings.assignedOperator,
      { ...noChoices, locale: "cs", preset: "hosted-organization-personal" },
    );
    expect(initialized.code).toBe(0);
    const calls: (readonly string[])[] = [];
    const run: ToolRunner = async (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(
      await buddyPersona(
        { tools: { home, path: "/usr/bin", platform: "linux", run }, env: {} },
        { folder, apply: true },
      ),
    ).toEqual({
      kind: "buddy-persona",
      state: "skipped",
      reason: "not-personal",
    });
    expect(calls).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---- Hermes's active-work verb on a real socket -----------------------------

/** Buddy's gateway's control socket as Hermes v0.22.4-lazurio.1 serves it
 * (gateway/control_socket.py `handle_request_line`): one JSON line in, one
 * out, then closed. `answer` gives the line for each request. */
function fakeGateway(
  path: string,
  answer: (request: unknown) => string | undefined,
) {
  const requests: string[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const line = data.toString("utf8");
        requests.push(line);
        const reply = answer(JSON.parse(line.trim()));
        if (reply !== undefined) {
          socket.write(`${reply}\n`);
          socket.end();
        }
      },
    },
  });
  return { requests, stop: () => server.stop(true) };
}

/** A short directory for sockets: a Unix socket's path has at most 103
 * bytes on macOS, and the system's temporary directory there is long. */
const socketBase = async () => realpath(await mkdtemp("/tmp/aw-"));

/** Recorded shapes of the verb's answers at v0.22.4-lazurio.1
 * (gateway/run_active_work_verb.py, `_describe_active_work`). */
const answers = {
  idle: {
    ok: true,
    protocol: 1,
    result: { active_agents: 0, active_work: [], pid: 4242 },
    id: 1,
  },
  chat: {
    ok: true,
    protocol: 1,
    result: {
      active_agents: 1,
      active_work: [
        {
          kind: "chat",
          session: "agent:main:telegram:dm:42",
          pid: 4242,
          elapsed_s: 3.2,
          model: "gpt-6.1-sol",
        },
      ],
      pid: 4242,
    },
    id: 1,
  },
  delegation: {
    ok: true,
    protocol: 1,
    result: {
      active_agents: 0,
      active_work: [
        { kind: "delegation", delegation_id: "d1", goal: "…", pid: 4242 },
      ],
      pid: 4242,
    },
    id: 1,
  },
  countOnly: {
    ok: true,
    protocol: 1,
    result: { active_agents: 2, active_work: [], pid: 4242 },
    id: 1,
  },
  loopDown: {
    ok: false,
    error: "RuntimeError: active-work: the gateway loop did not answer",
    protocol: 1,
    id: 1,
  },
  notOk: {
    ok: false,
    protocol: 1,
    result: { active_agents: 0, active_work: [], pid: 4242 },
    id: 1,
  },
  otherId: {
    ok: true,
    protocol: 1,
    result: { active_agents: 0, active_work: [], pid: 4242 },
    id: 2,
  },
  noUnits: {
    ok: true,
    protocol: 1,
    result: { active_agents: 0, pid: 4242 },
    id: 1,
  },
};

posix(
  "Hermes's active-work over its control socket: idle only when it answers no unit of work and no active agent; any other answer, none or a socket that is not Hermes's counts as busy",
  async () => {
    const base = await socketBase();
    try {
      const hermesHome = join(base, ".hermes");
      await mkdir(hermesHome, { mode: 0o700 });
      const socket = join(hermesHome, "gateway.sock");
      let next: unknown = answers.idle;
      const gateway = fakeGateway(socket, () => JSON.stringify(next));
      try {
        expect(await askActiveWork(hermesHome)).toBe("idle");
        expect(JSON.parse(gateway.requests[0] ?? "")).toEqual({
          protocol: 1,
          verb: "active-work",
          id: 1,
        });
        expect(gateway.requests[0]?.endsWith("\n")).toBe(true);
        const outcomes: Record<string, ActiveWork> = {};
        for (const [name, answer] of Object.entries(answers)) {
          next = answer;
          outcomes[name] = await askActiveWork(hermesHome);
        }
        next = "not json";
        outcomes.garbage = await askActiveWork(hermesHome);
        expect(outcomes).toEqual({
          idle: "idle",
          chat: "busy",
          delegation: "busy",
          countOnly: "busy",
          loopDown: "unknown",
          notOk: "unknown",
          otherId: "unknown",
          noUnits: "unknown",
          garbage: "unknown",
        });
      } finally {
        gateway.stop();
      }
      // No gateway: a stale socket refuses the connection.
      expect(await askActiveWork(hermesHome)).toBe("unknown");
      await rm(socket, { force: true });
      expect(await askActiveWork(hermesHome)).toBe("unknown");
      // A regular file, or a link to someone's socket, is not the gateway.
      await writeFile(socket, "");
      expect(await askActiveWork(hermesHome)).toBe("unknown");
      await rm(socket);
      const elsewhere = join(base, "elsewhere.sock");
      const other = fakeGateway(elsewhere, () => JSON.stringify(answers.idle));
      try {
        await symlink(elsewhere, socket);
        expect(await askActiveWork(hermesHome)).toBe("unknown");
        expect(other.requests).toEqual([]);
      } finally {
        other.stop();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);

posix(
  "a home too long for a socket: the pointer gateway.sock.path is followed only to hermes-gw-<the home's hash>/control.sock in a private directory",
  async () => {
    const base = await socketBase();
    try {
      const hermesHome = join(base, ".hermes");
      await mkdir(hermesHome, { mode: 0o700 });
      const hash = createHash("sha256")
        .update(await realpath(hermesHome))
        .digest("hex")
        .slice(0, 16);
      const directory = join(base, `hermes-gw-${hash}`);
      await mkdir(directory, { mode: 0o700 });
      const target = join(directory, "control.sock");
      const gateway = fakeGateway(target, () => JSON.stringify(answers.idle));
      const pointer = join(hermesHome, "gateway.sock.path");
      try {
        await writeFile(pointer, `\ufeff${target}\n`, { mode: 0o600 });
        expect(await askActiveWork(hermesHome)).toBe("idle");
        // Open to the group: refused.
        await chmod(directory, 0o750);
        expect(await askActiveWork(hermesHome)).toBe("unknown");
        await chmod(directory, 0o700);
        // Another home's directory, or another name in it: refused.
        const foreign = join(base, "hermes-gw-0000000000000000");
        await mkdir(foreign, { mode: 0o700 });
        // Gateways that answer idle where the pointer must not lead.
        const strangers = [
          fakeGateway(join(foreign, "control.sock"), () =>
            JSON.stringify(answers.idle),
          ),
          fakeGateway(join(directory, "other.sock"), () =>
            JSON.stringify(answers.idle),
          ),
        ];
        try {
          await writeFile(pointer, join(foreign, "control.sock"));
          expect(await askActiveWork(hermesHome)).toBe("unknown");
          await writeFile(pointer, join(directory, "other.sock"));
          expect(await askActiveWork(hermesHome)).toBe("unknown");
          await writeFile(pointer, "relative/control.sock");
          expect(await askActiveWork(hermesHome)).toBe("unknown");
          expect(strangers.map(({ requests }) => requests.length)).toEqual([
            0, 0,
          ]);
        } finally {
          for (const stranger of strangers) stranger.stop();
        }
        expect(gateway.requests.length).toBe(1);
      } finally {
        gateway.stop();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);

// ---- The pieces of the derivation ------------------------------------------

test("systemd's us+utc timestamps to the microsecond; an empty one or another shape is none", () => {
  expect(microsecondsOf("Sun 2026-10-25 00:42:20.238927 UTC")).toBe(
    BigInt(Date.UTC(2026, 9, 25, 0, 42, 20)) * 1000n + 238927n,
  );
  expect(microsecondsOf("")).toBeUndefined();
  expect(microsecondsOf("Sun 2026-10-25 02:42:20 CEST")).toBeUndefined();
  expect(microsecondsOf("@1792888409")).toBeUndefined();
  expect(microsecondsOf(undefined)).toBeUndefined();
});

posix(
  "the gateway's unit from systemctl show, and a restart pending only while it runs and started before a file was written",
  async () => {
    const answer =
      (stdout: string, exitCode = 0): ToolRunner =>
      async () => ({ exitCode, stdout, stderr: "" });
    const show = (run: ToolRunner) => gatewayUnitState({ run, env: {} });
    expect(
      await show(
        answer(
          "ExecMainStartTimestamp=Sun 2026-10-25 00:42:20.238927 UTC\nLoadState=loaded\nActiveState=active\nNeedDaemonReload=yes\n",
        ),
      ),
    ).toEqual({
      state: "running",
      startedAt: BigInt(Date.UTC(2026, 9, 25, 0, 42, 20)) * 1000n + 238927n,
      needsReload: true,
    });
    expect(
      await show(
        answer(
          "ExecMainStartTimestamp=\nLoadState=loaded\nActiveState=inactive\nNeedDaemonReload=no\n",
        ),
      ),
    ).toEqual({ state: "stopped", needsReload: false });
    expect(
      await show(
        answer(
          "LoadState=not-found\nActiveState=inactive\nExecMainStartTimestamp=\n",
        ),
      ),
    ).toEqual({ state: "absent" });
    expect(await show(answer("", 1))).toEqual({ state: "unknown" });
    expect(await show(answer("nothing here\n"))).toEqual({ state: "unknown" });
    expect(
      await show(async () => {
        throw new Error("spawn systemctl ENOENT");
      }),
    ).toEqual({ state: "unknown" });

    const directory = await realpath(await mkdtemp(join(tmpdir(), "pending-")));
    try {
      const file = join(directory, "SOUL.md");
      await writeFile(file, "x");
      const at = (await lstat(file, { bigint: true })).mtimeNs / 1000n;
      const running = (startedAt: bigint) =>
        ({ state: "running", startedAt, needsReload: false }) as const;
      expect(await restartPending(running(at - 1n), [file])).toBe(true);
      expect(await restartPending(running(at), [file])).toBe(false);
      expect(
        await restartPending(running(at + 1n), [file, join(directory, "none")]),
      ).toBe(false);
      expect(
        await restartPending({ state: "stopped", needsReload: true }, [file]),
      ).toBe(false);
      expect(await restartPending({ state: "unknown" }, [file])).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

posix(
  "live conversations that hold a stored prompt: ids and prompt hashes only, newest first, at most the cap, from a store opened read-only",
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "live-")));
    try {
      expect(await liveConversations(directory)).toBe("absent");
      sessionStore(directory, [
        ["a", "telegram", null, 1, null, "ha"],
        ["b", "acp", null, 3, null, "hb"],
        ["c", "tool", null, 4, null, "hc"],
        ["d", "acp", "b", 5, null, "hd"],
        ["e", null, null, 2, null, "he"],
        ["f", "telegram", null, 6, 7, "hf"],
        ["g", "cron", null, 8, null, null],
      ]);
      // An older row keeps its prompt inline: only that it is there is read.
      const writable = new Database(join(directory, "state.db"));
      writable
        .prepare(
          "insert into sessions values ('h', 'cli', null, 0.5, null, 'a prompt', null)",
        )
        .run();
      writable.close();
      const before = await readFile(join(directory, "state.db"));
      expect(await liveConversations(directory)).toEqual({
        held: [
          { id: "b", prompt: "hash:hb" },
          { id: "e", prompt: "hash:he" },
          { id: "a", prompt: "hash:ha" },
          { id: "h", prompt: "inline" },
        ],
        capped: false,
      });
      expect(await liveConversations(directory, 2)).toEqual({
        held: [
          { id: "b", prompt: "hash:hb" },
          { id: "e", prompt: "hash:he" },
        ],
        capped: true,
      });
      expect((await readFile(join(directory, "state.db"))).equals(before)).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

posix(
  "a store that cannot say which prompt a conversation holds lists every live one and is judged by the commands' exits",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "exits-")));
    try {
      await mkdir(join(home, ".hermes"));
      const store = new Database(join(home, ".hermes", "state.db"));
      store.exec(
        "create table sessions (id text, source text, parent_session_id text, started_at real, ended_at real)",
      );
      store.exec(
        "insert into sessions values ('a', 'telegram', null, 1, null), ('b', 'acp', null, 2, null)",
      );
      store.close();
      const failing = new Set<string>();
      const run: ToolRunner = async (command) => ({
        exitCode: failing.has(command[3] ?? "") ? 1 : 0,
        stdout: "",
        stderr: "",
      });
      const refresh = () =>
        refreshPrompts({ home, hermes: "/opt/hermes", path: "/bin", run });
      failing.add("a");
      expect(await refresh()).toEqual({
        state: "incomplete",
        refreshed: 1,
        live: 2,
        failed: 1,
        capped: false,
      });
      failing.clear();
      expect(await refresh()).toEqual({
        state: "refreshed",
        refreshed: 2,
        live: 2,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

// ---- The command -------------------------------------------------------------

posix(
  "lazurio buddy persona: JSON on stdout, the exit of its state, --confirm recorded once, and a wrong command line is usage",
  () =>
    within(async (env) => {
      const context = {
        identity: {} as CliContext["identity"],
        platform: "linux",
        env: env.environment.env,
        executable: "/usr/local/bin/lazurio",
        toolRun: env.tools.run,
        activeWork: async () => env.world.work,
        now: () => new Date("2026-10-25T09:30:00Z"),
      };
      for (const args of [
        ["persona", "now"],
        ["persona", "--folder", "Lazurio"],
        ["persona", "--apply", "--apply"],
        ["persona", "--confirm", "--confirm"],
        ["persona", "--force"],
        ["chat", "--confirm"],
        ["personas"],
      ])
        expect((await runBuddyCommand(args, context)).code).toBe(2);
      const outdated = await runBuddyCommand(
        ["persona", "--folder", env.folder, "--json"],
        context,
      );
      expect(outdated.code).toBe(10);
      expect(JSON.parse(outdated.stdout ?? "")).toMatchObject({
        kind: "buddy-persona",
        state: "outdated",
        persona: { buddyName: "Rex", confirmed: false },
      });
      env.world.work = "busy";
      const waiting = await runBuddyCommand(
        ["persona", "--apply", "--folder", env.folder],
        context,
      );
      expect(waiting.code).toBe(10);
      expect(JSON.parse(waiting.stdout ?? "")).toMatchObject({
        state: "waiting",
        restart: "pending",
      });
      env.world.work = "idle";
      const confirmed = await runBuddyCommand(
        ["persona", "--apply", "--confirm", "--folder", env.folder, "--json"],
        context,
      );
      expect(confirmed.code).toBe(0);
      expect(JSON.parse(confirmed.stdout ?? "")).toMatchObject({
        state: "applied",
        restart: "done",
        persona: { confirmed: true, confirmedAt: "2026-10-25T09:30:00Z" },
      });
      expect(
        JSON.parse(await readFile(personaPath(env.home), "utf8")).confirmed_at,
      ).toBe("2026-10-25T09:30:00Z");
      const inPlace = await runBuddyCommand(
        ["persona", "--folder", env.folder],
        { ...context, now: () => new Date("2027-01-01T00:00:00Z") },
      );
      expect(inPlace.code).toBe(0);
      expect(JSON.parse(inPlace.stdout ?? "")).toMatchObject({
        state: "in-place",
        persona: { confirmedAt: "2026-10-25T09:30:00Z" },
      });
      await rm(personaPath(env.home));
      const missing = await runBuddyCommand(
        ["persona", "--apply", "--folder", env.folder],
        context,
      );
      expect(missing).toEqual({
        code: 1,
        stdout:
          '{"kind":"buddy-persona","state":"unavailable","reason":"persona-missing"}',
      });
    }),
);
