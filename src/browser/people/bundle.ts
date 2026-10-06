// `/assets/view.js`, the script of the people's view (decision F39), as one
// ES module built from `client.ts` by the same Bun when this module is
// bundled: a macro (imported with `{ type: "macro" }`), so the compiled
// executable carries the script as a string, as it carries the shell's
// (`src/shell/bundle.ts`), and a source run builds it on load. Never called
// at run time of a compiled executable.
export function viewScript(): string {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      `${import.meta.dir}/client.ts`,
      "--target=browser",
      "--format=esm",
      "--minify",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  if (!result.success)
    throw new Error(`The view script did not build: ${result.stderr}`);
  return result.stdout.toString();
}
