import type { FolderProfile } from "./profile";

// Translate the execution process's OS, not a client-provided platform label.
export function executionOs(platform: NodeJS.Platform): FolderProfile["os"] {
  switch (platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      throw new Error("Unsupported execution OS");
  }
}
