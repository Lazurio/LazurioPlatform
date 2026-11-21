import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrainCommand } from "../src/brain/cli";
import { readBrainState } from "../src/brain/keys";
import { defaultNight, nightAt, nightOf, parseNight } from "../src/brain/night";
import { brainPaths } from "../src/brain/pin";
import type { SetupHost } from "../src/brain/setup";

// The night window search by meaning computes in (plan LZD-0033 R11a,
// Matěj's decision of 2026-11-21): its clock in the person's time zone, and
// the person's choice of it. Fictional times; no brain is touched.

describe("the night window's clock", () => {
  test("inside the default window (02:00-05:00 Prague) and outside it, winter and summer", () => {
    // 02:30 in Prague is 01:30 UTC in winter (CET).
    const winter = nightAt(new Date("2026-11-21T01:30:00Z"), defaultNight);
    expect(winter).toEqual({ inside: true, endsInMs: 150 * 60_000 });
    // 14:00 in Prague: twelve hours to the next start.
    const day = nightAt(new Date("2026-11-21T13:00:00Z"), defaultNight);
    expect(day).toEqual({ inside: false, startsInMs: 12 * 3_600_000 });
    // In summer (CEST, UTC+2) the window moves with Prague's clock.
    const summer = nightAt(new Date("2026-07-01T00:30:00Z"), defaultNight);
    expect(summer).toEqual({ inside: true, endsInMs: 150 * 60_000 });
  });

  test("a window past midnight, and seconds counted", () => {
    const late = { start: "22:00", end: "01:00", timeZone: "UTC" };
    expect(nightAt(new Date("2026-11-21T23:30:00Z"), late)).toEqual({
      inside: true,
      endsInMs: 90 * 60_000,
    });
    expect(nightAt(new Date("2026-11-21T00:59:30Z"), late)).toEqual({
      inside: true,
      endsInMs: 30_000,
    });
    expect(nightAt(new Date("2026-11-21T01:00:00Z"), late)).toEqual({
      inside: false,
      startsInMs: 21 * 3_600_000,
    });
  });

  test("a window as the person gives it, and what is refused", () => {
    expect(parseNight("01:30-04:00", "Europe/Prague")).toEqual({
      start: "01:30",
      end: "04:00",
      timeZone: "Europe/Prague",
    });
    for (const range of ["2-5", "02:00", "02:00-02:00", "25:00-05:00", "a-b"])
      expect(parseNight(range)).toBe("invalid-range");
    expect(parseNight("02:00-05:00", "Mars/Olympus")).toBe("invalid-time-zone");
    // A stored window that is not valid any more reads as the default.
    expect(nightOf({ start: "02:00", end: "02:00", timeZone: "UTC" })).toEqual(
      defaultNight,
    );
    expect(nightOf(undefined)).toEqual(defaultNight);
  });
});

describe("lazurio brain night", () => {
  const host = async () => {
    const root = await mkdtemp(join(tmpdir(), "brain-night-"));
    const paths = brainPaths(join(root, "home"));
    return {
      paths,
      host: {
        async context() {
          return { kind: "supported" as const };
        },
        paths,
        globalUnits: join(root, "etc-systemd-user"),
        handover: join(root, "brain-handover"),
        async health() {
          return null;
        },
      } as unknown as SetupHost,
    };
  };
  const run = (args: string[], h: SetupHost) =>
    runBrainCommand(args, {
      identity: {} as never,
      platform: "linux",
      env: {},
      executable: "lazurio",
      host: h,
    });

  test("shows the default, chooses another under setup's lock, and the status shows it", async () => {
    const { host: h, paths } = await host();
    const shown = await run(["night", "--json"], h);
    expect(JSON.parse(shown.stdout as string)).toEqual({
      night: defaultNight,
      changed: false,
    });
    const chosen = await run(
      ["night", "01:00-04:30", "--time-zone", "Europe/Prague", "--json"],
      h,
    );
    expect(chosen.code).toBe(0);
    expect((await readBrainState(paths)).night).toEqual({
      start: "01:00",
      end: "04:30",
      timeZone: "Europe/Prague",
    });
    const status = await run(["status", "--json"], h);
    expect(JSON.parse(status.stdout as string).night).toEqual({
      start: "01:00",
      end: "04:30",
      timeZone: "Europe/Prague",
    });
    expect((await run(["status"], h)).stdout).toContain(
      "computed at night (01:00–04:30, Europe/Prague; lazurio brain night changes it)",
    );
  });

  test("a window or time zone that is not valid is refused and nothing is written", async () => {
    const { host: h, paths } = await host();
    for (const args of [
      ["night", "2-5"],
      ["night", "02:00-05:00", "--time-zone", "Mars/Olympus"],
      ["night", "--time-zone", "UTC"],
    ]) {
      const refused = await run(args, h);
      expect(refused.code).not.toBe(0);
    }
    expect((await readBrainState(paths)).night).toBeUndefined();
  });
});
