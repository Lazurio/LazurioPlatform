import { canonicalDocument, type Slot } from "./catalog-folder";

// The synthetic Organizations of guest Modules (DEV-6694): `HostOrg` hosts
// the Knowledgebase and Mission Control of its home Organization `HomeOrg`
// beside its own, as the shared contract with Lazurio Core declares them.
// Synthetic names and values only.

export const guestKnowledgebase: Slot = {
  path: "workspace/HomeOrg_GEN3/knowledgebase",
  slug: "knowledgebase",
  home_organization: "HomeOrg",
  category: "knowledge",
  default_access: "expected",
  required_roles: ["*"],
  source_of_truth: "git-native",
  teams: ["workspace"],
  status: "active",
  git: { url: "git@github.com:HomeOrg/knowledgebase.git", branch: "main" },
};
export const guestMissionControl: Slot = {
  path: "workspace/HomeOrg_GEN3/mission-control",
  slug: "mission-control",
  home_organization: "HomeOrg",
  category: "planning",
  default_access: "expected",
  required_roles: ["*"],
  source_of_truth: "git-native",
  status: "active",
  git: { url: "git@github.com:HomeOrg/mission-control.git", branch: "main" },
};
export const guestMissionControlData: Slot = {
  path: "workspace/HomeOrg_GEN3/mission-control/db",
  slug: "mission-control-data",
  home_organization: "HomeOrg",
  category: "planning-data",
  default_access: "expected",
  required_roles: ["*"],
  source_of_truth: "repository-db:v3",
  status: "active",
  materialization: "repository_db_mount",
  repository_db: {
    repo: "HomeOrg/mission-control-data",
    url: "git@github.com:HomeOrg/mission-control-data.git",
    branch: "v3",
    config: "repository-db.yaml",
    data_root: "data/mission-control",
    profile: "repository-db-v3",
    app_writable_path_policy: "repository_db_publish_only",
  },
  git: { url: "git@github.com:HomeOrg/mission-control-data.git", branch: "v3" },
};
export const guests = [
  guestKnowledgebase,
  guestMissionControl,
  guestMissionControlData,
];

// The host's own Knowledgebase and Mission Control, with the same slugs.
export const hostSlots: Slot[] = [
  {
    path: "mission-control",
    slug: "mission-control",
    status: "active",
    git: { url: "git@github.com:HostOrg/mission-control.git", branch: "main" },
  },
  {
    path: "mission-control/db",
    slug: "mission-control-data",
    status: "active",
    source_of_truth: "repository-db:v3",
    materialization: "repository_db_mount",
    git: {
      url: "git@github.com:HostOrg/mission-control-data.git",
      branch: "v3",
    },
  },
  {
    path: "workspace/knowledgebase",
    slug: "knowledgebase",
    status: "active",
    git: { url: "git@github.com:HostOrg/knowledgebase.git", branch: "main" },
  },
];

// The canonical and modules documents of the synthetic host, both guests and
// its own slots declared.
export function hostDocuments() {
  const canonical = canonicalDocument("hostorg", "organization", [], "HostOrg");
  const modules = {
    company: "hostorg",
    github_org: "HostOrg",
    module_slots: [...hostSlots, ...guests],
  };
  return { canonical, modules };
}
