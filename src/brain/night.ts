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

/** The least of a window a night stop starts in (the stop needs it for a
 * minute of computation, a batch to the model, gbrain's start and the
 * server's, with room for the copy and the steps before). */
export const nightLeastMinutes = 20;
/** The shortest window a person may choose: the least a stop starts in and
 * room for the Launchpad to reach its start (its wait wakes at the start,
 * and setup takes a while before it stops the server). */
export const nightShortestMinutes = 30;

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
 * not: a clock time that is not `HH:MM` or an empty window, a window shorter
 * than `nightShortestMinutes` (no stop could run in it), an unknown zone. */
export function parseNight(
  range: string,
  timeZone: string = defaultNight.timeZone,
): NightWindow | "invalid-range" | "too-short" | "invalid-time-zone" {
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
  const day = 24 * 60;
  const length =
    ((minutesOf(end) as number) - (minutesOf(start) as number) + day) % day;
  if (length < nightShortestMinutes) return "too-short";
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

/** Real milliseconds until a night stop may start: 0 inside the window
 * with at least `leastMs` left; else to the next window's start (after this
 * one's end, where too little of it is left). */
export function nightStartsIn(
  now: Date,
  window: NightWindow,
  leastMs: number,
): number {
  const at = nightAt(now, window);
  if (!at.inside) return at.startsInMs;
  if (at.endsInMs >= leastMs) return 0;
  const after = nightAt(new Date(now.getTime() + at.endsInMs), window);
  return at.endsInMs + (after.inside ? 0 : after.startsInMs);
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** The minute of the day the zone's clock reads at `at` (epoch ms). */
function minuteIn(at: number, timeZone: string): number {
  let format = formats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formats.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

const minuteMs = 60_000;
/** How far ahead the next change is looked for: a day where the window's
 * hours do not exist (a spring change), then the next day's. */
const horizonMinutes = 3 * 24 * 60;

/** Where `now` stands to the window: inside it, with the real milliseconds
 * left to its end, or outside, with the real milliseconds to its next start.
 * The window is where the zone's clock reads inside it, so on a change of
 * daylight saving time the real time differs from the clock's:
 * - in spring, hours the clock skips do not count: a window of 01:00–03:30
 *   in Prague at 01:50 on the day of the change ends 40 real minutes later,
 *   and a start the clock skips (02:30) begins where the clock goes on
 *   (03:00);
 * - in autumn, an hour the clock repeats is inside the window each time it
 *   reads inside it, and its end is the first time the clock reads the end.
 * Found by walking real minutes ahead, the zone's clock read at each. */
export function nightAt(
  now: Date,
  window: NightWindow,
):
  | Readonly<{ inside: true; endsInMs: number }>
  | Readonly<{ inside: false; startsInMs: number }> {
  const day = 24 * 60;
  const start = minutesOf(window.start) as number;
  const end = minutesOf(window.end) as number;
  const length = (end - start + day) % day;
  const inside = (at: number) =>
    (minuteIn(at, window.timeZone) - start + day) % day < length;
  const at = now.getTime();
  const wasInside = inside(at);
  const first = Math.floor(at / minuteMs) * minuteMs + minuteMs;
  for (let i = 0; i < horizonMinutes; i++) {
    const next = first + i * minuteMs;
    if (inside(next) !== wasInside)
      return wasInside
        ? { inside: true, endsInMs: next - at }
        : { inside: false, startsInMs: next - at };
  }
  // Unreachable for a window `parseNight` accepts: every day has a minute
  // outside it, and every two days one inside.
  return wasInside
    ? { inside: true, endsInMs: horizonMinutes * minuteMs }
    : { inside: false, startsInMs: horizonMinutes * minuteMs };
}
