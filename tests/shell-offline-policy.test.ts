import { expect, test } from "bun:test";
import {
  cacheName,
  failedNavigation,
  OFFLINE_CACHE_PREFIX,
  OFFLINE_EXPIRY_MS,
  OFFLINE_REFRESH_MS,
  offlineWorkerPrelude,
  parseContact,
  refreshOutcome,
  shouldRefresh,
  staleCaches,
} from "../src/shell/offline-policy";

// DEV-6651 (LazurioPlatform#262): the offline guide's worker shows its kept
// guide page only while the Environment answered recently, removes itself
// after 30 days without contact, drops the caches of older versions and
// carries its version and page digest in its bytes, so no browser keeps a
// frozen worker.

const now = Date.UTC(2026, 9, 8, 10, 0, 0);
const digest = "a".repeat(64);

test("a failed navigation shows the guide while the Environment answered within 30 days", () => {
  expect(
    failedNavigation({ at: now - 1000, refreshedAt: now - 1000 }, now),
  ).toBe("guide");
  expect(
    failedNavigation({ at: now - OFFLINE_EXPIRY_MS, refreshedAt: now }, now),
  ).toBe("guide");
});

test("after 30 days without contact the worker retires instead of guiding", () => {
  expect(
    failedNavigation(
      { at: now - OFFLINE_EXPIRY_MS - 1, refreshedAt: now },
      now,
    ),
  ).toBe("retire");
});

test("without a readable contact the worker retires rather than guess", () => {
  expect(failedNavigation(null, now)).toBe("retire");
  expect(parseContact("not json")).toBeNull();
  expect(
    parseContact(JSON.stringify({ at: "yesterday", refreshedAt: now })),
  ).toBeNull();
  expect(parseContact(JSON.stringify({ at: now }))).toBeNull();
  expect(
    parseContact(JSON.stringify({ at: now, refreshedAt: now - 5 })),
  ).toEqual({
    at: now,
    refreshedAt: now - 5,
  });
});

test("the kept guide page is refreshed at most once an hour", () => {
  expect(shouldRefresh(null, now)).toBe(true);
  expect(
    shouldRefresh({ at: now, refreshedAt: now - OFFLINE_REFRESH_MS + 1 }, now),
  ).toBe(false);
  expect(
    shouldRefresh({ at: now, refreshedAt: now - OFFLINE_REFRESH_MS }, now),
  ).toBe(true);
});

test("a refresh answered 404 retires the worker: the origin keeps no guide any more", () => {
  // A Launchpad without a tailnet, or rolled back to a release before the
  // guide, answers the page 404; the worker removes itself instead of
  // renewing its contact on every navigation.
  expect(refreshOutcome(404)).toBe("retire");
  expect(refreshOutcome(200)).toBe("replace");
  // No answer (no network, the sign-in's redirect) or a server error keeps
  // the page and the worker.
  for (const status of [null, 401, 500, 502, 503])
    expect(refreshOutcome(status)).toBe("keep");
});

test("activation drops every cache of older versions and nothing else of the origin", () => {
  const current = cacheName(digest);
  const older = cacheName("b".repeat(64));
  expect(
    staleCaches(
      [current, older, "app-cache", `${OFFLINE_CACHE_PREFIX}x`],
      current,
    ),
  ).toEqual([older, `${OFFLINE_CACHE_PREFIX}x`]);
});

test("the worker's bytes carry its version and the guide page's digest", () => {
  const prelude = offlineWorkerPrelude({
    version: "0.1.9",
    page: digest,
    retired: false,
  });
  expect(prelude).toContain(digest);
  expect(prelude).toContain("0.1.9");
  expect(prelude).not.toBe(
    offlineWorkerPrelude({
      version: "0.1.9",
      page: "c".repeat(64),
      retired: false,
    }),
  );
  expect(() =>
    offlineWorkerPrelude({
      version: "0.1.9",
      page: "not-a-digest",
      retired: false,
    }),
  ).toThrow();
});
