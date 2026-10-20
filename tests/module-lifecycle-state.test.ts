import { describe, expect, test } from "bun:test";
import {
  type LifecycleState,
  lifecycleShown,
} from "../src/launchpad/module-lifecycle-state";

const state = (key: string, message: string | null = null): LifecycleState => ({
  key,
  status: null,
  message,
  busy: false,
  focus: false,
});

describe("a refused Open's reason reaches the overview (its overview says why)", () => {
  test("from a home tile: the module's fresh overview starts with the reason, taken once", () => {
    const shown = lifecycleShown(
      state("o/other"),
      { key: "o/mc", message: "no access" },
      "o/mc",
    );
    expect(shown.fresh).toBe(true);
    expect(shown.lifecycle).toEqual(state("o/mc", "no access"));
    expect(shown.refusedOpen).toBeNull();
    const again = lifecycleShown(shown.lifecycle, shown.refusedOpen, "o/mc");
    expect(again.fresh).toBe(false);
    expect(again.lifecycle.message).toBe("no access");
  });

  test("from the overview already shown (its Open or its favourite): the same lifecycle takes the reason", () => {
    const current = state("o/mc");
    const shown = lifecycleShown(
      current,
      { key: "o/mc", message: "no access" },
      "o/mc",
    );
    expect(shown.fresh).toBe(false);
    expect(shown.lifecycle).toBe(current);
    expect(shown.lifecycle.message).toBe("no access");
    expect(shown.refusedOpen).toBeNull();
  });

  test("without a refusal an overview keeps its last sentence; another module's refusal stays for it", () => {
    const current = state("o/mc", "Started.");
    const refusal = { key: "o/deals", message: "no access" };
    const shown = lifecycleShown(current, refusal, "o/mc");
    expect(shown.fresh).toBe(false);
    expect(shown.lifecycle.message).toBe("Started.");
    expect(shown.refusedOpen).toBe(refusal);
    expect(lifecycleShown(null, null, "o/mc")).toEqual({
      lifecycle: state("o/mc"),
      refusedOpen: null,
      fresh: true,
    });
  });
});

test("a refused Open of a static app whose build failed offers its development version on the overview (decision F58)", () => {
  const shown = lifecycleShown(
    null,
    { key: "o/docs", message: "could not be built", development: true },
    "o/docs",
  );
  expect(shown.lifecycle).toEqual({
    ...state("o/docs", "could not be built"),
    development: true,
  });
  // A later refusal that offers nothing takes the offer back.
  const again = lifecycleShown(
    shown.lifecycle,
    { key: "o/docs", message: "port occupied" },
    "o/docs",
  );
  expect(again.lifecycle.development).toBeUndefined();
});
