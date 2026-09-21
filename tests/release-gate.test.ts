import { expect, test } from "bun:test";
import {
  blockingRelease,
  type ListedRelease,
  parseReleaseList,
} from "../scripts/release-gate";

const release = (
  tag_name: string,
  flags: Partial<Pick<ListedRelease, "draft" | "prerelease">> = {},
): ListedRelease => ({ tag_name, draft: false, prerelease: false, ...flags });
const lines = (releases: readonly unknown[]) =>
  releases.map((entry) => JSON.stringify(entry)).join("\n");
const script = new URL("../scripts/release-gate.ts", import.meta.url).pathname;

/** The script as the workflow runs it: the release list on stdin. */
async function gate(version: string, stdin: string) {
  const child = Bun.spawn([process.execPath, "run", script, version], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

test("a final version must be greater than every published final release", () => {
  const published = [
    release("v1.2.0"),
    release("v1.10.0"),
    release("v2.0.0-rc.1", { prerelease: true }),
    release("v3.0.0", { draft: true }),
  ];
  expect(blockingRelease("1.10.1", published)).toBeUndefined();
  expect(blockingRelease("2.0.0", published)).toBeUndefined();
  // Equal and lower are refused; 1.9.0 is below 1.10.0 numerically.
  expect(blockingRelease("1.10.0", published)).toBe("v1.10.0");
  expect(blockingRelease("1.9.0", published)).toBe("v1.10.0");
  expect(blockingRelease("1.1.0", published)).toBe("v1.2.0");
  // Drafts and prereleases order nothing, however high.
  expect(
    blockingRelease("1.0.0", [
      release("v3.0.0", { draft: true }),
      release("v9.0.0-rc.1", { prerelease: true }),
    ]),
  ).toBeUndefined();
  // A prerelease candidate is never ordered: it is reached only by name.
  expect(blockingRelease("1.0.0-rc.1", published)).toBeUndefined();
  expect(() => blockingRelease("v1.0.0", published)).toThrow();
  // No release at all: the first one may be published.
  expect(blockingRelease("0.1.0", [])).toBeUndefined();
});

test("every means the whole history: a higher final beyond the first 1,000 entries blocks", async () => {
  // Newest first, as the API lists them: 1,500 patch releases and rc's, and —
  // at the very end of the history — a final that is higher than the candidate.
  const history = [
    ...Array.from({ length: 1500 }, (_, index) =>
      index % 3 === 0
        ? release(`v1.0.${index}-rc.1`, { prerelease: true })
        : release(`v1.0.${index}`),
    ),
    release("v5.0.0"),
  ];
  expect(history.findIndex((entry) => entry.tag_name === "v5.0.0")).toBe(1500);
  expect(blockingRelease("2.0.0", history)).toBe("v5.0.0");
  expect(blockingRelease("2.0.0", history.slice(0, 1000))).toBeUndefined();
  const refused = await gate("2.0.0", lines(history));
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(
    "2.0.0 is not greater than the published final release v5.0.0",
  );
  expect(await gate("5.0.1", lines(history))).toMatchObject({
    code: 0,
    stdout: "5.0.1 may be published.\n",
  });
});

test("it fails closed on a tag it cannot order and on input that is not a release list", async () => {
  // A published FINAL release with a malformed tag might be the higher one.
  for (const tag of ["nightly", "1.2.3", "v1.2", "v1.2.3.4", ""]) {
    expect(() => blockingRelease("9.9.9", [release(tag)])).toThrow();
    expect((await gate("9.9.9", lines([release(tag)]))).code).not.toBe(0);
  }
  // The same tag on a draft or a prerelease orders nothing.
  expect(
    blockingRelease("9.9.9", [
      release("nightly", { draft: true }),
      release("nightly", { prerelease: true }),
    ]),
  ).toBeUndefined();
  for (const input of [
    "not json",
    "[]",
    "null",
    lines([{ tag_name: "v1.0.0" }]),
    lines([{ tag_name: "v1.0.0", draft: "false", prerelease: false }]),
    // `gh release list` fields are NOT this contract.
    lines([{ tagName: "v1.0.0", isDraft: false, isPrerelease: false }]),
    // A page that was cut in the middle.
    `${lines([release("v1.0.0")])}\n{"tag_name":"v5.0`,
  ]) {
    expect(() => parseReleaseList(input)).toThrow();
    expect((await gate("9.9.9", input)).code).not.toBe(0);
  }
  expect((await gate("not-a-version", "")).code).not.toBe(0);
  expect(parseReleaseList("\n\n")).toEqual([]);
  expect((await gate("0.1.0", "")).code).toBe(0);
});
