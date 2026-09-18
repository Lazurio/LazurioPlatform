import { expect, test } from "bun:test";
import { parseFolderProfile } from "../src/folder/profile";

const base = {
  os: "macos",
  access: "local",
  purpose: "human",
  locale: "cs",
  detail: "concise",
  coordination: "direct",
} as const;
test("four launch journey configurations share independent Czech and English choices", () => {
  const journeys = [
    base,
    { ...base, os: "windows" },
    { ...base, os: "linux", access: "remote" },
    { ...base, os: "linux", access: "remote", purpose: "buddy" },
  ] as const;
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const input = { ...journey, locale };
      expect(parseFolderProfile(input)).toEqual(input);
      expect(Object.isFrozen(parseFolderProfile(input))).toBe(true);
    }
});
test("profile parsing rejects unknown, missing, inherited and executable fields", () => {
  for (const input of [
    null,
    [],
    {},
    { ...base, locale: "de" },
    { ...base, os: "android" },
    { ...base, permission: "admin" },
    Object.create(base),
  ])
    expect(() => parseFolderProfile(input)).toThrow();
  let invoked = false;
  const accessor = {
    ...base,
    get locale() {
      invoked = true;
      return "cs";
    },
  };
  expect(() => parseFolderProfile(accessor)).toThrow();
  expect(invoked).toBe(false);
  expect(() =>
    parseFolderProfile({ ...base, [Symbol("extra")]: true }),
  ).toThrow();
});
