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
import { encodeLabel, syncT3Links } from "../src/t3-links/links";
import type { RpcAnswer } from "../src/t3-links/rpc";
import { runTool } from "../src/tools/status";
import { bindings } from "./fixtures/machine-bindings";

// The same look as tests/t3-links.test.ts with real processes: `ssh` is a
// script that runs the remote command in a real shell with the target's
// home, as OpenSSH hands it to the target account's shell, and the target's
// `lazurio` and `t3` are scripts that log their argv. It proves the quoting
// of what reaches the target and that the pairing code is on no process's
// command line. Synthetic fixtures.

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function script(path: string, text: string) {
  await writeFile(path, text);
  await chmod(path, 0o755);
}

test("the target's commands run in its shell with its home, and the code reaches no command line", async () => {
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
  const code = "code-0123456789";
  // `ssh … -- <id> <remote>`: the remote command in a shell, as the target.
  await script(
    join(bin, "ssh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${root}/argv.log"\nfor last; do :; done\nHOME="${targetHome}" exec sh -c "$last"\n`,
  );
  await script(
    join(targetHome, ".local", "bin", "lazurio"),
    [
      "#!/bin/sh",
      `printf 'lazurio %s\\n' "$*" >> "${root}/target.log"`,
      `printf 'lazurio %s\\n' "$*" >> "${root}/argv.log"`,
      `echo '{"kind":"t3-link-pair","id":"pair-1","credential":"${code}"}'`,
    ].join("\n"),
  );
  await script(
    join(targetHome, ".local", "bin", "t3"),
    [
      "#!/bin/sh",
      `printf 't3 %s\\n' "$*" >> "${root}/target.log"`,
      `printf 't3 %s\\n' "$*" >> "${root}/argv.log"`,
      'case "$1 $2 $3" in',
      '  "auth session list") echo "[]" ;;',
      '  "auth pairing revoke") echo "Revoked." ;;',
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
  );
  const requests: { tag: string; payload: unknown }[] = [];
  const report = await syncT3Links(
    {
      run: runTool,
      now: () => Date.parse("2026-11-18T00:00:00.000Z"),
      home,
      uid: process.getuid?.(),
      path: `${bin}:/usr/bin:/bin`,
      t3: "/nonexistent/t3",
      node: "lazurio-bob",
      label: async () => "Example / lazurio-bob",
      rpc: async () => ({
        async request(tag, payload): Promise<RpcAnswer> {
          requests.push({ tag, payload });
          if (tag === "server.updateSettings") {
            await writeFile(
              join(home, ".t3", "userdata", "settings.json"),
              '{"linkedEnvironmentsEnabled":true}\n',
            );
            return { ok: true, value: {} };
          }
          if (tag === "peerLinks.list")
            return { ok: true, value: { links: [] } };
          return { ok: false, error: "PeerLinkError:pairing_rejected" };
        },
        async close() {},
      }),
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
    `t3 auth session list --json --base-dir ${base}`,
    `lazurio machine t3-link-pair --source lazurio-bob --label ${encodeLabel("Example / lazurio-bob")}`,
    `t3 auth pairing revoke --base-dir ${base} pair-1`,
    "",
  ]);
  // Every process of the look, on either end: none had the code.
  expect(await readFile(join(root, "argv.log"), "utf8")).not.toContain(code);
  expect(
    requests
      .filter((request) => JSON.stringify(request).includes(code))
      .map((request) => request.tag),
  ).toEqual(["peerLinks.link"]);
  expect(JSON.stringify(report)).not.toContain(code);
});
