import { expect, test } from "bun:test";
import { parseAccount } from "../src/launchpad/account";
import {
  createWorkspaceGroups,
  parseWorkspaceGroups,
  workspaceGroupsKey,
} from "../src/launchpad/workspace-groups";
import { accountDocument } from "./fixtures/account-document";

const scope = { kind: "organization", id: "Example" } as const;
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

test("a reversible move survives a new page and is isolated by person and space", () => {
  const store = storage();
  const first = createWorkspaceGroups(() => store);
  expect(first.move("ada", scope, "m:tools", "administration")).toBe("saved");
  const reload = createWorkspaceGroups(() => store);
  expect(reload.list("ADA", { ...scope, id: "example" })).toEqual(["m:tools"]);
  expect(reload.list("bob", scope)).toEqual([]);
  expect(reload.list("ada", { ...scope, id: "other" })).toEqual([]);
  expect(reload.list("ada", { kind: "personal", id: "Example" })).toEqual([]);
  expect(reload.move("ada", scope, "m:tools", "work")).toBe("saved");
  expect(first.list("ada", scope)).toEqual([]);
});

test("sequential changes from two tabs preserve each other's assignments", () => {
  const store = storage();
  const first = createWorkspaceGroups(() => store);
  const second = createWorkspaceGroups(() => store);
  first.move("ada", scope, "m:tools", "administration");
  second.move("ada", scope, "m:notes", "administration");
  first.move("ada", scope, "m:tools", "work");
  expect(second.list("ada", scope)).toEqual(["m:notes"]);
});

test("a failed write keeps the saved assignment; inaccessible storage fails without pretending to save", () => {
  const store = storage();
  const normal = createWorkspaceGroups(() => store);
  normal.move("ada", scope, "m:tools", "administration");
  const blocked = createWorkspaceGroups(() => ({
    getItem: store.getItem,
    setItem: () => {
      throw new Error("quota");
    },
  }));
  expect(blocked.move("ada", scope, "m:tools", "work")).toBe("failed");
  expect(normal.list("ada", scope)).toEqual(["m:tools"]);
  const denied = createWorkspaceGroups(() => {
    throw new Error("blocked");
  });
  expect(denied.list("ada", scope)).toEqual([]);
  expect(denied.move("ada", scope, "m:tools", "administration")).toBe("failed");
});

test("without a known account, a move is explicitly temporary and never reads another person's preferences", () => {
  const groups = createWorkspaceGroups(() => {
    throw new Error("must not touch storage");
  });
  expect(groups.move(null, scope, "m:tools", "administration")).toBe(
    "temporary",
  );
  expect(groups.list(null, scope)).toEqual(["m:tools"]);
  expect(createWorkspaceGroups(storage).list(null, scope)).toEqual([]);
});

test("corrupt preferences cannot hide everything or introduce repositories", () => {
  for (const raw of [
    null,
    "bad",
    "{}",
    '["r:firmware",null,12,"../other"]',
    JSON.stringify(Array(2001).fill("m:tools")),
  ])
    expect(parseWorkspaceGroups(raw)).toEqual([]);
  expect(parseWorkspaceGroups('["m:tools","m:tools","m:notes"]')).toEqual([
    "m:tools",
    "m:notes",
  ]);
  const store = storage();
  store.setItem(workspaceGroupsKey("ada", scope), "bad");
  const groups = createWorkspaceGroups(() => store);
  expect(groups.move("ada", scope, "r:firmware", "administration")).toBe(
    "failed",
  );
  expect(groups.move("ada", scope, "m:tools", "administration")).toBe("saved");
  expect(groups.list("ada", scope)).toEqual(["m:tools"]);
});

test("browser preferences use the account document's validated operator, never a directory or Environment identity", () => {
  expect(parseAccount(accountDocument())?.login).toBe("ada");
  for (const operator of [
    undefined,
    {},
    { login: "bob" },
    { initials: "B", login: "../bob", avatar: null },
  ])
    expect(parseAccount(accountDocument({ operator }))?.login).toBeNull();
});
