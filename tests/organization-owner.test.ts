import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnerCheck,
  isOwnerMembership,
  ownerCheck,
} from "../src/launchpad/organization-owner";
import type { ToolRunner } from "../src/tools/status";

// Decision F36 addendum of 2026-10-04: whether this Environment's GitHub
// identity is an Owner of an Organization comes only from GitHub
// (`gh api user/memberships/orgs/<login>`), fails closed, is never asked on a
// Team Environment or without a bound login, and is kept a few minutes.

const posixTest = test.skipIf(process.platform === "win32");

async function withGh(
  answer: (command: readonly string[]) => Awaited<ReturnType<ToolRunner>>,
  run: (
    check: ReturnType<typeof createOwnerCheck>,
    calls: string[][],
    clock: { now: number },
  ) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "owner-check-"));
  try {
    await mkdir(join(home, "bin"));
    await writeFile(join(home, "bin", "gh"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const calls: string[][] = [];
    const clock = { now: 1_000 };
    const check = createOwnerCheck(
      {
        path: join(home, "bin"),
        home,
        platform: process.platform,
        run: async (command) => {
          calls.push([...command.slice(1)]);
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

test("only an active admin membership is an Owner's", () => {
  expect(isOwnerMembership('{"state":"active","role":"admin"}')).toBe(true);
  expect(isOwnerMembership('{"state":"pending","role":"admin"}')).toBe(false);
  expect(isOwnerMembership('{"state":"active","role":"member"}')).toBe(false);
  expect(isOwnerMembership("not json")).toBe(false);
});

posixTest("GitHub's answer, kept a few minutes per login", async () => {
  await withGh(
    () => ({
      exitCode: 0,
      stdout: '{"state":"active","role":"admin"}',
      stderr: "",
    }),
    async (check, calls, clock) => {
      expect(
        await check.owner("Example-Org", "hosted-organization-personal"),
      ).toBe(true);
      expect(calls).toEqual([["api", "user/memberships/orgs/Example-Org"]]);
      expect(await check.owner("example-org", "local")).toBe(true);
      expect(calls).toHaveLength(1);
      clock.now += ownerCheck.cacheMs + 1;
      expect(await check.owner("example-org", "local")).toBe(true);
      expect(calls).toHaveLength(2);
    },
  );
});

posixTest(
  "fail closed: a member, a refusal, a timeout; never asked on a Team Environment or without a login",
  async () => {
    for (const answer of [
      { exitCode: 0, stdout: '{"state":"active","role":"member"}', stderr: "" },
      { exitCode: 1, stdout: "", stderr: "Not Found" },
      "timeout" as const,
    ])
      await withGh(
        () => answer,
        async (check) => {
          expect(await check.owner("example-org", "local")).toBe(false);
        },
      );
    await withGh(
      () => ({
        exitCode: 0,
        stdout: '{"state":"active","role":"admin"}',
        stderr: "",
      }),
      async (check, calls) => {
        expect(
          await check.owner("example-org", "hosted-organization-team"),
        ).toBe(false);
        expect(await check.owner(undefined, "local")).toBe(false);
        expect(await check.owner("not/a/login", "local")).toBe(false);
        expect(calls).toEqual([]);
      },
    );
  },
);
