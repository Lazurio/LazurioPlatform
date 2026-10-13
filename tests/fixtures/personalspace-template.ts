import { dirname, join } from "node:path";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./owned-files";

// A Personalspace as `lazurio personalspace install` leaves it today: the
// files of Lazurio/PersonalspaceTemplate_GEN3 (public) at `main` cf50036,
// byte for byte, with the template's placeholders (`owner-github-username`,
// Lazurio/LazurioPlatform#377) and its example slot `workspace/personal-notes`,
// which declares no repository.

/** `modules.manifest.json` of the template. */
export const personalspaceTemplateManifest = `{
  "personal_generation": "gen3",
  "owner": "owner-github-username",
  "module_slots": [
    {
      "path": "workspace/personal-notes",
      "category": "knowledge",
      "default_access": "private",
      "required_roles": [
        "owner"
      ],
      "source_of_truth": "git-native",
      "notes": "Example personal module slot; replace or remove when creating real private nested modules."
    }
  ]
}
`;

/** The template's slots, as a reader parses them. */
export const personalspaceTemplateSlots: readonly unknown[] = Object.freeze(
  JSON.parse(personalspaceTemplateManifest).module_slots,
);

/** `.gitignore` of the template: `workspace/*` is ignored, `.worktrees/` is
 * not. */
export const personalspaceTemplateGitignore = `# OS junk
.DS_Store
Thumbs.db
desktop.ini

# Local env and secrets
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx
secrets/
secrets/**

# Runtime and generated state
node_modules/
**/node_modules/
.cache/
dist/
build/
out/
coverage/
*.log
logs/

# Python/local tooling caches
__pycache__/
**/__pycache__/
*.pyc
.venv/
.pytest_cache/
.mypy_cache/
.ruff_cache/

# Samostatné private gbrain data repo se mountuje jako nested checkout.
# Super-repo ho nikdy netrackuje jako gitlink ani běžný adresář.
gbrain/

# Volitelný private Buddy profile je také nested checkout. CAC-0071 jej
# nevytváří, ale existující hosted instance ho nesmí omylem trackovat.
buddy/

# Soukromé osobní moduly jsou Doctor-managed nested checkouty.
workspace/*
!workspace/.gitkeep

# Editor state
.idea/
.cursor/
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json
`;

/** `personal.gen3.json` of the template, every identity a placeholder. */
export const personalspaceTemplatePersonal = `{
  "$schema": "https://rozjedeme.ai/schemas/personal.gen3.schema.json",
  "schema_version": "humanandmachines.personal.gen3.v1",
  "personal_generation": "gen3",
  "owner": {
    "github_username": "owner-github-username",
    "display_name": "Owner Display Name",
    "type": "human"
  },
  "repository": {
    "github_repo": "owner-github-username/owner-github-username_GEN3",
    "mount_path": "personalspace/owner-github-username_GEN3",
    "visibility": "private",
    "mount_strategy": "doctor-managed-nested-repo"
  },
  "privacy": {
    "default_share": "private",
    "agent_boundary": "personal-context-only",
    "shared_outputs": "metadata-only"
  },
  "doctor": {
    "schema_version": "humanandmachines.doctor.declaration.v1",
    "command": ["bun", "scripts/doctor-personalspace.mjs", "--json"],
    "timeout_ms": 120000,
    "scope_type": "personalspace"
  },
  "modules_manifest_path": "modules.manifest.json",
  "workspace_path": "workspace",
  "gbrain": {
    "path": "gbrain",
    "repository": {
      "github_repo": "owner-github-username/owner-github-username-gbrain",
      "visibility": "private",
      "mount_strategy": "doctor-managed-nested-repo"
    },
    "software": {
      "github_repo": "garrytan/gbrain",
      "install_source": "github:garrytan/gbrain"
    },
    "default_shared": false,
    "human_editor": "obsidian",
    "agent_access": "mcp-only"
  },
  "secrets": {
    "path": "secrets",
    "custody_pattern": "personalspace/<owner>_GEN3/secrets/<provider>/<scope>/<purpose>",
    "git": "ignored"
  },
  "shared_spaces": []
}
`;

/** The template's tracked files this fixture writes, by path; another value
 * replaces one, `null` leaves it out. */
export type PersonalspaceFiles = Readonly<Record<string, string | null>>;

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", HOME: cwd },
    },
  );
  const [error, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${error}`);
}

/** A Personalspace as the install leaves it: a checkout at `directory` of
 * `fullName` (its `origin` on github.com) whose `main` holds the template's
 * files with their placeholders, committed. */
export async function writePersonalspaceCheckout(
  directory: string,
  fullName: string,
  files: PersonalspaceFiles = {},
) {
  const all: Record<string, string | null> = {
    ".gitignore": personalspaceTemplateGitignore,
    "modules.manifest.json": personalspaceTemplateManifest,
    "personal.gen3.json": personalspaceTemplatePersonal,
    "workspace/.gitkeep": "",
    ...files,
  };
  await mkdir(directory, { recursive: true });
  for (const [path, content] of Object.entries(all)) {
    if (content === null) continue;
    await mkdir(join(directory, dirname(path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await git(directory, "init", "--quiet");
  await git(
    directory,
    "remote",
    "add",
    "origin",
    `git@github.com:${fullName}.git`,
  );
  await git(directory, "add", "--all");
  await git(directory, "commit", "--quiet", "-m", "Personalspace");
}

/** A task worktree of the Personalspace at `directory` on a new branch. */
export async function addTaskWorktree(
  space: string,
  directory: string,
  branch: string,
) {
  await git(space, "worktree", "add", "--quiet", "-b", branch, directory);
}
