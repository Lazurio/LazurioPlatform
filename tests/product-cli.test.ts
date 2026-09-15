import { expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProductCommand } from "../src/distribution/product-cli";

// Argument and custody refusals only; no network is ever contacted here.
test.skipIf(process.platform === "win32")(
  "product commands refuse malformed input before touching the location and report status without creating it",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "product-cli-")));
    const previous = { HOME: process.env.HOME, XDG: process.env.XDG_DATA_HOME };
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = join(home, "xdg");
    try {
      for (const args of [
        [],
        ["unknown"],
        ["status", "extra"],
        ["status", "--name", "x"],
        ["activate"],
        ["activate", "--name", "x", "--name", "y"],
        ["recover", "--metadata-url", "https://a/m/"],
        ["recover", "--target-url", "https://a/t/"],
        ["recover", "--loopback-fixture"],
        [
          "recover",
          "--metadata-url",
          "http://a/m/",
          "--target-url",
          "http://a/t/",
        ],
        ["install"],
        [
          "install",
          "--metadata-url",
          "https://a/m/",
          "--target-url",
          "https://a/t/",
        ],
        [
          "install",
          "--bootstrap-root",
          join(home, "absent"),
          "--metadata-url",
          "http://127.0.0.1:1/m/",
          "--target-url",
          "http://127.0.0.1:1/t/",
        ],
        [
          "install",
          "--bootstrap-root",
          join(home, "absent"),
          "--metadata-url",
          "https://a/m",
          "--target-url",
          "https://a/t/",
        ],
        [
          "install",
          "--bootstrap-root",
          join(home, "absent"),
          "--metadata-url",
          "https://user:pw@a/m/",
          "--target-url",
          "https://a/t/",
        ],
      ])
        await expect(runProductCommand(args)).rejects.toThrow();
      const status = await runProductCommand(["status"]);
      expect(status).toEqual({
        code: 0,
        result: {
          kind: "product-status",
          base:
            process.platform === "darwin"
              ? join(home, "Library", "Application Support", "Lazurio")
              : join(home, "xdg", "lazurio"),
          executionTarget: `${process.platform}-${process.arch}`,
          published: null,
          active: null,
          entrypoint: join(
            process.platform === "darwin"
              ? join(home, "Library", "Application Support", "Lazurio")
              : join(home, "xdg", "lazurio"),
            "bin",
            "lazurio",
          ),
        },
      });
      // Nothing was created by refusals or by status.
      expect((await readdir(home)).sort()).toEqual([]);
      await expect(runProductCommand(["recover"])).rejects.toThrow();
      await expect(
        runProductCommand(["activate", "--name", "1.2.3+0123456789abcdef"]),
      ).rejects.toThrow();
      expect((await readdir(home)).sort()).toEqual([]);
    } finally {
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
      if (previous.XDG === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous.XDG;
      await rm(home, { recursive: true });
    }
  },
);
