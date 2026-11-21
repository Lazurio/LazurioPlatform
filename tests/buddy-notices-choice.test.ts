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
  createNoticesChoiceHolder,
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

test("the Launchpad saves the person's choices one after another: every save succeeds and the last one stays", async () => {
  const home = await mkdtemp(join(tmpdir(), "buddy-notices-"));
  try {
    await writeNoticesChoice(home, "off");
    const holder = createNoticesChoiceHolder(home);
    expect(await holder.read()).toBe("off");
    const choices = [
      "on",
      "off",
      "on",
      "off",
      "on",
      "off",
      "off",
      "on",
    ] as const;
    const saved = await Promise.all(choices.map((c) => holder.write(c)));
    expect(saved).toEqual([...choices]);
    expect(holder.current()).toBe("on");
    expect(await readNoticesChoice(home)).toBe("on");
    // Nothing is left behind beside the file.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dirname(noticesChoicePath(home)))).toEqual([
      "notices.json",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a save that fails is told to the caller and leaves the choice saved before", async () => {
  const home = await mkdtemp(join(tmpdir(), "buddy-notices-"));
  try {
    const holder = createNoticesChoiceHolder(home);
    await holder.write("off");
    // The folder can no longer be written.
    const { chmod } = await import("node:fs/promises");
    await chmod(dirname(noticesChoicePath(home)), 0o500);
    await expect(holder.write("on")).rejects.toThrow();
    expect(holder.current()).toBe("off");
    await chmod(dirname(noticesChoicePath(home)), 0o700);
    // A later save goes through.
    expect(await holder.write("on")).toBe("on");
    await expect(
      createNoticesChoiceHolder(undefined).write("on"),
    ).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
