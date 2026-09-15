import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateStagedProduct,
  readActiveProduct,
} from "../src/distribution/activation";
import {
  prepareInstallLocation,
  resolveInstallLocation,
} from "../src/distribution/install-location";

test("activation refuses unstaged names, foreign version directories and a held lock without writing", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "activate-home-")));
  try {
    const location = await prepareInstallLocation(
      resolveInstallLocation({
        platform: "linux",
        env: { XDG_DATA_HOME: home },
        homedir: home,
      }),
    );
    const activate = (name: string) =>
      activateStagedProduct({ location, name, executionTarget: "linux-arm64" });
    expect(await readActiveProduct(location)).toBeNull();
    await expect(activate("../x")).rejects.toThrow("Invalid staged version");
    await expect(activate("1.2.3+0123456789abcdef")).rejects.toThrow();
    await expect(
      activateStagedProduct({
        location,
        name: "1.2.3+0123456789abcdef",
        executionTarget: "windows-x64",
      }),
    ).rejects.toThrow("Unqualified");
    const foreign = join(location.versions, "1.2.3+0123456789abcdef");
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, "lazurio"), "not ours", { mode: 0o600 });
    await expect(activate("1.2.3+0123456789abcdef")).rejects.toThrow();
    await rm(foreign, { recursive: true });
    await mkdir(join(location.owner, ".operation-lock"), { mode: 0o700 });
    await expect(activate("1.2.3+0123456789abcdef")).rejects.toThrow();
    await rm(join(location.owner, ".operation-lock"), { recursive: true });
    expect((await readdir(location.base)).sort()).toEqual([
      "distribution",
      "location.json",
      "versions",
    ]);
    // Records and entrypoints that are not this product's fail closed.
    await writeFile(join(location.base, "active.json"), "{}", { mode: 0o600 });
    await expect(readActiveProduct(location)).rejects.toThrow();
    await rm(join(location.base, "active.json"));
    await mkdir(join(location.base, "bin"), { mode: 0o700 });
    await writeFile(join(location.base, "bin", "lazurio"), "x", {
      mode: 0o600,
    });
    await expect(readActiveProduct(location)).rejects.toThrow(
      "not a symbolic link",
    );
    await rm(join(location.base, "bin", "lazurio"));
    await symlink("/nonexistent", join(location.base, "bin", "lazurio"));
    await expect(readActiveProduct(location)).rejects.toThrow(
      "Interrupted activation",
    );
    await rm(join(location.base, "bin", "lazurio"));
    await writeFile(join(location.base, "bin", "note"), "x", { mode: 0o600 });
    await expect(readActiveProduct(location)).rejects.toThrow("Unknown");
    await rm(join(location.base, "bin", "note"));
    await chmod(join(location.base, "bin"), 0o700);
    expect(await readActiveProduct(location)).toBeNull();
  } finally {
    await rm(home, { recursive: true });
  }
});
