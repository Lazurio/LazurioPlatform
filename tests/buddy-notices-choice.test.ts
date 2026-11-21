import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isBuddyNoticesChoice,
  noticesChoicePath,
  readNoticesChoice,
  writeNoticesChoice,
} from "../src/buddy/notices-choice";

test("Buddy GEN4's notices are one choice for the Environment, on until the person turns them off (Matěj 2026-11-21)", async () => {
  const home = await mkdtemp(join(tmpdir(), "buddy-notices-"));
  try {
    // No file yet: on.
    expect(await readNoticesChoice(home)).toBe("on");
    await writeNoticesChoice(home, "off");
    expect(await readNoticesChoice(home)).toBe("off");
    const file = noticesChoicePath(home);
    expect(file).toBe(
      join(home, ".config", "lazurio", "buddy", "notices.json"),
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ choice: "off" });
    // Readable only by the person.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeNoticesChoice(home, "on");
    expect(await readNoticesChoice(home)).toBe("on");
    // Anything but an explicit "off" is on.
    for (const text of ["not json", "{}", '{"choice":"maybe"}', "null"]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
      expect(await readNoticesChoice(home)).toBe("on");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  expect(isBuddyNoticesChoice("on")).toBe(true);
  expect(isBuddyNoticesChoice("off")).toBe(true);
  expect(isBuddyNoticesChoice("maybe")).toBe(false);
  expect(isBuddyNoticesChoice(undefined)).toBe(false);
});
