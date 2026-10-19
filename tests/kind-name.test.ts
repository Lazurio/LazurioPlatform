import { expect, test } from "bun:test";
import { shellEnvironmentKinds } from "../src/shell/contract";
import {
  hasKindToken,
  inKind,
  type KindCase,
  kindDetail,
  kindLabel,
  kindName,
  kindShort,
  shownKind,
} from "../src/shell/kind-name";

// Decision F28's addendum of 2026-10-18 (root decision 0207, addendum of the
// same day): people read three kinds of Environment, Osobní, Pracovní and
// Týmové Prostředí (Personal, Work and Team Environment); an automated one is
// a work one, and the person's own computer has no kind, it is "váš
// počítač". The helper is the prototype's `kindName` (prototypes-lazurio
// affc81e, app/v1/src/data.ts), with English added; its forms are the
// prototype's test `three-kinds.test.tsx`.

const cases: readonly KindCase[] = ["nom", "gen", "dat", "acc", "loc", "ins"];
const forms = (
  kind: (typeof shellEnvironmentKinds)[number],
  determiner?: "this" | "your",
) =>
  cases.map((grammaticalCase) =>
    kindName(kind, {
      case: grammaticalCase,
      ...(determiner === undefined ? {} : { determiner }),
    }),
  );

test("the kinds people read are three, and your own computer has none: Váš počítač", () => {
  const labels = (locale: "cs" | "en") =>
    Object.fromEntries(
      shellEnvironmentKinds.map((kind) => [kind, kindLabel(kind, locale)]),
    );
  expect(labels("cs")).toEqual({
    personal: "Osobní Prostředí",
    work: "Pracovní Prostředí",
    team: "Týmové Prostředí",
    automated: "Pracovní Prostředí",
    workstation: "Váš počítač",
  });
  expect(labels("en")).toEqual({
    personal: "Personal Environment",
    work: "Work Environment",
    team: "Team Environment",
    automated: "Work Environment",
    workstation: "Your computer",
  });
  // The one word beside an Environment's name.
  expect(shellEnvironmentKinds.map((kind) => kindShort(kind, "cs"))).toEqual([
    "Osobní",
    "Pracovní",
    "Týmové",
    "Pracovní",
    "Váš počítač",
  ]);
  expect(shellEnvironmentKinds.map((kind) => kindShort(kind, "en"))).toEqual([
    "Personal",
    "Work",
    "Team",
    "Work",
    "Your computer",
  ]);
  // An automated one is a work Environment; where it helps, it says its
  // automations.
  expect(shownKind("automated")).toBe("work");
  for (const kind of shellEnvironmentKinds)
    if (kind !== "automated") expect(shownKind(kind)).toBe(kind);
  expect(kindDetail("automated", "cs")).toBe(
    "Pracovní Prostředí s automatizacemi",
  );
  expect(kindDetail("automated", "en")).toBe(
    "Work Environment with automations",
  );
  for (const kind of ["personal", "work", "team", "workstation"] as const)
    for (const locale of ["cs", "en"] as const)
      expect(kindDetail(kind, locale)).toBe(kindLabel(kind, locale));
});

test("the helper says each kind in the case a sentence needs, after this or your", () => {
  expect(forms("personal")).toEqual([
    "Osobní Prostředí",
    "Osobního Prostředí",
    "Osobnímu Prostředí",
    "Osobní Prostředí",
    "Osobním Prostředí",
    "Osobním Prostředím",
  ]);
  expect(forms("work", "this")).toEqual([
    "toto Pracovní Prostředí",
    "tohoto Pracovního Prostředí",
    "tomuto Pracovnímu Prostředí",
    "toto Pracovní Prostředí",
    "tomto Pracovním Prostředí",
    "tímto Pracovním Prostředím",
  ]);
  for (const determiner of [undefined, "this", "your"] as const)
    expect(forms("automated", determiner)).toEqual(forms("work", determiner));
  expect(forms("team", "this")).toEqual([
    "toto Týmové Prostředí",
    "tohoto Týmového Prostředí",
    "tomuto Týmovému Prostředí",
    "toto Týmové Prostředí",
    "tomto Týmovém Prostředí",
    "tímto Týmovým Prostředím",
  ]);
  expect(forms("team")).toEqual([
    "Týmové Prostředí",
    "Týmového Prostředí",
    "Týmovému Prostředí",
    "Týmové Prostředí",
    "Týmovém Prostředí",
    "Týmovým Prostředím",
  ]);
  expect(forms("personal", "your")).toEqual([
    "vaše Osobní Prostředí",
    "vašeho Osobního Prostředí",
    "vašemu Osobnímu Prostředí",
    "vaše Osobní Prostředí",
    "vašem Osobním Prostředí",
    "vaším Osobním Prostředím",
  ]);
  // Váš počítač is masculine and has no kind; "váš" is part of its name.
  for (const determiner of [undefined, "your"] as const)
    expect(forms("workstation", determiner)).toEqual([
      "váš počítač",
      "vašeho počítače",
      "vašemu počítači",
      "váš počítač",
      "vašem počítači",
      "vaším počítačem",
    ]);
  expect(forms("workstation", "this")).toEqual([
    "tento počítač",
    "tohoto počítače",
    "tomuto počítači",
    "tento počítač",
    "tomto počítači",
    "tímto počítačem",
  ]);
  // English has no case.
  for (const grammaticalCase of cases) {
    expect(
      kindName("team", {
        locale: "en",
        case: grammaticalCase,
        determiner: "this",
      }),
    ).toBe("this Team Environment");
    expect(
      kindName("workstation", { locale: "en", case: grammaticalCase }),
    ).toBe("your computer");
  }
  expect(kindName("personal", { locale: "en", determiner: "your" })).toBe(
    "your Personal Environment",
  );
  expect(kindName("automated", { locale: "en", determiner: "this" })).toBe(
    "this Work Environment",
  );
  expect(kindName("workstation", { locale: "en", determiner: "this" })).toBe(
    "this computer",
  );
});

test("a text's tokens name the kind of the Environment it is in", () => {
  const czech =
    "{Toto} je tu. Lazurio {v tomto} běží, {V tomto} taky; trezor {tohoto}, k {tomuto}, o {toto}, s {tímto}, po {tomto}.";
  expect(inKind(czech, "team")).toBe(
    "Toto Týmové Prostředí je tu. Lazurio v tomto Týmovém Prostředí běží, V tomto Týmovém Prostředí taky; trezor tohoto Týmového Prostředí, k tomuto Týmovému Prostředí, o toto Týmové Prostředí, s tímto Týmovým Prostředím, po tomto Týmovém Prostředí.",
  );
  expect(inKind(czech, "automated")).toBe(inKind(czech, "work"));
  expect(inKind(czech, "personal")).toBe(
    "Toto Osobní Prostředí je tu. Lazurio v tomto Osobním Prostředí běží, V tomto Osobním Prostředí taky; trezor tohoto Osobního Prostředí, k tomuto Osobnímu Prostředí, o toto Osobní Prostředí, s tímto Osobním Prostředím, po tomto Osobním Prostředí.",
  );
  // A computer is "na" it, not "v" it.
  expect(inKind(czech, "workstation")).toBe(
    "Tento počítač je tu. Lazurio na tomto počítači běží, Na tomto počítači taky; trezor tohoto počítače, k tomuto počítači, o tento počítač, s tímto počítačem, po tomto počítači.",
  );
  // Without a kind the plain words stay, never a wrong kind.
  expect(inKind(czech, null)).toBe(
    "Toto Prostředí je tu. Lazurio v tomto Prostředí běží, V tomto Prostředí taky; trezor tohoto Prostředí, k tomuto Prostředí, o toto Prostředí, s tímto Prostředím, po tomto Prostředí.",
  );
  const english =
    "{This} is here. It runs {in this}; {In this} too; {this}'s vault.";
  expect(inKind(english, "team")).toBe(
    "This Team Environment is here. It runs in this Team Environment; In this Team Environment too; this Team Environment's vault.",
  );
  expect(inKind(english, "automated")).toBe(inKind(english, "work"));
  expect(inKind(english, "workstation")).toBe(
    "This computer is here. It runs on this computer; On this computer too; this computer's vault.",
  );
  expect(inKind(english, null)).toBe(
    "This Environment is here. It runs in this Environment; In this Environment too; this Environment's vault.",
  );
  // Other placeholders are the catalog's own and stay for its `fill`.
  expect(inKind("{name} {Name} {tento} {that}", "team")).toBe(
    "{name} {Name} {tento} {that}",
  );
  for (const kind of [...shellEnvironmentKinds, null]) {
    expect(hasKindToken(inKind(czech, kind))).toBe(false);
    expect(hasKindToken(inKind(english, kind))).toBe(false);
  }
  expect(hasKindToken(czech)).toBe(true);
  expect(hasKindToken(english)).toBe(true);
  expect(hasKindToken("{name}")).toBe(false);
});
