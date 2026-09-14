import { mkdir, writeFile } from "node:fs/promises";

// Positive fixtures model owner-controlled input. Specify creation permissions
// instead of borrowing the host's umask; never chmod an existing test target.
// Negative permission tests can still pass a mode or explicitly chmod their file.
export const writeOwnedFixture: typeof writeFile = (file, data, options) =>
  writeFile(file, data, {
    mode: 0o600,
    ...(typeof options === "string" ? { encoding: options } : options),
  });

export function mkdirOwnedFixture(
  path: Parameters<typeof mkdir>[0],
  options: { recursive?: boolean; mode?: number } = {},
) {
  return mkdir(path, { mode: 0o700, ...options });
}
