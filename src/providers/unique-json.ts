// JSON.parse validates syntax but discards duplicate members. Walk the validated
// source before returning its value, comparing decoded keys in each object.
// Iterative scanning avoids imposing a second recursive parser's depth limit.
export function parseUniqueJson(source: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Invalid JSON declaration");
  }
  const stack: { keys: Set<string> | null; expectingKey: boolean }[] = [];
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      while (++index < source.length) {
        if (source[index] === "\\") index++;
        else if (source[index] === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.keys && frame.expectingKey) {
        const key = JSON.parse(source.slice(start, index + 1)) as string;
        if (frame.keys.has(key))
          throw new Error("Duplicate JSON declaration member");
        frame.keys.add(key);
        frame.expectingKey = false;
      }
    } else if (character === "{" || character === "[") {
      stack.push({
        keys: character === "{" ? new Set<string>() : null,
        expectingKey: character === "{",
      });
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === ",") {
      const frame = stack.at(-1);
      if (frame?.keys) frame.expectingKey = true;
    }
  }
  return value;
}
