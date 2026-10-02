import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderManual } from "../src/folder/manual";
import { outputPaths } from "../src/folder/outputs";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { journeys } from "./folder-render.test";

// The generated "Current checkouts" procedure (decision F17 addendum
// 2026-10-02) must never lose work. Review found the collision that made an
// earlier wording unsafe: a stash of the outer checkout skips an untracked
// nested repository, and `git reset --hard` then overwrites its files when the
// remote branch adds the same paths. This test runs the procedure the manual
// prescribes against exactly that collision with the real git.
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Lazurio Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

test("the prescribed alignment refuses to overwrite an untracked nested repository the stash skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazurio-checkout-"));
  try {
    const origin = join(root, "origin.git");
    const primary = join(root, "primary");
    const other = join(root, "other");
    expect(git(root, "init", "--bare", origin).exitCode).toBe(0);
    expect(git(root, "clone", origin, primary).exitCode).toBe(0);
    await writeFile(join(primary, "README.md"), "base\n");
    expect(git(primary, "add", "README.md").exitCode).toBe(0);
    expect(git(primary, "commit", "-m", "base").exitCode).toBe(0);
    expect(git(primary, "push", "origin", "HEAD:main").exitCode).toBe(0);

    // Someone else adds `foreign/private` on the remote default branch.
    expect(git(root, "clone", origin, other).exitCode).toBe(0);
    expect(git(other, "checkout", "-B", "main", "origin/main").exitCode).toBe(
      0,
    );
    await Bun.write(join(other, "foreign", "private"), "remote\n");
    expect(git(other, "add", "foreign/private").exitCode).toBe(0);
    expect(git(other, "commit", "-m", "remote adds foreign").exitCode).toBe(0);
    expect(git(other, "push", "origin", "HEAD:main").exitCode).toBe(0);

    // The primary checkout diverged: a local commit on main and an untracked
    // nested repository with an uncommitted change at the same path.
    expect(git(primary, "checkout", "-B", "main").exitCode).toBe(0);
    await writeFile(join(primary, "local.txt"), "local commit\n");
    expect(git(primary, "add", "local.txt").exitCode).toBe(0);
    expect(git(primary, "commit", "-m", "local only").exitCode).toBe(0);
    const nested = join(primary, "foreign");
    expect(git(primary, "init", nested).exitCode).toBe(0);
    await writeFile(join(nested, "private"), "uncommitted local work\n");

    // The procedure: keep the commits on a branch of their own, stash, then
    // align with `git checkout -B`, after comparing the changed paths with
    // the untracked and ignored entries.
    expect(git(primary, "branch", "rescue/local-only", "HEAD").exitCode).toBe(
      0,
    );
    const stash = git(
      primary,
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "lazurio update test",
    );
    // The outer stash skips the nested repository: its work is still only
    // on disk, which is why the manual saves it in itself first.
    expect(stash.stderr.toString() + stash.stdout.toString()).toContain(
      "foreign",
    );
    expect(await readFile(join(nested, "private"), "utf8")).toBe(
      "uncommitted local work\n",
    );
    expect(git(primary, "fetch", "origin").exitCode).toBe(0);
    const changed = git(primary, "diff", "--name-only", "HEAD", "origin/main")
      .stdout.toString()
      .split("\n")
      .filter(Boolean);
    const present = git(primary, "status", "--porcelain", "--ignored")
      .stdout.toString()
      .split("\n")
      .filter((line) => line.startsWith("?? ") || line.startsWith("!! "))
      .map((line) => line.slice(3));
    // The inspection the manual prescribes finds the overlap and stops.
    expect(
      changed.some((path) =>
        present.some(
          (entry) =>
            path === entry || (entry.endsWith("/") && path.startsWith(entry)),
        ),
      ),
    ).toBe(true);
    // Even without the inspection, the prescribed command refuses.
    const align = git(primary, "checkout", "-B", "main", "origin/main");
    expect(align.exitCode).not.toBe(0);
    expect(await readFile(join(nested, "private"), "utf8")).toBe(
      "uncommitted local work\n",
    );
    // The local commit is kept on its branch.
    expect(
      git(primary, "cat-file", "-e", "rescue/local-only:local.txt").exitCode,
    ).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// No generated output may prescribe `git reset --hard`; the procedure names
// the nested repository and the fail-closed alignment on every preset that
// carries Organizations.
test("the generated checkout procedure never prescribes reset --hard", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      for (const path of outputPaths)
        expect(outputs[path]).not.toMatch(/reset --hard origin/);
      const troubleshooting = renderManual({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      })["manual/troubleshooting.md"];
      const withOrganizations = journey.preset !== "hosted-personal";
      for (const fragment of [
        "`git checkout -B <branch> origin/<branch>`",
        "`git status --porcelain --ignored`",
        locale === "cs"
          ? "Vnořený repozitář (podsložka s vlastním `.git`) stash nadřazeného checkoutu přeskočí."
          : "A stash of the outer checkout skips a nested repository",
      ])
        expect(troubleshooting.includes(fragment)).toBe(withOrganizations);
    }
});

// One rule for a nested repository (review of #119): the worktree rule names
// the hazard and points to the checkout procedure, the procedure saves the
// work or stops without aligning, and no text still declares the case
// unsolvable. A personal Remote Environment has no checkout procedure, so it
// leaves the repository alone and tells the Operator.
test("the worktree rule and the checkout procedure give one fail-closed rule for a nested repository", () => {
  for (const journey of journeys)
    for (const locale of ["cs", "en"] as const) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      for (const path of outputPaths)
        expect(outputs[path]).not.toMatch(
          /nejde bezpečně odložit|cannot be set aside safely|zablokuje `lazurio update`|blocks `lazurio update`/,
        );
      const workingHere = outputs["manual/working-here.md"];
      const troubleshooting = outputs["manual/troubleshooting.md"];
      const withOrganizations = journey.preset !== "hosted-personal";
      expect(workingHere).toContain(
        locale === "cs"
          ? "stash nadřazeného checkoutu takový vnořený repozitář přeskočí"
          : "a stash of the outer checkout skips such a nested repository",
      );
      expect(
        workingHere.includes(
          locale === "cs"
            ? "řeš podle oddílu o aktuálních checkoutech v `manual/troubleshooting.md`"
            : "as the section on current checkouts in `manual/troubleshooting.md` describes",
        ),
      ).toBe(withOrganizations);
      expect(
        workingHere.includes(
          locale === "cs"
            ? "Vnořený repozitář, který už tu leží, nech být a řekni o něm Operátorovi."
            : "Leave a nested repository you find here alone and tell the Operator about it.",
        ),
      ).toBe(!withOrganizations);
      expect(
        troubleshooting.includes(
          locale === "cs"
            ? "Když kterýkoli z těchto kroků nejde dokončit (vnořený repozitář nemá remote, GitHub push odmítne, chybí právo nebo přesun selže), checkout nesrovnávej."
            : "When any of these steps cannot be completed (the nested repository has no remote, GitHub refuses the push, a right is missing or the move fails), do not align the checkout.",
        ),
      ).toBe(withOrganizations);
    }
});
