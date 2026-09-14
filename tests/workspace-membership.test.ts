import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeclaredWorkspaceMember as member } from "../src/modules/workspace-membership";

test("membership agrees with a real isolated Bun workspace install including exclusions", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "workspace-membership-")),
  );
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const patterns = ["packages/*", "!packages/excluded"];
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "synthetic-workspace-owner",
        private: true,
        workspaces: patterns,
        dependencies: { "synthetic-included": "workspace:*" },
      }),
    );
    for (const name of ["included", "excluded"]) {
      const directory = join(root, "packages", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name: `synthetic-${name}`,
          version: "1.0.0",
        }),
      );
    }
    child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "install",
        "--ignore-scripts",
        "--no-progress",
      ],
      {
        cwd: root,
        env: {
          HOME: root,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          BUN_INSTALL_CACHE_DIR: join(root, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child?.kill(), 10_000);
    try {
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(timer);
    }
    expect(
      await realpath(join(root, "node_modules", "synthetic-included")),
    ).toBe(join(root, "packages", "included"));
    await expect(
      realpath(join(root, "node_modules", "synthetic-excluded")),
    ).rejects.toThrow();
    const lock = await readFile(join(root, "bun.lock"), "utf8");
    expect(lock).toContain('"packages/included"');
    expect(lock).not.toContain('"packages/excluded"');
    expect(
      member("package.json", "packages/included/package.json", patterns),
    ).toBe(true);
    expect(
      member("package.json", "packages/excluded/package.json", patterns),
    ).toBe(false);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("preparation owner requires self or explicit workspace membership, not nesting", () => {
  expect(member("app/package.json", "app/package.json", undefined)).toBe(true);
  expect(member("package.json", "apps/web/package.json", undefined)).toBe(
    false,
  );
  expect(member("package.json", "apps/web/package.json", ["apps/*"])).toBe(
    true,
  );
  expect(member("package.json", "other/web/package.json", ["apps/*"])).toBe(
    false,
  );
  expect(member("tools/package.json", "apps/web/package.json", ["**"])).toBe(
    false,
  );
  expect(
    member("tools/package.json", "tools/apps/web/package.json", ["apps/*"]),
  ).toBe(true);
});

test("workspace exclusions win regardless of order and glob patterns use Bun matching", () => {
  for (const patterns of [
    ["apps/**", "!apps/internal/**"],
    ["!apps/internal/**", "apps/**"],
  ]) {
    expect(
      member("package.json", "apps/internal/web/package.json", patterns),
    ).toBe(false);
    expect(
      member("package.json", "apps/public/web/package.json", patterns),
    ).toBe(true);
  }
  expect(
    member("package.json", "apps/web/package.json", ["!apps/internal/**"]),
  ).toBe(false);
  expect(
    member("package.json", "apps/web/package.json", ["{apps,tools}/*"]),
  ).toBe(true);
});

test("invalid or executable workspace declarations cannot produce membership", () => {
  for (const patterns of [
    null,
    {},
    ["../*"],
    ["/apps/*"],
    ["!"],
    ["apps\\*"],
    ["apps/*\n"],
    new Array(1),
  ])
    expect(() =>
      member("package.json", "apps/web/package.json", patterns),
    ).toThrow();
  let called = false;
  const patterns = ["apps/*"];
  Object.defineProperty(patterns, "0", {
    get() {
      called = true;
      return "apps/*";
    },
  });
  expect(() =>
    member("package.json", "apps/web/package.json", patterns),
  ).toThrow();
  expect(called).toBe(false);
  expect(() =>
    member("../package.json", "apps/web/package.json", ["**"]),
  ).toThrow();
});
