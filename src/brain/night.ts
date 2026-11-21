// When search by meaning computes its vectors (plan LZD-0033 R11a, decided
// by Matěj on 2026-11-21: a nightly computation after the windows of #1134).
// The long work, which keeps the memory stopped, runs only in a night window
// the person chooses; by day nothing stops the memory for it, except a small
// backlog one short window computes (a new or small brain). The window is in
// the person's time zone: an Environment does not know it (neither the
// profile nor the Folder carries it), so it is part of the choice and
// defaults to Prague's.

export type NightWindow = Readonly<{
  /** `HH:MM`, the window's start and end in `timeZone` (an end before the
   * start runs past midnight). */
  start: string;
  end: string;
  timeZone: string;
}>;

export const defaultNight: NightWindow = Object.freeze({
  start: "02:00",
  end: "05:00",
  timeZone: "Europe/Prague",
});

const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight of `HH:MM`, or null. */
export function minutesOf(text: string): number | null {
  const found = clock.exec(text);
  if (found === null) return null;
  return Number(found[1]) * 60 + Number(found[2]);
}

/** Whether an IANA time zone is one this runtime knows. */
export function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** A window as the person gives it (`02:00-05:00`, a time zone), or why
 * not: a clock time that is not `HH:MM`, an empty window, an unknown zone. */
export function parseNight(
  range: string,
  timeZone: string = defaultNight.timeZone,
): NightWindow | "invalid-range" | "invalid-time-zone" {
  const [start, end, ...rest] = range.split("-");
  if (
    rest.length > 0 ||
    start === undefined ||
    end === undefined ||
    minutesOf(start) === null ||
    minutesOf(end) === null ||
    start === end
  )
    return "invalid-range";
  if (!knownTimeZone(timeZone)) return "invalid-time-zone";
  return Object.freeze({ start, end, timeZone });
}

/** A stored window, or the default where none is stored or it is not
 * valid any more. */
export function nightOf(stored: unknown): NightWindow {
  if (typeof stored !== "object" || stored === null) return defaultNight;
  const { start, end, timeZone } = stored as Record<string, unknown>;
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    typeof timeZone !== "string"
  )
    return defaultNight;
  const parsed = parseNight(`${start}-${end}`, timeZone);
  return typeof parsed === "string" ? defaultNight : parsed;
}

/** The minute of the day at `now` in a time zone. */
function minuteIn(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** Where `now` stands to the window: inside it, with the milliseconds left
 * to its end, or outside, with the milliseconds to its next start. Counted
 * in whole minutes of the zone's clock, so a change of daylight saving time
 * moves the window with the clock. */
export function nightAt(
  now: Date,
  window: NightWindow,
):
  | Readonly<{ inside: true; endsInMs: number }>
  | Readonly<{ inside: false; startsInMs: number }> {
  const day = 24 * 60;
  const start = minutesOf(window.start) as number;
  const end = minutesOf(window.end) as number;
  const minute = minuteIn(now, window.timeZone);
  const seconds = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  const length = (end - start + day) % day;
  const sinceStart = (minute - start + day) % day;
  if (sinceStart < length)
    return {
      inside: true,
      endsInMs: (length - sinceStart) * 60_000 - seconds,
    };
  return {
    inside: false,
    startsInMs: (day - sinceStart) * 60_000 - seconds,
  };
}
