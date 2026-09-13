import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { organizationDocumentHash } from "../src/organizations/document-hash";

test("Organization hash follows existing sorted JSON semantics, including numeric keys and array order", () => {
  const input = JSON.parse(
    '{"z":[{"b":2,"a":1},null,true,"česky"],"a":{"10":"ten","2":"two","b":false,"a":-0}}',
  );
  const expectedBytes =
    '{"a":{"2":"two","10":"ten","a":0,"b":false},"z":[{"a":1,"b":2},null,true,"česky"]}';
  const expected = `sha256:${createHash("sha256").update(expectedBytes).digest("hex")}`;
  expect(organizationDocumentHash(input)).toBe(expected);
  expect(organizationDocumentHash(JSON.parse(expectedBytes))).toBe(expected);
  expect(organizationDocumentHash({ a: [1, 2] })).not.toBe(
    organizationDocumentHash({ a: [2, 1] }),
  );
  expect(organizationDocumentHash({ a: null })).not.toBe(
    organizationDocumentHash({}),
  );
  const shared = { v: 1 };
  expect(organizationDocumentHash({ a: shared, b: shared })).toBe(
    organizationDocumentHash({ a: { v: 1 }, b: { v: 1 } }),
  );
  expect(
    organizationDocumentHash(JSON.parse('{"__proto__":{"x":1}}')),
  ).not.toBe(organizationDocumentHash({}));
});

test("Organization hash rejects executable, lossy and cyclic inputs without invoking hooks", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const hook = {
    toJSON() {
      calls++;
      return {};
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    getter,
    hook,
    cycle,
    new Date(),
    undefined,
    NaN,
    Infinity,
    1n,
    [undefined],
    new Array(2),
    { x: undefined },
    { [Symbol("x")]: 1 },
    Object.defineProperty({}, "x", { value: 1 }),
  ])
    expect(() => organizationDocumentHash(value)).toThrow();
  expect(calls).toBe(0);
});
