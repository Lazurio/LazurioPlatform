import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const cli = process.argv[2];
assert.ok(cli && isAbsolute(cli));
const root = realpathSync(mkdtempSync(join(tmpdir(), "conversion-native-")));
const legacy = {
  organization_generation: "gen3",
  organization_kind: "organization",
  company: { slug: "fixture", display_name: "Fixture", github_org: "Fixture" },
  modules: [],
};
const modules = { company: "fixture", github_org: "Fixture", module_slots: [] };
const source = join(root, "company.gen3.json");
const inventory = join(root, "modules.manifest.json");
try {
  writeFileSync(source, JSON.stringify(legacy), { mode: 0o600 });
  writeFileSync(inventory, JSON.stringify(modules), { mode: 0o600 });
  const run = () =>
    spawnSync(cli, ["organization-conversion-preview", "--directory", root], {
      env: {},
      encoding: "utf8",
    });
  const ready = run();
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).kind, "conversion-draft");
  assert.equal(readFileSync(source, "utf8"), JSON.stringify(legacy));
  const conflict = JSON.stringify({
    ...legacy,
    modules: [{ path: "workspace/private-marker", note: "private-value" }],
  });
  writeFileSync(source, conflict);
  const refused = run();
  assert.equal(refused.status, 2);
  assert.equal(refused.stderr, "");
  assert.deepEqual(JSON.parse(refused.stdout), {
    kind: "blocked",
    reason: "declaration-reconciliation-required",
    sections: ["modules"],
  });
  assert.equal(readFileSync(source, "utf8"), conflict);
  assert.equal(readFileSync(inventory, "utf8"), JSON.stringify(modules));
  assert.deepEqual(readdirSync(root).sort(), [
    "company.gen3.json",
    "modules.manifest.json",
  ]);
  console.log(
    "PASS: native standalone conversion success and conflict refusal; exact input preservation; no canonical output created",
  );
  console.log(execFileSync("uname", ["-sm"], { encoding: "utf8" }).trim());
} finally {
  rmSync(root, { recursive: true });
}
