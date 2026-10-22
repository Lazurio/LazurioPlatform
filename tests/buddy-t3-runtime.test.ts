import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buddyT3Runtime,
  buddyT3RuntimeOf,
  buddyT3Unit,
} from "../src/buddy/t3-runtime";

// Buddy's own `t3` (F61's addendum of 2026-10-22): the runtime the unit of
// his T3 Code names in its ExecStart, as Machines render that unit
// (`workloads/workspace-vm/buddy-t3.ts`) and read it back
// (`t3_buddy_unit_version` in `t3-service.py`). Example home and versions.

const home = "/home/ada";
const version = "0.1.1-lazurio.1";
const runtime = `${home}/.t3-buddy/runtime/versions/${version}/t3`;
// The unit as Machines render it.
const unitOf = (start: string) =>
  `# Lazurio Machines: Buddy's T3 Code on this personal Environment
[Unit]
Description=Lazurio Buddy's T3 Code server

[Service]
Type=simple
WorkingDirectory=%h
Environment=PATH=${home}/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=T3CODE_LAZURIO_BUDDY=1
Environment=T3CODE_EXTERNAL_ORIGIN=https://buddy.ada.lazurio.io
${start}
Restart=always
UMask=0077
StandardOutput=append:${home}/.t3-buddy/userdata/logs/lazurio-t3-buddy.log

[Install]
WantedBy=default.target
`;
const machines = unitOf(
  `ExecStart=${runtime} serve --base-dir ${home}/.t3-buddy --host 127.0.0.1 --port 3774`,
);

test("the unit names Buddy's runtime exactly as Machines render it, and nothing of another shape", () => {
  expect(buddyT3RuntimeOf(machines, home)).toBe(runtime);
  // Every Lazurio release and any other exact version Machines' reader takes.
  for (const named of ["0.1.0-lazurio.12", "1.2.3", "0.2.0-preview.20261022.1"])
    expect(
      buddyT3RuntimeOf(machines.replace(`/${version}/`, `/${named}/`), home),
    ).toBe(runtime.replace(`/${version}/`, `/${named}/`));
  // CRLF line ends read the same.
  expect(buddyT3RuntimeOf(machines.replaceAll("\n", "\r\n"), home)).toBe(
    runtime,
  );
  for (const [why, unit] of [
    ["no ExecStart", machines.replace(/^ExecStart=.*$/m, "")],
    ["two ExecStart", `${machines}ExecStart=${runtime} serve\n`],
    ["the Chat's launcher", unitOf(`ExecStart=${home}/.local/bin/t3 serve`)],
    ["a bare t3", unitOf("ExecStart=t3 serve --base-dir %h/.t3-buddy")],
    [
      "another home",
      unitOf(
        `ExecStart=/home/bob/.t3-buddy/runtime/versions/${version}/t3 serve`,
      ),
    ],
    [
      "the Chat's home",
      unitOf(`ExecStart=${home}/.t3/runtime/versions/${version}/t3 serve`),
    ],
    [
      "a path up and out",
      unitOf(
        `ExecStart=${home}/.t3-buddy/runtime/versions/../../../bin/t3 serve`,
      ),
    ],
    [
      "a version that is no version",
      unitOf(`ExecStart=${home}/.t3-buddy/runtime/versions/latest/t3 serve`),
    ],
    [
      "a deeper path",
      unitOf(
        `ExecStart=${home}/.t3-buddy/runtime/versions/${version}/bin/t3 serve`,
      ),
    ],
    [
      "another executable",
      unitOf(
        `ExecStart=${home}/.t3-buddy/runtime/versions/${version}/sh serve`,
      ),
    ],
    ["the launcher's verb", unitOf(`ExecStart=${runtime} __service-launcher`)],
    ["no verb", unitOf(`ExecStart=${runtime}`)],
    ["a systemd prefix", unitOf(`ExecStart=-${runtime} serve`)],
    ["a quoted command", unitOf(`ExecStart="${runtime}" serve`)],
    [
      "a specifier",
      unitOf("ExecStart=%h/.t3-buddy/runtime/versions/1.2.3/t3 serve"),
    ],
  ] as const)
    expect([why, buddyT3RuntimeOf(unit, home)]).toEqual([why, undefined]);
});

const posix = test.skipIf(process.platform === "win32");

/** A user's home with Buddy's unit and runtime as Machines install them. */
async function installed(
  options: Readonly<{ unit?: (home: string) => string }> = {},
) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "buddy-t3-")));
  const user = join(parent, "home");
  const units = join(user, ".config", "systemd", "user");
  const versions = join(user, ".t3-buddy", "runtime", "versions");
  await mkdir(units, { recursive: true });
  await mkdir(join(versions, version), { recursive: true });
  const executable = join(versions, version, "t3");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  const start = `ExecStart=${executable} serve --base-dir ${join(user, ".t3-buddy")} --host 127.0.0.1 --port 3774`;
  await writeFile(
    join(units, buddyT3Unit),
    options.unit?.(user) ?? unitOf(start),
  );
  return {
    user,
    units,
    versions,
    executable,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

posix(
  "the runtime runs only while the unit is a file of the user's and its runtime an executable file inside Buddy's runtimes",
  async () => {
    const home = await installed();
    try {
      expect(await buddyT3Runtime(home.user)).toBe(home.executable);
      // Not executable, a directory, missing.
      await chmod(home.executable, 0o644);
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      await rm(home.executable);
      await mkdir(home.executable);
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      await rm(home.executable, { recursive: true });
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      // A link that stays inside the runtimes is the runtime it names.
      const other = join(home.versions, "0.1.0-lazurio.9");
      await mkdir(other);
      await writeFile(join(other, "t3"), "#!/bin/sh\nexit 0\n");
      await chmod(join(other, "t3"), 0o755);
      await symlink(join(other, "t3"), home.executable);
      expect(await buddyT3Runtime(home.user)).toBe(home.executable);
      // A link out of the runtimes is refused, even to an executable.
      await rm(home.executable);
      const outside = join(home.user, ".local", "bin");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "t3"), "#!/bin/sh\nexit 0\n");
      await chmod(join(outside, "t3"), 0o755);
      await symlink(join(outside, "t3"), home.executable);
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      // So is a version directory that leads out of them.
      await rm(join(home.versions, version), { recursive: true });
      await symlink(outside, join(home.versions, version));
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
    } finally {
      await home.cleanup();
    }
  },
);

posix(
  "a T3 home, runtime or versions that is a link, to the Chat's home or anywhere, gives no runtime, though the unit's path leads to an executable",
  async () => {
    const home = await installed();
    try {
      const buddyHome = join(home.user, ".t3-buddy");
      const runtime = join(buddyHome, "runtime");
      // The Chat's home, with an executable where the unit's path would lead
      // through a link (Pablo's review of #599).
      const chat = join(home.user, ".t3", "runtime", "versions", version);
      await mkdir(chat, { recursive: true });
      await writeFile(join(chat, "t3"), "#!/bin/sh\nexit 0\n");
      await chmod(join(chat, "t3"), 0o755);
      const aside = join(home.user, "aside");
      for (const [why, path, target] of [
        [".t3-buddy to the Chat's home", buddyHome, join(home.user, ".t3")],
        ["runtime elsewhere", runtime, aside],
        ["versions elsewhere", home.versions, aside],
      ] as const) {
        // The real directory goes aside, a link takes its place.
        await rename(path, aside);
        await symlink(target, path);
        expect([why, await buddyT3Runtime(home.user)]).toEqual([
          why,
          undefined,
        ]);
        await rm(path);
        await rename(aside, path);
        expect([why, await buddyT3Runtime(home.user)]).toEqual([
          why,
          home.executable,
        ]);
      }
    } finally {
      await home.cleanup();
    }
  },
);

posix(
  "without the unit, through a link to it, or with a unit too large or not in UTF-8, there is no runtime",
  async () => {
    const home = await installed();
    try {
      const unit = join(home.units, buddyT3Unit);
      const text = await Bun.file(unit).text();
      await rm(unit);
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      // A link to a unit that would name the runtime.
      await writeFile(join(home.units, "elsewhere.service"), text);
      await symlink(join(home.units, "elsewhere.service"), unit);
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      await rm(unit);
      await mkdir(unit);
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      await rm(unit, { recursive: true });
      await writeFile(unit, `${text}#${"x".repeat(64 * 1024)}\n`);
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      await writeFile(
        unit,
        Buffer.concat([Buffer.from(text), Buffer.from([0xff, 0x0a])]),
      );
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      // Read as systemd and Delegace read it: a byte order mark stays a
      // character, and a line ends only at a line feed, never at another
      // separator, so neither puts an ExecStart at the start of a line.
      const start = text.split("\n").find((line) => line.startsWith("Exec"));
      await writeFile(unit, `﻿${start}\n`);
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      await writeFile(unit, `Description=Buddy ${start}\n`);
      expect(await buddyT3Runtime(home.user)).toBeUndefined();
      // The same text again: the runtime.
      await writeFile(unit, text);
      expect(await buddyT3Runtime(home.user)).toBe(home.executable);
      // No home, or one that is not absolute.
      for (const value of [undefined, "", "home/ada"])
        expect(await buddyT3Runtime(value)).toBeUndefined();
    } finally {
      await home.cleanup();
    }
  },
);
