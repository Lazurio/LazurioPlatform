import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import type { PillStatus } from "../src/launchpad/update-pill";
import { checkAge, fill, pillView } from "../src/launchpad/update-view";
import { updateError } from "../src/update/errors";

const now = Date.parse("2026-09-22T12:00:00.000Z");
const status = (overrides: Partial<PillStatus> = {}): PillStatus => ({
  kind: "update-pill",
  state: "idle",
  running: "1.0.0",
  active: "1.0.0",
  latest: null,
  notesUrl: null,
  checkedAt: null,
  stale: false,
  supervised: true,
  restartRequired: false,
  action: null,
  error: null,
  stateInvalid: null,
  ...overrides,
});

test("the age of the last verified check is coarse and visible", () => {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  expect(checkAge(ago(0), now)).toBe("<1 min");
  expect(checkAge(ago(59_000), now)).toBe("<1 min");
  expect(checkAge(ago(12 * 60_000), now)).toBe("12 min");
  expect(checkAge(ago(3 * 60 * 60_000 + 5), now)).toBe("3 h");
  expect(checkAge(ago(49 * 60 * 60_000), now)).toBe("2 d");
  expect(checkAge("garbage", now)).toBe("<1 min");
  expect(fill("{a} and {b} and {c}", { a: "1", b: "2" })).toBe(
    "1 and 2 and {c}",
  );
});

test("one line, one link and one button per state, in both languages", () => {
  for (const locale of ["en", "cs"]) {
    const copy = messages(locale);
    const view = (overrides: Partial<PillStatus>) =>
      pillView(status(overrides), copy, now);
    expect(view({})).toMatchObject({
      text: fill(copy.updateUnknown, { running: "1.0.0" }),
      notesUrl: null,
      action: null,
      checked: copy.updateNeverChecked,
      error: null,
      stateInvalid: null,
    });
    const checked = {
      latest: "1.1.0",
      notesUrl: "https://example.test/notes",
      checkedAt: new Date(now - 12 * 60_000).toISOString(),
    };
    expect(view({ ...checked, latest: "1.0.0" }).text).toBe(
      fill(copy.updateIdle, { running: "1.0.0" }),
    );
    expect(view({ ...checked, state: "available", action: "update" })).toEqual({
      text: fill(copy.updateAvailable, {
        latest: "1.1.0",
        running: "1.0.0",
      }),
      notesUrl: "https://example.test/notes",
      action: { label: copy.updateAction, version: "1.1.0" },
      checked: fill(copy.updateChecked, { age: "12 min" }),
      stale: false,
      error: null,
      stateInvalid: null,
    });
    expect(
      view({
        ...checked,
        state: "available",
        action: "retry",
        error: updateError("activation-failed", { from: "1.0.0" }),
      }),
    ).toMatchObject({
      action: { label: copy.updateRetry, version: "1.1.0" },
      error: fill(copy.updateFailed, { code: "activation-failed" }),
    });
    expect(view({ ...checked, state: "checking" }).text).toBe(
      copy.updateChecking,
    );
    expect(view({ ...checked, state: "downloading" }).text).toBe(
      fill(copy.updateDownloading, { latest: "1.1.0" }),
    );
    expect(view({ ...checked, state: "activating" }).text).toBe(
      fill(copy.updateActivating, { latest: "1.1.0" }),
    );
    // The restart is said, not clicked: there is nothing this page could do.
    expect(
      view({
        ...checked,
        state: "activating",
        restartRequired: true,
        supervised: false,
        active: "1.1.0",
        action: "restart",
      }),
    ).toMatchObject({
      text: fill(copy.updateRestart, { active: "1.1.0" }),
      action: null,
    });
    expect(
      view({
        ...checked,
        checkedAt: new Date(now - 30 * 60 * 60_000).toISOString(),
        stale: true,
      }),
    ).toMatchObject({
      stale: true,
      checked: fill(copy.updateStale, { age: "1 d" }),
    });
    expect(
      view({ ...checked, stateInvalid: "update/pending.json" }).stateInvalid,
    ).toBe(fill(copy.updateStateInvalid, { path: "update/pending.json" }));
    // Every message the view can pick exists in this language.
    for (const key of [
      "updateUnknown",
      "updateIdle",
      "updateChecking",
      "updateAvailable",
      "updateDownloading",
      "updateActivating",
      "updateRestart",
      "updateAction",
      "updateRetry",
      "updateChecked",
      "updateNeverChecked",
      "updateStale",
      "updateFailed",
      "updateStateInvalid",
    ] as const)
      expect(copy[key].length).toBeGreaterThan(0);
  }
});
