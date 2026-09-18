import { expect, test } from "bun:test";
import {
  parseOperatorRecord,
  readLinuxOperator,
} from "../src/machine/operator";

test("operator binds exact effective UID to one system record", () => {
  expect(
    parseOperatorRecord(
      "operator:x:1000:1000::/home/operator:/bin/bash\n",
      1000,
    ),
  ).toEqual({
    platform: "linux",
    uid: 1000,
    username: "operator",
    homedir: "/home/operator",
  });
  for (const record of [
    "",
    "operator:x:1001:1000::/home/operator:/bin/bash",
    "operator:x:01000:1000::/home/operator:/bin/bash",
    "operator:x:1000:1000::/tmp/operator:/bin/bash",
    "operator:x:1000:1000::/home/operator:/bin/bash\nother:x:1000:1000::/home/other:/bin/bash",
    "operator:x:1000:1000::/home/operator:/bin/bash:extra",
  ])
    expect(() => parseOperatorRecord(record, 1000)).toThrow(
      "machine-operator-unavailable",
    );
  expect(() =>
    parseOperatorRecord("root:x:0:0::/home/root:/bin/bash", 0),
  ).toThrow();
});
test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "native Linux operator lookup is independent of environment names",
  async () => {
    const original = {
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
    };
    const expected = await readLinuxOperator();
    try {
      process.env.HOME = "/home/foreign";
      process.env.USER = "foreign";
      process.env.LOGNAME = "foreign";
      expect(await readLinuxOperator()).toEqual(expected);
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
