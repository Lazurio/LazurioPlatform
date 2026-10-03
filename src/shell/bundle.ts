// `/.lazurio/shell.js` as one ES module, built from `src/shell/index.ts` by
// the same Bun when this module is bundled: a macro (imported with
// `{ type: "macro" }`), so the compiled executable carries the script as a
// string, as it carries the page's own assets, and a source run builds it on
// load. Never called at run time of a compiled executable.
export function shellScript(): string {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      `${import.meta.dir}/index.ts`,
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
    throw new Error(`The shell script did not build: ${result.stderr}`);
  return result.stdout.toString();
}
