import { artifactTargets } from "./artifact-identity";

export function candidateTarget(
  requested: string | undefined,
  platform: string,
  arch: string,
) {
  const native = `${platform === "win32" ? "windows" : platform}-${arch}`;
  const target = requested ?? native;
  // Only Linux cross-builds are part of this pilot slice. Other native targets
  // retain the previous packaging behavior, not a new qualification claim.
  if (
    !(artifactTargets as readonly string[]).includes(target) ||
    (requested !== undefined &&
      !["linux-arm64", "linux-x64"].includes(requested))
  )
    throw new Error("Unsupported candidate build target");
  return Object.freeze({
    target,
    bunTarget: requested ? `bun-${target}` : null,
    filename: target.startsWith("windows-") ? "lazurio.exe" : "lazurio",
  });
}
