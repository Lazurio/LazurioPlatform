import { expect, test } from "bun:test";
import { createBuddyIntroduction } from "../src/launchpad/buddy-introduction";
import type { BuddyReading } from "../src/launchpad/buddy-view";

// Buddy GEN4's introduction offered by itself to a person who met him before
// (review of Lazurio/LazurioPlatform#1153): the page asks again when the tour
// of Lazurio ends and when a dialog closes, and a storage that refuses the
// mark never opens it twice.

const met = {
  state: "works",
  signIn: "not-needed",
  persona: {
    buddyName: "Buddy",
    address: "vy",
    user: { nominative: "Bob", accusative: "Boba", dative: "Bobovi" },
    confirmed: true,
    revision: "a".repeat(64),
    pending: false,
  },
} as unknown as BuddyReading;

function page(storage: "working" | "full" | "dropping" | "none") {
  const map = new Map<string, string>();
  const state = { toured: false as boolean | null, dialog: false, opened: 0 };
  const stores = {
    working: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    },
    full: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    },
    dropping: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: () => undefined,
    },
    none: null,
  };
  const introduction = createBuddyIntroduction({
    here: () => true,
    reading: () => met,
    toured: () => state.toured,
    dialogOpen: () => state.dialog,
    environment: () => "env",
    storage: () => stores[storage],
    open: () => {
      state.opened += 1;
    },
  });
  return { introduction, state, map };
}

test("the tour of Lazurio ends: the page asks again and the introduction opens once", () => {
  const { introduction, state, map } = page("working");
  // A redraw while the tour still runs: nothing.
  expect(introduction.offer()).toBe(false);
  // Its last step (the tour's `advanced`): it opens, its mark kept first.
  state.toured = true;
  expect(introduction.offer()).toBe(true);
  expect(state.opened).toBe(1);
  expect(map.get("lazurio.buddy-introduced:env")).toBe("1");
  // Every later redraw or dialog change: never again.
  expect(introduction.offer()).toBe(false);
  expect(state.opened).toBe(1);
});

test("another dialog open when the tour ends: the introduction waits and opens once it closes", () => {
  const { introduction, state } = page("working");
  state.toured = true;
  state.dialog = true;
  expect(introduction.offer()).toBe(false);
  expect(state.opened).toBe(0);
  // The dialog closes (the page's observer of `open`).
  state.dialog = false;
  expect(introduction.offer()).toBe(true);
  expect(state.opened).toBe(1);
});

test("a storage that reads but refuses or drops the write, or none at all: it never opens by itself, so it never repeats", () => {
  for (const kind of ["full", "dropping", "none"] as const) {
    const { introduction, state } = page(kind);
    state.toured = true;
    for (let n = 0; n < 5; n += 1) introduction.offer();
    expect({ kind, opened: state.opened }).toEqual({ kind, opened: 0 });
  }
});

test("a tour the person asked for (Nastavení → Buddy) counts as seen: it does not open by itself afterwards", () => {
  const { introduction, state } = page("full");
  state.toured = true;
  introduction.keep();
  expect(introduction.offer()).toBe(false);
  const working = page("working");
  working.state.toured = true;
  working.introduction.keep();
  expect(working.introduction.offer()).toBe(false);
  expect(working.state.opened).toBe(0);
});
