import { test } from "bun:test";

// A test of a proposed decision's contract that is red by design
// (docs/connected-apps.md, section 15): it asserts behaviour that does not
// exist yet. `test.failing` passes while the test fails, so `bun run check`
// stays green, and fails once the test passes, so the slice that implements
// the behaviour has to replace `contract` with `test`. Run with
// `LAZURIO_CONTRACT=show` to see why each one fails. The fake tools are POSIX
// shell wrappers, so Windows skips them.
export const contract =
  process.platform === "win32"
    ? test.skip
    : process.env.LAZURIO_CONTRACT === "show"
      ? test
      : test.failing;
