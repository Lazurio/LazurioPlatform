import { isAbsolute, join } from "node:path";

/** Per-user install base outside any Lazurio Folder (docs/release-cycle.md):
 * macOS `~/Library/Application Support/Lazurio`, Linux
 * `${XDG_DATA_HOME:-~/.local/share}/lazurio`. Pure resolution; nothing here
 * inspects or creates a path. Other platforms get their own design first.
 */
export function resolveInstallBase(input: {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string | undefined;
}): string | undefined {
  if (!input.homedir || !isAbsolute(input.homedir)) return undefined;
  if (input.platform === "darwin")
    return join(input.homedir, "Library", "Application Support", "Lazurio");
  if (input.platform !== "linux") return undefined;
  // XDG: a relative XDG_DATA_HOME is invalid and must be ignored.
  const xdg = input.env.XDG_DATA_HOME;
  return xdg && isAbsolute(xdg)
    ? join(xdg, "lazurio")
    : join(input.homedir, ".local", "share", "lazurio");
}
