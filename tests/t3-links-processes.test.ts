import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncT3Links } from "../src/t3-links/links";
import { runTool } from "../src/tools/status";
import { bindings } from "./fixtures/machine-bindings";

// The same look as tests/t3-links.test.ts, with real processes: `ssh` is a
// script that runs the remote command in a real shell with the target's
// home, as OpenSSH hands it to the target account's shell, and both ends'
// `t3` are scripts that log their argv. It proves the quoting of what
// reaches the target and where the pairing code goes. Synthetic fixtures.

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function script(path: string, text: string) {
  await writeFile(path, text);
  await chmod(path, 0o755);
}

test("the remote command runs in the target's shell with its home, and a refused link revokes its code there", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-t3-links-proc-"));
  directories.push(root);
  const home = join(root, "source");
  const targetHome = join(root, "target");
  const bin = join(root, "bin");
  for (const directory of [
    join(home, ".t3", "userdata"),
    join(targetHome, ".local", "bin"),
    bin,
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(join(home, ".t3", "userdata", "settings.json"), "{}\n");
  // `ssh … -- <id> <remote>`: the remote command in a shell, as the target.
  await script(
    join(bin, "ssh"),
    `#!/bin/sh\nfor last; do :; done\nHOME="${targetHome}" exec sh -c "$last"\n`,
  );
  await script(
    join(targetHome, ".local", "bin", "t3"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${root}/target.log"`,
      'case "$1 $2 $3" in',
      '  "auth session list") echo "[]" ;;',
      `  "auth pairing create") echo '{"id":"pair-1","credential":"code-0123456789"}' ;;`,
      '  "auth pairing revoke") echo "Revoked." ;;',
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
  );
  const t3 = join(bin, "t3-local");
  await script(
    t3,
    [
      "#!/bin/sh",
      `printf '%s|%s\\n' "$T3CODE_ENVIRONMENT_LABEL" "$*" >> "${root}/local.log"`,
      'case "$1 $2" in',
      '  "environment list") echo "[]" ;;',
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
  );
  const report = await syncT3Links(
    {
      run: runTool,
      now: () => Date.parse("2026-11-18T00:00:00.000Z"),
      home,
      uid: process.getuid?.(),
      path: `${bin}:/usr/bin:/bin`,
      t3,
      label: async () => "lazurio-bob",
    },
    bindings.personalAssigned,
  );
  expect(report).toMatchObject({
    role: "source",
    links: [{ result: "failed", cause: "link-refused" }],
  });
  const base = join(targetHome, ".t3");
  expect(
    (await readFile(join(root, "target.log"), "utf8")).split("\n"),
  ).toEqual([
    `auth session list --json --base-dir ${base}`,
    `auth pairing create --ttl 2m --label lazurio-link --json --base-dir ${base}`,
    `auth pairing revoke --base-dir ${base} pair-1`,
    "",
  ]);
  const local = (await readFile(join(root, "local.log"), "utf8"))
    .split("\n")
    .filter((line) => line !== "");
  expect(local.filter((line) => line.includes("code-0123456789"))).toEqual([
    `lazurio-bob|environment link --base-dir ${join(home, ".t3")} --pairing-code code-0123456789 --access full-access https://t3code.lazurio-bob.lazurioexampleorganization.lazurio.io`,
  ]);
  expect(JSON.stringify(report)).not.toContain("code-0123456789");
});
