import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMaintainerCheck,
  githubRepositoryOf,
  isMaintainer,
} from "../src/launchpad/module-maintainer";
import { ownerCheck } from "../src/launchpad/organization-owner";
import type { ToolRunner } from "../src/tools/status";

// Root decision 0185 S15 (issue #151): a Steward is offered "Přístup k
// modulu" only where GitHub's own, live answer gives this Environment's
// identity `maintain` on the module's repository (`gh api
// repos/<owner>/<repo>`), read the same way as the Owner check: bounded,
// kept a few minutes, failing closed, and never asked on a Team Environment.

const posixTest = test.skipIf(process.platform === "win32");

async function withGh(
  answer: (
    command: readonly string[],
  ) =>
    | Awaited<ReturnType<ToolRunner>>
    | Promise<Awaited<ReturnType<ToolRunner>>>,
  run: (
    check: ReturnType<typeof createMaintainerCheck>,
    calls: string[][],
    clock: { now: number },
  ) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "maintain-check-"));
  try {
    await mkdir(join(home, "bin"));
    await writeFile(join(home, "bin", "gh"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const calls: string[][] = [];
    const clock = { now: 1_000 };
    const check = createMaintainerCheck(
      {
        path: join(home, "bin"),
        home,
        platform: process.platform,
        run: async (command, timeoutMs) => {
          calls.push([...command.slice(1)]);
          expect(timeoutMs).toBe(ownerCheck.timeoutMs);
          return answer(command);
        },
      },
      () => clock.now,
    );
    await run(check, calls, clock);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const repository = (maintain: boolean, admin = false) => ({
  exitCode: 0,
  stdout: JSON.stringify({
    full_name: "Example-Org/deals",
    permissions: { admin, maintain, push: true, triage: true, pull: true },
  }),
  stderr: "",
});

test("a module's repository by its GitHub page, only a real one", () => {
  expect(githubRepositoryOf("https://github.com/Example-Org/deals")).toEqual({
    owner: "Example-Org",
    name: "deals",
  });
  expect(githubRepositoryOf("https://github.com/Example-Org/web.app")).toEqual({
    owner: "Example-Org",
    name: "web.app",
  });
  for (const page of [
    undefined,
    "https://github.com/Example-Org",
    "https://github.com/Example-Org/deals/issues",
    "https://gitlab.com/Example-Org/deals",
    "http://github.com/Example-Org/deals",
    "https://github.com/-bad/deals",
    "https://github.com/Example-Org/..",
  ])
    expect(githubRepositoryOf(page)).toBeNull();
});

test("only `maintain` in GitHub's answer is a Steward's", () => {
  expect(isMaintainer(repository(true).stdout)).toBe(true);
  expect(isMaintainer(repository(false).stdout)).toBe(false);
  expect(isMaintainer('{"permissions":{"maintain":"true"}}')).toBe(false);
  expect(isMaintainer('{"permissions":null}')).toBe(false);
  expect(isMaintainer("{}")).toBe(false);
  expect(isMaintainer("not json")).toBe(false);
});

posixTest("GitHub's answer, kept a few minutes per repository", async () => {
  await withGh(
    () => repository(true),
    async (check, calls, clock) => {
      expect(
        await check.maintain(
          "Example-Org",
          "https://github.com/Example-Org/deals",
          "hosted-organization-personal",
        ),
      ).toBe(true);
      expect(calls).toEqual([["api", "repos/Example-Org/deals"]]);
      expect(
        await check.maintain(
          "example-org",
          "https://github.com/example-org/Deals",
          "local",
        ),
      ).toBe(true);
      expect(calls).toHaveLength(1);
      clock.now += ownerCheck.cacheMs + 1;
      expect(
        await check.maintain(
          "Example-Org",
          "https://github.com/Example-Org/deals",
          "local",
        ),
      ).toBe(true);
      expect(calls).toHaveLength(2);
    },
  );
});

posixTest("one question per repository at a time", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withGh(
    async () => {
      await gate;
      return repository(true);
    },
    async (check, calls) => {
      const page = "https://github.com/Example-Org/deals";
      const answers = [
        check.maintain("Example-Org", page, "local"),
        check.maintain("Example-Org", page, "local"),
        check.maintain("Example-Org", page, "local"),
      ];
      release();
      expect(await Promise.all(answers)).toEqual([true, true, true]);
      expect(calls).toHaveLength(1);
    },
  );
});

posixTest(
  "fail closed: no maintain, a refusal, a timeout; never asked on a Team Environment, without a login, or for a repository outside the Organization",
  async () => {
    for (const answer of [
      repository(false),
      { exitCode: 1, stdout: "", stderr: "Not Found" },
      { exitCode: 0, stdout: "not json", stderr: "" },
      "timeout" as const,
    ])
      await withGh(
        () => answer,
        async (check, calls) => {
          expect(
            await check.maintain(
              "Example-Org",
              "https://github.com/Example-Org/deals",
              "local",
            ),
          ).toBe(false);
          expect(calls).toHaveLength(1);
        },
      );
    await withGh(
      () => repository(true, true),
      async (check, calls) => {
        const page = "https://github.com/Example-Org/deals";
        expect(
          await check.maintain("Example-Org", page, "hosted-organization-team"),
        ).toBe(false);
        expect(await check.maintain(undefined, page, "local")).toBe(false);
        expect(await check.maintain("not/a/login", page, "local")).toBe(false);
        expect(await check.maintain("Example-Org", undefined, "local")).toBe(
          false,
        );
        expect(
          await check.maintain(
            "Example-Org",
            "https://github.com/Other-Org/deals",
            "local",
          ),
        ).toBe(false);
        expect(calls).toEqual([]);
      },
    );
  },
);
