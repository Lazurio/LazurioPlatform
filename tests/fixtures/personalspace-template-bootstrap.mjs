// The fixture's `bun run bootstrap` of Lazurio/PersonalspaceTemplate_GEN3
// (see `writeTemplate` in content-world.ts): it does to the files the
// install commits what the template's own bootstrap does, and nothing else.
// It names the owner in both declarations, creates the private gbrain
// repository among the world's remotes when it is missing (as
// `gh repo create --add-readme` would) and clones it into `gbrain/` with a
// `.gitignore`. `FIXTURE_FAILS` is replaced by the fixture: true fails after
// writing, as the template's bootstrap does when its doctor refuses.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fails = FIXTURE_FAILS;
const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const login = value("--login");
const displayName = value("--display-name");
if (!args.includes("--apply") || !login || !displayName) {
  console.error("Bootstrap selhal: --login, --display-name a --apply jsou povinné.");
  process.exit(1);
}
const git = (cwd, ...rest) =>
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...rest], {
    cwd,
    stdio: "pipe",
  });
const gbrainRepo = `${login}/${login}-gbrain`;
const personal = JSON.parse(readFileSync("personal.gen3.json", "utf8"));
personal.owner = { github_username: login, display_name: displayName, type: "human" };
personal.gbrain = { path: "gbrain", repository: { github_repo: gbrainRepo, visibility: "private" } };
writeFileSync("personal.gen3.json", `${JSON.stringify(personal, null, 2)}\n`);
const manifest = JSON.parse(readFileSync("modules.manifest.json", "utf8"));
manifest.owner = login;
writeFileSync("modules.manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
// The remotes behind git@github.com: (the world's insteadOf, GIT_CONFIG_KEY_0).
const remotes = process.env.GIT_CONFIG_KEY_0.slice("url.".length, -"/.insteadOf".length);
const bare = join(remotes, login, `${login}-gbrain.git`);
if (!existsSync(bare)) {
  git(remotes, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  const work = mkdtempSync(join(tmpdir(), "gbrain-"));
  git(work, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(work, "README.md"), "gbrain\n");
  git(work, "add", "README.md");
  git(work, "commit", "--quiet", "-m", "init");
  git(work, "push", "--quiet", bare, "HEAD:refs/heads/main");
  rmSync(work, { recursive: true, force: true });
}
if (!existsSync("gbrain")) git(".", "clone", "--quiet", `git@github.com:${gbrainRepo}.git`, "gbrain");
writeFileSync(join("gbrain", ".gitignore"), ".gbrain/\n.env\n");
if (fails) {
  console.error(
    "Bootstrap selhal: Doctor nepozoroval kontroly, jejichž odložení si nikdo nevyžádal: personalspace.collaborators.",
  );
  process.exit(1);
}
console.log("Bootstrap dokončen.");
