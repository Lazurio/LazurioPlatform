import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignedEnvironments,
  type MachineBinding,
} from "../src/folder/machine-binding";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { withEnvironmentSsh } from "../src/machine/cli";
import {
  includeLine,
  managedHeader,
  renderEnvironmentsConfig,
  renderEnvironmentsKnownHosts,
  writeEnvironmentSsh,
} from "../src/ssh-access/environments";
import { journeys } from "./fixtures/journeys";
import { binding, bindings } from "./fixtures/machine-bindings";
import handover from "./fixtures/machine-context-personal-assigned.json";

// SSH from the Osobní Prostředí into the Work Environments assigned to its
// owner (root decision 0192, addendum of 2026-10-26; plan DEV-6676 P2): from
// the binding the Folder records, `lazurio machine folder-init` and
// `folder-refresh` write the person's SSH config for its assigned peers, and
// the personal Folder's AGENTS.md lists the same aliases. The fixture is the
// reference Organization's Bob with a synthetic host key.

const uid = process.getuid?.();
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function home() {
  const path = await mkdtemp(join(tmpdir(), "lazurio-environment-ssh-"));
  homes.push(path);
  return path;
}
const write = (
  path: string,
  machine: MachineBinding = bindings.personalAssigned,
) => writeEnvironmentSsh({ home: path, uid }, machine);
const paths = (path: string) => ({
  ssh: join(path, ".ssh"),
  configDirectory: join(path, ".ssh", "config.d"),
  conf: join(path, ".ssh", "config.d", "lazurio-environments.conf"),
  knownHosts: join(path, ".ssh", "known_hosts_lazurio_environments"),
  config: join(path, ".ssh", "config"),
});
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const environment = "lazurio-bob.lazurioexampleorganization";
const hostKey =
  "AAAAC3NzaC1lZDI1NTE5AAAAIOosFYFA3vTPDE3z8629wlmF0Qecl1enPwpEjCjOsnfj";
const goldenConfig = `${managedHeader}

Host lazurio-bob.lazurioexampleorganization
  HostName lazurioexampleorganization-lazurio-bob-vm.tailnet.lazurioexampleorganization.lazurio.io
  User lazurio-bob
  HostKeyAlias lazurio-bob.lazurioexampleorganization
  UserKnownHostsFile ~/.ssh/known_hosts_lazurio_environments
  StrictHostKeyChecking yes
  IdentityFile ~/.ssh/lazurio-environment-ed25519
  IdentitiesOnly yes
  ForwardAgent no
`;
const goldenKnownHosts = `${managedHeader}
lazurio-bob.lazurioexampleorganization ssh-ed25519 ${hostKey}
`;

type Json = Record<string, unknown>;
const [laptop, assigned] = handover.relationships.peers as unknown as [
  Json,
  Json,
];
const link = assigned.ssh as Json;
const without = (value: Json, ...keys: string[]) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
// The same work VM as Machines writes it to a Platform below the gate.
const unassigned = {
  ...without(assigned, "environment", "access"),
  ssh: without(link, "host_keys"),
};
// A second assigned Work Environment with two host keys, in another
// Organization; the same Environment id twice keeps the first.
const otherKey =
  "AAAAC3NzaC1lZDI1NTE5AAAAIIFygZVmr1cFYx//JrQ0yWhRLdAwCbc1XS4H6ktOFDTx";
const twoOrganizations = binding({
  ...handover,
  relationships: {
    zone: "personal",
    peers: [
      laptop,
      assigned,
      {
        ...assigned,
        name: "example-lazurio-bob-vm",
        organization: "example",
        environment: "lazurio-bob.example",
        ssh: {
          ...link,
          host: "example-lazurio-bob-vm.tailnet.example.invalid",
          host_keys: [
            { type: "ssh-ed25519", key: otherKey },
            { type: "ssh-ed25519", key: hostKey },
          ],
        },
      },
      { ...assigned, name: "lazurio-bob-copy" },
    ],
  },
});

test("the config and the known hosts are these bytes: a block per assigned Environment, pinned to its host keys, with the Environment's one key and no agent", () => {
  const environments = assignedEnvironments(bindings.personalAssigned);
  expect(environments.map((entry) => entry.environment)).toEqual([environment]);
  expect(renderEnvironmentsConfig(environments)).toBe(goldenConfig);
  expect(renderEnvironmentsKnownHosts(environments)).toBe(goldenKnownHosts);
  const two = assignedEnvironments(twoOrganizations);
  expect(two.map((entry) => entry.environment)).toEqual([
    environment,
    "lazurio-bob.example",
  ]);
  expect(renderEnvironmentsKnownHosts(two)).toBe(
    `${managedHeader}\n${environment} ssh-ed25519 ${hostKey}\nlazurio-bob.example ssh-ed25519 ${otherKey}\nlazurio-bob.example ssh-ed25519 ${hostKey}\n`,
  );
  expect(renderEnvironmentsConfig(two).match(/^Host /gm)).toHaveLength(2);
  // Nothing without the members, and nothing on any other Machine.
  expect(assignedEnvironments(bindings.personalRelated)).toEqual([]);
  expect(assignedEnvironments(bindings.personal)).toEqual([]);
  expect(assignedEnvironments(bindings.organization)).toEqual([]);
  expect(assignedEnvironments(null)).toEqual([]);
});

test("a first run creates the three files with their modes, and a second run changes nothing", async () => {
  const path = await home();
  const at = paths(path);
  expect(await write(path)).toEqual({
    kind: "written",
    environments: [environment],
  });
  expect(await readFile(at.conf, "utf8")).toBe(goldenConfig);
  expect(await readFile(at.knownHosts, "utf8")).toBe(goldenKnownHosts);
  expect(await readFile(at.config, "utf8")).toBe(`${includeLine}\n`);
  expect(await mode(at.ssh)).toBe(0o700);
  expect(await mode(at.configDirectory)).toBe(0o700);
  expect(await mode(at.conf)).toBe(0o600);
  expect(await mode(at.knownHosts)).toBe(0o644);
  expect(await mode(at.config)).toBe(0o600);
  const before = await Promise.all(
    [at.conf, at.knownHosts, at.config].map(async (file) => {
      const info = await stat(file);
      return [info.ino, info.mtimeMs, await readFile(file, "utf8")];
    }),
  );
  expect(await write(path)).toEqual({
    kind: "unchanged",
    environments: [environment],
  });
  const after = await Promise.all(
    [at.conf, at.knownHosts, at.config].map(async (file) => {
      const info = await stat(file);
      return [info.ino, info.mtimeMs, await readFile(file, "utf8")];
    }),
  );
  expect(after).toEqual(before);
  // A file of the Platform's with other bytes or another mode is rewritten.
  await writeFile(at.conf, `${managedHeader}\nHost edited\n`);
  await chmod(at.knownHosts, 0o600);
  expect((await write(path)).kind).toBe("written");
  expect(await readFile(at.conf, "utf8")).toBe(goldenConfig);
  expect(await mode(at.knownHosts)).toBe(0o644);
});

test("the Include line goes on top of the person's config once, before every Host and Match block, keeping each of their bytes and the file's mode", async () => {
  const path = await home();
  const at = paths(path);
  await mkdir(at.ssh, { mode: 0o700 });
  // Comments, a Host and a Match block, a CRLF line, an Include of the
  // person's own inside a block and no newline at the end.
  const own = Buffer.from(
    `# my settings\r\nHost *\n  ServerAliveInterval 30\n  ${includeLine}\nMatch host example\n  User someone`,
    "utf8",
  );
  await writeFile(at.config, own, { mode: 0o644 });
  await chmod(at.config, 0o644);
  expect((await write(path)).kind).toBe("written");
  const written = await readFile(at.config);
  expect(
    written.equals(Buffer.concat([Buffer.from(`${includeLine}\n`), own])),
  ).toBe(true);
  expect(await mode(at.config)).toBe(0o644);
  expect(await write(path)).toEqual({
    kind: "unchanged",
    environments: [environment],
  });
  expect((await readFile(at.config)).equals(written)).toBe(true);
  // Already on top, among the person's global lines: left alone.
  const other = await home();
  const there = paths(other);
  await mkdir(there.ssh, { mode: 0o700 });
  const global = Buffer.from(
    `# mine\nAddKeysToAgent yes\n${includeLine}\nHost *\n  User me\n`,
  );
  await writeFile(there.config, global, { mode: 0o600 });
  expect((await write(other)).kind).toBe("written");
  expect((await readFile(there.config)).equals(global)).toBe(true);
});

test("a file at the Platform's paths that it did not write is refused by path, and nothing is changed", async () => {
  for (const which of ["conf", "knownHosts"] as const) {
    const path = await home();
    const at = paths(path);
    await mkdir(at.configDirectory, { recursive: true, mode: 0o700 });
    const own = "Host mine\n  User me\n";
    await writeFile(at[which], own);
    await writeFile(at.config, "Host *\n  User me\n");
    expect(await write(path)).toEqual({
      kind: "blocked",
      reason: "file-foreign",
      path:
        which === "conf"
          ? "~/.ssh/config.d/lazurio-environments.conf"
          : "~/.ssh/known_hosts_lazurio_environments",
    });
    expect(await readFile(at[which], "utf8")).toBe(own);
    expect(await exists(which === "conf" ? at.knownHosts : at.conf)).toBe(
      false,
    );
    expect(await readFile(at.config, "utf8")).toBe("Host *\n  User me\n");
    // Nor is it removed when there are no peers.
    expect((await write(path, bindings.personalRelated)).kind).toBe("blocked");
    expect(await readFile(at[which], "utf8")).toBe(own);
  }
});

test("a symlinked ~/.ssh, ~/.ssh/config.d, file or person's config is refused, and nothing behind it is touched", async () => {
  const cases = [
    { at: "ssh", reason: "ssh-directory-unsafe", shown: "~/.ssh" },
    {
      at: "configDirectory",
      reason: "ssh-directory-unsafe",
      shown: "~/.ssh/config.d",
    },
    {
      at: "conf",
      reason: "file-unsafe",
      shown: "~/.ssh/config.d/lazurio-environments.conf",
    },
    {
      at: "knownHosts",
      reason: "file-unsafe",
      shown: "~/.ssh/known_hosts_lazurio_environments",
    },
    { at: "config", reason: "file-unsafe", shown: "~/.ssh/config" },
  ] as const;
  for (const { at: which, reason, shown } of cases) {
    const path = await home();
    const at = paths(path);
    const elsewhere = join(path, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    if (which !== "ssh") await mkdir(at.ssh, { mode: 0o700 });
    if (which === "conf") await mkdir(at.configDirectory, { mode: 0o700 });
    const target =
      which === "ssh" || which === "configDirectory"
        ? elsewhere
        : join(elsewhere, "file");
    if (target !== elsewhere) await writeFile(target, `${managedHeader}\n`);
    await symlink(target, at[which]);
    expect(await write(path)).toEqual({ kind: "blocked", reason, path: shown });
    expect((await lstat(at[which])).isSymbolicLink()).toBe(true);
    if (target === elsewhere)
      expect(await exists(join(elsewhere, "config.d"))).toBe(false);
    else expect(await readFile(target, "utf8")).toBe(`${managedHeader}\n`);
  }
});

test("without assigned peers the Platform's two files go, the Include line and the person's config stay, and nothing is created", async () => {
  const path = await home();
  const at = paths(path);
  await mkdir(at.ssh, { mode: 0o700 });
  await writeFile(at.config, "Host *\n  User me\n");
  expect((await write(path)).kind).toBe("written");
  expect(await write(path, bindings.personalRelated)).toEqual({
    kind: "removed",
  });
  expect(await exists(at.conf)).toBe(false);
  expect(await exists(at.knownHosts)).toBe(false);
  expect(await readFile(at.config, "utf8")).toBe(
    `${includeLine}\nHost *\n  User me\n`,
  );
  expect(await write(path, bindings.personalRelated)).toEqual({ kind: "none" });
  // A home without ~/.ssh gets none, below Machines' gate as on any other
  // Machine.
  const empty = await home();
  for (const machine of [
    bindings.personalRelated,
    bindings.personal,
    bindings.organization,
  ])
    expect(await write(empty, machine)).toEqual({ kind: "none" });
  expect(await exists(join(empty, ".ssh"))).toBe(false);
});

test("the machine commands add the outcome only when the Folder records this binding (initialized, refreshed, unchanged) on a personal Machine, and keep the answer otherwise", async () => {
  const path = await home();
  const location = { home: path, uid };
  // A blocked operation, an adopted Folder that may still record an older
  // handover, and any other Machine: the answer as it was, nothing written.
  const blocked = { kind: "blocked", reason: "drift", path: "AGENTS.md" };
  const adopted = { kind: "already-adopted", revision: 3 };
  const refreshed = { kind: "refreshed", revision: 7 };
  for (const [answer, machine] of [
    [blocked, bindings.personalAssigned],
    [adopted, bindings.personalAssigned],
    [refreshed, bindings.organization],
  ] as const)
    expect<unknown>(await withEnvironmentSsh(answer, machine, location)).toBe(
      answer,
    );
  expect(await exists(join(path, ".ssh"))).toBe(false);
  expect<unknown>(
    await withEnvironmentSsh(
      { kind: "initialized", revision: 1 },
      bindings.personalAssigned,
      location,
    ),
  ).toEqual({
    kind: "initialized",
    revision: 1,
    environmentSsh: { kind: "written", environments: [environment] },
  });
  expect<unknown>(
    await withEnvironmentSsh(refreshed, bindings.personalAssigned, location),
  ).toEqual({
    kind: "refreshed",
    revision: 7,
    environmentSsh: { kind: "unchanged", environments: [environment] },
  });
  expect<unknown>(
    await withEnvironmentSsh(
      { kind: "unchanged" },
      bindings.personalRelated,
      location,
    ),
  ).toEqual({ kind: "unchanged", environmentSsh: { kind: "removed" } });
  // A refusal keeps the answer's kind and says why; the removal above left
  // ~/.ssh/config.d in place.
  await writeFile(paths(path).conf, "Host mine\n");
  expect<unknown>(
    await withEnvironmentSsh(
      { kind: "unchanged" },
      bindings.personalAssigned,
      location,
    ),
  ).toEqual({
    kind: "unchanged",
    environmentSsh: {
      kind: "blocked",
      reason: "file-foreign",
      path: "~/.ssh/config.d/lazurio-environments.conf",
    },
  });
});

test("only the personal Folder lists the aliases: AGENTS.md in „Z tohoto Osobního Prostředí“ and the manual's exception to confirming a peer, only with assigned peers", () => {
  const heading = {
    cs: "## Z tohoto Osobního Prostředí",
    en: "## From this Personal Environment",
  };
  const exception = {
    cs: "- Dosažitelnost rozhoduje Headscale a není to identita ani mandát. Pracovní Prostředí přidělená uživateli uvádí `AGENTS.md` (Z tohoto Osobního Prostředí) a jejich přidělení zaznamenal handover. U ostatních peerů handover nezaznamenává, čí jsou: než na nich začneš pracovat nebo ovládat zařízení, potvrď s uživatelem, že jsou jeho nebo že jsou přiřazené jemu.",
    en: "- Reachability is decided by Headscale and is neither identity nor mandate. `AGENTS.md` lists the Work Environments assigned to the user (From this Personal Environment), and the handover records their assignment. For any other peer the handover does not record whose it is: before you work on one or operate a device, confirm with the user that it is theirs or assigned to them.",
  };
  const general = {
    cs: "- Dosažitelnost rozhoduje Headscale a není to identita ani mandát: handover nezaznamenává, čí peer je. Než na peeru začneš pracovat nebo ovládat zařízení, potvrď s uživatelem, že je jeho nebo že je přiřazený jemu.",
    en: "- Reachability is decided by Headscale and is neither identity nor mandate: the handover does not record whose a peer is. Before you work on a peer or operate a device, confirm with the user that it is theirs or assigned to them.",
  };
  // Organization work in AGENTS.md's Boundaries and in the manual: with
  // assigned peers, those need no confirmation and any other still does.
  const boundary = {
    plain: {
      cs: "- Organizace: na osobním Remote Environmentu nejsou namountovaná žádná repa Organizací. Práce v Organizaci (kód, repozitáře, běhy) probíhá přes SSH na pracovním Remote Environmentu, který ti uživatel potvrdí jako přiřazený jemu; repozitáře Organizací sem nikdy neklonuj.",
      en: "- Organizations: no Organization repositories are mounted in a personal Remote Environment. Organization work (code, repositories, runs) happens over SSH in a work Remote Environment the user confirms is assigned to them; never clone Organization repositories here.",
    },
    assigned: {
      cs: "- Organizace: na osobním Remote Environmentu nejsou namountovaná žádná repa Organizací. Práce v Organizaci (kód, repozitáře, běhy) probíhá přes SSH na pracovním Remote Environmentu přiděleném uživateli. Ta z oddílu „Z tohoto Osobního Prostředí“ jsou přidělená podle handoveru; každé jiné ti uživatel musí potvrdit jako přiřazené jemu. Repozitáře Organizací sem nikdy neklonuj.",
      en: "- Organizations: no Organization repositories are mounted in a personal Remote Environment. Organization work (code, repositories, runs) happens over SSH in a work Remote Environment assigned to the user. Those in the section From this Personal Environment are assigned by the handover; any other the user must confirm is assigned to them. Never clone Organization repositories here.",
    },
  };
  const work = {
    plain: {
      cs: "- Práce v Organizaci (kód, repozitáře, běhy) patří na pracovní Remote Environment, který ti uživatel potvrdí jako přiřazený jemu, nikdy na tenhle Environment: připoj se přes SSH a pracuj tam. Repozitář Organizace sem nikdy neklonuj.",
      en: "- Organization work (code, repositories, runs) belongs in a work Remote Environment the user confirms is assigned to them, never in this Environment: connect over SSH and work there. Never clone an Organization repository into this personal Remote Environment.",
    },
    assigned: {
      cs: "- Práce v Organizaci (kód, repozitáře, běhy) patří na pracovní Remote Environment přidělený uživateli, nikdy na tenhle Environment: připoj se přes SSH a pracuj tam. Přidělená Pracovní Prostředí uvádí `AGENTS.md` (Z tohoto Osobního Prostředí) a jejich přidělení nepotvrzuješ; každé jiné ti uživatel musí potvrdit jako přiřazené jemu. Repozitář Organizace sem nikdy neklonuj.",
      en: "- Organization work (code, repositories, runs) belongs in a work Remote Environment assigned to the user, never in this Environment: connect over SSH and work there. `AGENTS.md` lists the assigned Work Environments (From this Personal Environment), and you do not confirm their assignment; any other the user must confirm is assigned to them. Never clone an Organization repository into this personal Remote Environment.",
    },
  };
  for (const locale of ["cs", "en"] as const) {
    for (const journey of journeys) {
      const outputs = renderOutputs({
        preset: journey.preset,
        machine: journey.machine,
        profile: presetProfile(journey.preset, journey.os, { locale }),
      });
      expect(outputs["AGENTS.md"]).not.toContain(heading[locale]);
      expect(outputs["manual/this-machine.md"]).not.toContain(
        exception[locale],
      );
    }
    const render = (machine: MachineBinding) =>
      renderOutputs({
        preset: "hosted-personal",
        machine,
        profile: presetProfile("hosted-personal", "linux", { locale }),
      });
    const outputs = render(bindings.personalAssigned);
    const agents = outputs["AGENTS.md"];
    const start = agents.indexOf(`\n${heading[locale]}\n`);
    expect(start).toBeGreaterThan(-1);
    const end = agents.indexOf("\n## ", start + 1);
    const section = agents.slice(start + 1, end + 1);
    expect(section).toContain(`- \`ssh ${environment}\``);
    expect(section).toContain("`~/.ssh/config.d/lazurio-environments.conf`");
    expect(section).toContain(
      locale === "cs"
        ? "Přidělení zaznamenal handover, takže ho s uživatelem nepotvrzuješ."
        : "The handover records the assignment, so you do not confirm it with the user.",
    );
    expect(section).toContain("`ssh-keyscan`");
    // The section after Boundaries, the Boundaries' and the manual's lines on
    // Organization work, the manual's line with its exception, and nothing
    // else differs from the same handover below Machines' gate.
    expect(agents.lastIndexOf("\n## ", start - 1)).toBe(
      agents.indexOf(locale === "cs" ? "\n## Hranice\n" : "\n## Boundaries\n"),
    );
    const plain = render(
      binding({
        ...handover,
        relationships: { zone: "personal", peers: [laptop, unassigned] },
      }),
    );
    expect(agents).toContain(`\n${boundary.assigned[locale]}\n`);
    expect(
      agents
        .replace(section, "")
        .replace(boundary.assigned[locale], boundary.plain[locale]),
    ).toBe(plain["AGENTS.md"]);
    const manual = outputs["manual/this-machine.md"];
    expect(manual).toContain(`\n${exception[locale]}\n`);
    expect(manual).toContain(`\n${work.assigned[locale]}\n`);
    expect(
      manual
        .replace(exception[locale], general[locale])
        .replace(work.assigned[locale], work.plain[locale]),
    ).toBe(plain["manual/this-machine.md"]);
    // Review of #691: no line of the whole AGENTS.md or manual still asks
    // the user to confirm every work Environment, which would contradict the
    // section; below the gate both still do.
    const confirmEvery =
      /který ti uživatel potvrdí jako přiřazený jemu|the user confirms is assigned to them/;
    for (const text of [agents, manual]) expect(text).not.toMatch(confirmEvery);
    for (const text of [plain["AGENTS.md"], plain["manual/this-machine.md"]])
      expect(text).toMatch(confirmEvery);
    expect({
      ...outputs,
      "AGENTS.md": "",
      "manual/this-machine.md": "",
    }).toEqual({ ...plain, "AGENTS.md": "", "manual/this-machine.md": "" });
    expect(agents).toMatchSnapshot(locale);
  }
});
