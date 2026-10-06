// A child process a test runs to its end, its output read as text. Tests use
// this, never `Bun.spawnSync`: on Bun 1.4.2 a garbage collection inside a
// spawnSync call can leave its private event loop miscounted, and a later
// spawnSync in the same process then misses its child's exit and spins until
// the test times out (oven-sh/bun#34069, fixed after 1.4.2 by
// oven-sh/bun#44581). A `bun test --parallel` worker runs many files in one
// process, so it met this often on the Linux CI runner. Awaiting an
// asynchronous child keeps the test's event loop running and never enters
// that loop. Every caller is bounded by its test's timeout; `timeout` ends the
// child sooner.
export async function runChild(
  cmd: string[],
  options: Readonly<{
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
  }> = {},
) {
  const child = Bun.spawn(cmd, {
    ...options,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}
