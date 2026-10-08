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

// `/.lazurio/offline-sw.js` (DEV-6651) without its prelude: the offline
// guide's service worker as one classic script (IIFE, no imports at run
// time), built the same way when this module is bundled. The Launchpad puts
// `offlineWorkerPrelude` in front of it, so the version and the guide page's
// digest are part of the worker's bytes.
export function offlineWorkerScript(): string {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      `${import.meta.dir}/offline-worker.ts`,
      "--target=browser",
      "--format=iife",
      "--minify",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  if (!result.success)
    throw new Error(`The offline worker did not build: ${result.stderr}`);
  return result.stdout.toString();
}
