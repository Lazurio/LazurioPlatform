import { expect, test } from "bun:test";
import { parseUniqueJson } from "../src/providers/unique-json";

test("unique JSON retains native values and permits equal keys in different objects", () => {
  for (const source of [
    '{"a":[{"x":1},{"x":2}],"b":"{\\"x\\":1}","c":null}',
    '{"__proto__":1,"constructor":2,"quote\\"":3,"slash\\\\":4}',
    '[1,true,false,null,"x",{"a":{},"b":[]}]',
    '"plain string"',
    " -1.25e2 ",
  ])
    expect(parseUniqueJson(source)).toEqual(JSON.parse(source));
});

test("unique JSON rejects duplicate decoded keys at every nesting level", () => {
  for (const source of [
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    '{"a":[{"deep":{"x":1,"x":1}}]}',
    '{"__proto__":1,"__proto__":2}',
    '{"quote\\"":1,"quote\\"":2}',
  ])
    expect(() => parseUniqueJson(source)).toThrow(
      "Duplicate JSON declaration member",
    );
  expect(() => parseUniqueJson('{"private-marker":')).toThrow(
    "Invalid JSON declaration",
  );
});
