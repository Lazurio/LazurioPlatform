import { expect, test } from "bun:test";
import {
  type AppWindow,
  appLinkTarget,
  startThenOpen,
} from "../src/launchpad/app-opening";

// Root decision 0185 S18: one account setting says where module apps open, a
// new tab ("tab", the default) or this window ("same", a plain navigation to
// the app's own address; never a frame). On a workstation the app is started
// first: for a new tab the tab is opened within the click, for this window
// nothing moves until the start succeeded.

test("a link to an app on its own origin: a new tab, or this window", () => {
  expect(appLinkTarget("tab")).toEqual({
    target: "_blank",
    rel: "noopener noreferrer",
  });
  expect(appLinkTarget("same")).toEqual({ target: null, rel: "noreferrer" });
});

type Seen = string[];
function browser(seen: Seen, blocked = false): AppWindow {
  return {
    open: () => {
      seen.push("open");
      return blocked
        ? null
        : {
            close: () => seen.push("close"),
            navigate: (href) => seen.push(`tab ${href}`),
          };
    },
    assign: (href) => seen.push(`assign ${href}`),
  };
}

test("a new tab: opened within the click, before the start answers, then led to the app", async () => {
  const seen: Seen = [];
  let finish: (link: string | null) => void = () => undefined;
  const opening = startThenOpen(
    "tab",
    () =>
      new Promise((resolve) => {
        seen.push("start");
        finish = resolve;
      }),
    browser(seen),
  );
  // Synchronously, within the click: the tab first, then the start.
  expect(seen).toEqual(["open", "start"]);
  finish("http://127.0.0.1:4410/");
  expect(await opening).toBe(true);
  expect(seen).toEqual(["open", "start", "tab http://127.0.0.1:4410/"]);
});

test("a new tab whose app does not start is closed again", async () => {
  for (const start of [
    async () => null,
    async () => {
      throw new Error("refused");
    },
  ]) {
    const seen: Seen = [];
    expect(await startThenOpen("tab", start, browser(seen))).toBe(false);
    expect(seen).toEqual(["open", "close"]);
  }
  const blocked: Seen = [];
  expect(
    await startThenOpen(
      "tab",
      async () => "http://127.0.0.1:4410/",
      browser(blocked, true),
    ),
  ).toBe(false);
  expect(blocked).toEqual(["open"]);
});

test("this window: no tab, and it moves only once the start succeeded", async () => {
  const seen: Seen = [];
  let finish: (link: string | null) => void = () => undefined;
  const opening = startThenOpen(
    "same",
    () =>
      new Promise((resolve) => {
        seen.push("start");
        finish = resolve;
      }),
    browser(seen),
  );
  expect(seen).toEqual(["start"]);
  finish("http://127.0.0.1:4410/");
  expect(await opening).toBe(true);
  expect(seen).toEqual(["start", "assign http://127.0.0.1:4410/"]);
  const failed: Seen = [];
  expect(await startThenOpen("same", async () => null, browser(failed))).toBe(
    false,
  );
  expect(failed).toEqual([]);
});
