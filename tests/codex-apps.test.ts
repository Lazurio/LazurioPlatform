import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexAppsInput,
  codexAppsLiftedText,
  codexAppsMarker,
  codexAppsOffText,
  codexAppsOfText,
  codexHome,
  convergeCodexApps,
  observeCodexApps,
} from "../src/tools/codex-apps";

// The operator's Codex and the ChatGPT account's apps (decision F42's
// addendum of 2026-10-27): Lazurio turns them off by `[apps._default]
// enabled = false` in `$CODEX_HOME/config.toml` and changes nothing else of
// the file, idempotently; where they are allowed it takes back only its own
// line. Every fixture is a temporary CODEX_HOME with a stand-in `codex` on
// PATH; the person's real configuration is never read.

const person = `# My Codex
model = "gpt-6.1-sol"
approval_policy = "never"

[mcp_servers.executor]
command = "/home/operator/.local/bin/executor"
args = ["mcp"]

[profiles.quick]
model_reasoning_effort = "low"
`;

async function withCodex(
  run: (input: CodexAppsInput, home: string) => Promise<void>,
  options: Readonly<{ codex?: boolean }> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-apps-")));
  const bin = join(root, "bin");
  const home = join(root, "codex-home");
  try {
    await mkdir(bin);
    if (options.codex !== false) {
      await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
      await chmod(join(bin, "codex"), 0o755);
    }
    await run(
      {
        home: join(root, "home"),
        path: bin,
        platform: process.platform,
        env: { CODEX_HOME: home },
      },
      home,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const config = (home: string) => join(home, "config.toml");

test("Codex's home is CODEX_HOME when absolute, else ~/.codex, else unknown", () => {
  expect(
    codexHome({ home: "/home/a", env: { CODEX_HOME: "/srv/codex" } }),
  ).toBe("/srv/codex");
  expect(codexHome({ home: "/home/a", env: { CODEX_HOME: "rel" } })).toBe(
    "/home/a/.codex",
  );
  expect(codexHome({ home: undefined, env: {} })).toBeNull();
});

/** Lazurio's two tables, as it appends them. */
const appsBlock = `[apps._default] ${codexAppsMarker}\nenabled = false ${codexAppsMarker}\n`;
const suggestionsBlock = `[features] ${codexAppsMarker}\ntool_suggest = false ${codexAppsMarker}\n`;

test("off appends Lazurio's two tables and keeps every byte of the person's configuration", () => {
  const off = codexAppsOffText(person);
  expect(off).toBe(`${person}\n${appsBlock}\n${suggestionsBlock}`);
  expect(codexAppsOfText(off ?? "")).toEqual({
    state: "off",
    by: "lazurio",
    exceptions: [],
    suggestions: "off",
  });
  // Idempotent, and exactly reversible.
  expect(codexAppsOffText(off ?? "")).toBe(off);
  expect(codexAppsLiftedText(off ?? "")).toBe(person);
  expect(codexAppsLiftedText(person)).toBe(person);
  expect(codexAppsOfText(person)).toEqual({ state: "on", suggestions: "on" });
});

test("off sets the keys in the person's own tables, and allowing again writes back their lines", () => {
  const own = `[apps._default]
enabled = true # I want them
approvals_reviewer = "user"

[apps.connector_abc]
enabled = true

[features]
tool_suggest = true
memories = true
`;
  const off = codexAppsOffText(own) ?? "";
  expect(off).toBe(`[apps._default]
enabled = false ${codexAppsMarker} (was: enabled = true # I want them)
approvals_reviewer = "user"

[apps.connector_abc]
enabled = true

[features]
tool_suggest = false ${codexAppsMarker} (was: tool_suggest = true)
memories = true
`);
  // The app turned on by name stays on: Codex prefers it to the default.
  expect(codexAppsOfText(off)).toEqual({
    state: "off",
    by: "lazurio",
    exceptions: ["connector_abc"],
    suggestions: "off",
  });
  expect(codexAppsLiftedText(off)).toBe(own);
  // Tables without the keys get them under their headers, and lose them.
  const bare = `[apps._default]\ndestructive_enabled = false\n\n[features]\nmemories = true\n`;
  const inserted = codexAppsOffText(bare) ?? "";
  expect(inserted).toBe(
    `[apps._default]\nenabled = false ${codexAppsMarker}\ndestructive_enabled = false\n\n[features]\ntool_suggest = false ${codexAppsMarker}\nmemories = true\n`,
  );
  expect(codexAppsLiftedText(inserted)).toBe(bare);
});

test("what already turns them off is left as it is, also when they are allowed", () => {
  // Codex's own `features.apps = false` turns off both.
  const feature = "[features]\napps = false\n";
  expect(codexAppsOffText(feature)).toBe(feature);
  expect(codexAppsLiftedText(feature)).toBe(feature);
  expect(codexAppsOfText(feature)).toEqual({
    state: "off",
    by: "feature",
    exceptions: [],
    suggestions: "off",
  });
  // The person's own `false`s stay; only what is still on gets Lazurio's.
  const apps = "[apps._default]\nenabled = false\n";
  expect(codexAppsOfText(apps)).toEqual({
    state: "off",
    by: "person",
    exceptions: [],
    suggestions: "on",
  });
  const off = codexAppsOffText(apps) ?? "";
  expect(off).toBe(`${apps}\n${suggestionsBlock}`);
  expect(codexAppsLiftedText(off)).toBe(apps);
  const both =
    "[apps._default]\nenabled = false\n\n[features]\ntool_suggest = false\n";
  expect(codexAppsOffText(both)).toBe(both);
  expect(codexAppsLiftedText(both)).toBe(both);
});

test("a form Lazurio does not edit in place, or a file that does not parse, is refused", () => {
  for (const text of [
    "[apps]\n_default.enabled = true\n",
    "apps = { _default = { enabled = true } }\n",
    'apps._default.enabled = true\nmodel = "x"\n',
    "features.memories = true\n",
    "features = { memories = true }\n",
  ])
    expect(codexAppsOffText(text)).toBeNull();
  expect(codexAppsOffText("model = \n")).toBeNull();
  expect(codexAppsOfText("model = \n")).toEqual({ state: "unreadable" });
  // A header inside a multi-line string is text, not a table.
  const text = 'note = """\n[apps._default]\nenabled = true\n"""\n';
  const off = codexAppsOffText(text) ?? "";
  expect(off.startsWith(text)).toBe(true);
  expect(codexAppsLiftedText(off)).toBe(text);
});

test.skipIf(process.platform === "win32")(
  "the converge writes only where the text changes, keeps the mode and is idempotent",
  async () => {
    await withCodex(async (input, home) => {
      // No configuration yet: Lazurio's tables alone.
      expect(await observeCodexApps(input)).toEqual({
        state: "on",
        suggestions: "on",
      });
      const first = await convergeCodexApps(input, false);
      expect(first.kind).toBe("changed");
      expect(await readFile(config(home), "utf8")).toBe(
        `${appsBlock}\n${suggestionsBlock}`,
      );
      expect((await lstat(config(home))).mode & 0o777).toBe(0o600);
      expect((await convergeCodexApps(input, false)).kind).toBe("unchanged");
      // Allowed: the file has the bytes it had before Lazurio, none.
      expect((await convergeCodexApps(input, true)).kind).toBe("changed");
      expect(await readFile(config(home), "utf8")).toBe("");
      // The person's configuration, mode 0644: byte-preserved around the
      // two tables, and its mode kept.
      await writeFile(config(home), person);
      await chmod(config(home), 0o644);
      expect((await convergeCodexApps(input, false)).kind).toBe("changed");
      const after = await readFile(config(home), "utf8");
      expect(after.startsWith(person)).toBe(true);
      expect(after.slice(person.length)).toBe(
        `\n${appsBlock}\n${suggestionsBlock}`,
      );
      expect((await lstat(config(home))).mode & 0o777).toBe(0o644);
      expect(await observeCodexApps(input)).toEqual({
        state: "off",
        by: "lazurio",
        exceptions: [],
        suggestions: "off",
      });
      expect((await convergeCodexApps(input, false)).kind).toBe("unchanged");
      expect((await convergeCodexApps(input, true)).kind).toBe("changed");
      expect(await readFile(config(home), "utf8")).toBe(person);
      expect((await convergeCodexApps(input, true)).kind).toBe("unchanged");
      // Nothing of Lazurio's temporary files is left beside it.
      expect((await readdir(home)).sort()).toEqual(["config.toml"]);
    });
  },
);

test.skipIf(process.platform === "win32")(
  "a link, a form it does not edit and a Codex that is not installed are left alone",
  async () => {
    await withCodex(async (input, home) => {
      await mkdir(home);
      const elsewhere = join(home, "..", "dotfiles.toml");
      await writeFile(elsewhere, person);
      await symlink(elsewhere, config(home));
      const linked = await convergeCodexApps(input, false);
      expect(linked).toEqual({
        kind: "refused",
        reason: "config-not-regular",
        facts: { state: "on", suggestions: "on" },
      });
      expect(await readFile(elsewhere, "utf8")).toBe(person);
      expect((await lstat(config(home))).isSymbolicLink()).toBe(true);
      await rm(config(home));
      const dotted = "[apps]\n_default.enabled = true\n";
      await writeFile(config(home), dotted);
      expect(await convergeCodexApps(input, false)).toEqual({
        kind: "refused",
        reason: "config-shape",
        facts: { state: "on", suggestions: "on" },
      });
      expect(await readFile(config(home), "utf8")).toBe(dotted);
    });
    await withCodex(
      async (input, home) => {
        expect(await observeCodexApps(input)).toEqual({ state: "absent" });
        expect(await convergeCodexApps(input, false)).toEqual({
          kind: "unchanged",
          facts: { state: "absent" },
        });
        await expect(lstat(home)).rejects.toThrow();
      },
      { codex: false },
    );
  },
);
