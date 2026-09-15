import { expect, test } from "bun:test";
import { parsePreparationDeclaration } from "../src/modules/preparation-declaration";

const declaration = {
  schema_version: "lazurio.preparation.v1" as const,
  owner_package: "app/package.json",
  check_script: "check:data",
};
test("preparation declaration selects explicit owner and scripts without defaults", () => {
  expect(parsePreparationDeclaration(declaration)).toEqual(declaration);
  const complete = {
    ...declaration,
    owner_package: "package.json",
    prepare_script: "prepare:data",
  };
  expect(parsePreparationDeclaration(complete)).toEqual(complete);
  expect(Object.isFrozen(parsePreparationDeclaration(complete))).toBe(true);
});
test("preparation declaration rejects paths, shell commands, unknown fields and executable inputs", () => {
  for (const owner_package of [
    "../package.json",
    "app/../package.json",
    "/package.json",
    "app\\package.json",
    "app//package.json",
    "app/./package.json",
    "package.json\n",
  ])
    expect(() =>
      parsePreparationDeclaration({ ...declaration, owner_package }),
    ).toThrow();
  for (const check_script of ["", "--eval", "check && launch", "check\n", null])
    expect(() =>
      parsePreparationDeclaration({ ...declaration, check_script }),
    ).toThrow();
  for (const bad of [
    { ...declaration, schema_version: "future" },
    { ...declaration, grant: true },
    { ...declaration, prepare_script: undefined },
    {
      schema_version: declaration.schema_version,
      owner_package: "package.json",
    },
  ])
    expect(() => parsePreparationDeclaration(bad)).toThrow();
  let called = false;
  expect(() =>
    parsePreparationDeclaration({
      ...declaration,
      get prepare_script() {
        called = true;
        return "prepare";
      },
    }),
  ).toThrow();
  expect(called).toBe(false);
  expect(() =>
    parsePreparationDeclaration(Object.create(declaration)),
  ).toThrow();
});
