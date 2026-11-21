import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrainCommand } from "../src/brain/cli";
import { readBrainState } from "../src/brain/keys";
import {
  defaultNight,
  nightAt,
  nightOf,
  nightStartsIn,
  parseNight,
} from "../src/brain/night";
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

  test("real time across the spring change in Prague (2027-03-28, 02:00 CET becomes 03:00 CEST)", () => {
    const minute = 60_000;
    const zone = "Europe/Prague";
    // 01:50 CET in 01:00-03:30: the clock skips an hour, so the end is 40
    // real minutes away, not 100.
    expect(
      nightAt(new Date("2027-03-28T00:50:00Z"), {
        start: "01:00",
        end: "03:30",
        timeZone: zone,
      }),
    ).toEqual({ inside: true, endsInMs: 40 * minute });
    // A wait before the change wakes at the window's start, not an hour late.
    expect(
      nightAt(new Date("2027-03-28T00:30:00Z"), {
        start: "03:00",
        end: "04:00",
        timeZone: zone,
      }),
    ).toEqual({ inside: false, startsInMs: 30 * minute });
    // A start the clock skips (02:30) begins where the clock goes on (03:00).
    expect(
      nightAt(new Date("2027-03-28T00:30:00Z"), {
        start: "02:30",
        end: "04:00",
        timeZone: zone,
      }),
    ).toEqual({ inside: false, startsInMs: 30 * minute });
    // A window wholly in the skipped hour does not happen that night: the
    // next is the night after.
    expect(
      nightAt(new Date("2027-03-27T12:00:00Z"), {
        start: "02:00",
        end: "02:45",
        timeZone: zone,
      }),
    ).toEqual({ inside: false, startsInMs: 36 * 60 * minute });
  });

  test("real time across the autumn change in Prague (2026-10-25, 03:00 CEST becomes 02:00 CET)", () => {
    const minute = 60_000;
    const zone = "Europe/Prague";
    const window = { start: "01:00", end: "02:30", timeZone: zone };
    // 01:50 CEST: the end is the first time the clock reads 02:30.
    expect(nightAt(new Date("2026-10-24T23:50:00Z"), window)).toEqual({
      inside: true,
      endsInMs: 40 * minute,
    });
    // The repeated hour reads inside the window again (02:10 CET), up to
    // the second 02:30.
    expect(nightAt(new Date("2026-10-25T01:10:00Z"), window)).toEqual({
      inside: true,
      endsInMs: 20 * minute,
    });
    // A wait over the repeated hour: 03:00 CET comes 150 real minutes after
    // 01:30 CEST, not 90.
    expect(
      nightAt(new Date("2026-10-24T23:30:00Z"), {
        start: "03:00",
        end: "04:00",
        timeZone: zone,
      }),
    ).toEqual({ inside: false, startsInMs: 150 * minute });
  });

  test("when a night stop may start: not in the last minutes of a window, but at the next one", () => {
    const minute = 60_000;
    const late = { start: "02:00", end: "05:00", timeZone: "UTC" };
    // Inside with an hour left: now.
    expect(
      nightStartsIn(new Date("2026-11-21T04:00:00Z"), late, 20 * minute),
    ).toBe(0);
    // 10 minutes left of the window: its end, then the next night's start.
    expect(
      nightStartsIn(new Date("2026-11-21T04:50:00Z"), late, 20 * minute),
    ).toBe((10 + 21 * 60) * minute);
    // Outside: the next start.
    expect(
      nightStartsIn(new Date("2026-11-21T01:00:00Z"), late, 20 * minute),
    ).toBe(60 * minute);
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
