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
  readNoticesRecord,
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
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      choice: "off",
      version: 0,
    });
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

test("the Launchpad saves the person's changes one after another, each on the version it was made on; choosing what is held is no change", async () => {
  const home = await mkdtemp(join(tmpdir(), "buddy-notices-"));
  try {
    await writeNoticesChoice(home, "off", 3);
    const holder = createNoticesChoiceHolder(home);
    expect(await holder.read()).toEqual({ choice: "off", version: 3 });
    // Eight changes at once, each made on the version before it.
    const choices = [
      "on",
      "off",
      "on",
      "off",
      "on",
      "off",
      "on",
      "off",
    ] as const;
    const saved = await Promise.all(
      choices.map((choice, index) => holder.write(choice, 3 + index)),
    );
    expect(saved.map((answer) => answer.saved)).toEqual(
      choices.map(() => true),
    );
    expect(await holder.read()).toEqual({ choice: "off", version: 11 });
    expect(await readNoticesRecord(home)).toEqual({
      choice: "off",
      version: 11,
    });
    // Choosing what is held, on any version, is no change.
    expect(await holder.write("off", 0)).toEqual({
      choice: "off",
      version: 11,
      saved: true,
    });
    // Nothing is left behind beside the file.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dirname(noticesChoicePath(home)))).toEqual([
      "notices.json",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a change made on an older version is refused and names the newer choice, whatever the clocks and however late it arrives (Pablo's sequences)", async () => {
  const home = await mkdtemp(join(tmpdir(), "buddy-notices-"));
  try {
    const holder = createNoticesChoiceHolder(home);
    // Version 0 is "on". A newer "off" from a browser whose clock is 10 s
    // behind is still the newest change made on the newest version.
    expect(await holder.write("off", 0)).toMatchObject({
      saved: true,
      version: 1,
    });
    expect(await holder.write("on", 1)).toMatchObject({
      saved: true,
      version: 2,
    });
    expect(await holder.write("off", 2)).toMatchObject({
      choice: "off",
      saved: true,
    });
    // An "on" made on version 0, 40 s ago, arrives now: refused.
    expect(await holder.write("on", 0)).toEqual({
      choice: "off",
      version: 3,
      saved: false,
    });
    expect(await readNoticesChoice(home)).toBe("off");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a save that fails is told to the caller and leaves the choice saved before", async () => {
  const home = await mkdtemp(join(tmpdir(), "buddy-notices-"));
  try {
    const holder = createNoticesChoiceHolder(home);
    await holder.write("off", 0);
    // The folder can no longer be written.
    const { chmod } = await import("node:fs/promises");
    await chmod(dirname(noticesChoicePath(home)), 0o500);
    await expect(holder.write("on", 1)).rejects.toThrow();
    expect(holder.current()).toBe("off");
    await chmod(dirname(noticesChoicePath(home)), 0o700);
    // A later save goes through.
    expect(await holder.write("on", 1)).toMatchObject({
      choice: "on",
      saved: true,
    });
    await expect(
      createNoticesChoiceHolder(undefined).write("on", 0),
    ).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
