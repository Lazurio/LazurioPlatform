import { expect, test } from "bun:test";
import {
  classifyRepositorySlotPath,
  inspectRepositorySlots,
} from "../src/organizations/repository-slots";

test("repository slot paths preserve exact mounts and distinguish root, workspace, production and nested database", () => {
  for (const path of [
    "design-system",
    "infra",
    "mission-control",
    "mission-control/db",
  ])
    expect(classifyRepositorySlotPath(path)?.scope).toBe("root");
  expect(classifyRepositorySlotPath("productionspace/Fixture_App.v2")).toEqual({
    path: "productionspace/Fixture_App.v2",
    scope: "productionspace",
    nestedDatabase: false,
  });
  expect(classifyRepositorySlotPath("modules/Fixture/db")).toEqual({
    path: "modules/Fixture/db",
    scope: "workspace",
    nestedDatabase: true,
  });
  for (const path of [
    "../workspace/a",
    "/workspace/a",
    "workspace",
    "workspace/a/",
    "workspace//a",
    "workspace/./a",
    "workspace/a/../b",
    "workspace\\a",
    "workspace/a\n",
    "workspace/a\0",
    "workspace/a.",
    "workspace/.hidden",
    "productionspace/a/db",
    "workspace/a/other",
    "infra/other",
    "Workspace/a",
  ])
    expect(classifyRepositorySlotPath(path)).toBe(null);
});

test("repository slot diagnostics retain healthy sibling indices and do not mutate declarations", () => {
  const input = [
    { path: "workspace/Fixture", slug: "fixture" },
    { path: "workspace/Fixture/db", source_of_truth: "repository-db:fixture" },
    { path: "productionspace/Another", slug: "another", space: "workspace" },
  ];
  const before = JSON.stringify(input);
  const result = inspectRepositorySlots(input);
  expect(result.issues).toEqual([]);
  expect(result.slots[1]?.id).toBe(null);
  expect(result.slots[2]?.scope).toBe("productionspace");
  expect(JSON.stringify(input)).toBe(before);
  expect(Object.isFrozen(result.slots)).toBe(true);
  const cases: [unknown[], string][] = [
    [[{ path: "workspace/a" }, { path: "workspace/a" }], "duplicate-path"],
    [
      [
        { path: "workspace/a", slug: "a" },
        { path: "workspace/a", slug: "b" },
      ],
      "path-identity-conflict",
    ],
    [
      [
        { path: "workspace/A", slug: "a" },
        { path: "workspace/a", slug: "b" },
      ],
      "path-case-collision",
    ],
    [
      [
        { path: "workspace/a", slug: "same" },
        { path: "workspace/b", slug: "same" },
      ],
      "repository-id-collision",
    ],
    [[{ path: "workspace/a/db" }], "repository-db-parent-missing"],
    [
      [{ path: "workspace/A", slug: "a" }, { path: "workspace/a/db" }],
      "repository-db-parent-missing",
    ],
    [[{ path: "workspace/a", slug: "root" }], "invalid-repository-slug"],
    [[{ path: "workspace/A" }], "invalid-repository-slug"],
    [[{ path: "workspace/a/db", slug: 1 }], "invalid-repository-slug"],
    [[{ path: "workspace" }], "unsupported-path"],
    [[null], "invalid-declaration"],
  ];
  for (const [bad, code] of cases) {
    const observed = inspectRepositorySlots([
      ...bad,
      { path: "workspace/healthy", slug: "healthy" },
    ]);
    expect(
      observed.issues.some((issue) => issue.code === code),
      code,
    ).toBe(true);
    expect(
      observed.issues.every((issue) => !issue.indices.includes(bad.length)),
    ).toBe(true);
    expect(observed.slots.at(-1)?.id).toBe("healthy");
  }
});
