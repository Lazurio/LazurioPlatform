import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { machineIdentity } from "../src/folder/machine-binding";
import { derivePreset } from "../src/folder/presets";
import { workEnvironment } from "../src/github/pilot";
import {
  assigneeLogin,
  operatorAvatar,
  operatorLogin,
} from "../src/launchpad/shell-document";
import {
  type AssignmentReceipt,
  type AuthSourcedHandover,
  assignmentReceiptPath,
  createAssignedFolderLayout,
} from "../src/machine/assignment";
import { machineBinding } from "../src/machine/binding";
import {
  initializeMachineFolder,
  machineFailureAnswer,
  machineInspection,
  refreshMachineFolder,
} from "../src/machine/cli";
import {
  assignedMachineContext,
  bindMachineOperator,
  MachineContextError,
  machineContextPath,
  parseMachineContext,
  parseMachineHandover,
  readMachineContext,
  readMachineHandover,
} from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import { discoverHostedOperator } from "../src/machine/operator";
import { bindingValues } from "../src/recover/private-values";
import { handoverEntry } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// Root decision 0216 (Machines docs/free-environments.md §5.3, §5.4): a free
// Environment's handover is auth-sourced. It names its neutral Machine, an
// owner that follows the assignment (personal) or the assignment's source
// (work), the operational account as `operator`, and points to the receipt
// /etc/lazurio/assignment.json; its entry's name-bound origins are
// templates over the receipt's `dns_slug`. The Platform reads the receipt
// only for such a handover and acts for a person only once it names one.
// Every name here is invented.

type Json = Record<string, unknown>;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const pointer = {
  path: "/etc/lazurio/assignment.json",
  schema_version: "lazurio.assignment.v1",
} as const;
const operational = {
  os_user: "env-0007",
  home: "/home/env-0007",
  lazurio_root: "/home/env-0007/Lazurio",
};
const template = (base: string) =>
  JSON.parse(
    JSON.stringify(handoverEntry(`{dns_slug}.${base}`.replace(/\.$/, ""))),
  );

/** A free personal Environment's handover, as Machines writes it. */
const personalHandover = {
  ...personal,
  machine: {
    id: "personal-env-0007",
    kind: "personal-vm",
    name: "env-0007",
    vmid: 207,
  },
  owner: { kind: "assignment", source: "auth" },
  assignment_receipt: pointer,
  operator: operational,
  network: {
    headscale_server_url: "https://network.example.invalid",
    headscale_hostname: "personal-env-0007",
  },
  entry: {
    ...template("lazurio.io"),
    buddy: {
      external_origin: "https://buddy.{dns_slug}.lazurio.io",
      listen_port: 3774,
    },
  },
};
/** A free work Environment's handover. */
const { team: _team, ...workOwner } = organization.owner;
const workHandover = {
  ...organization,
  machine: {
    id: "example-work-07",
    kind: "workspace-vm",
    name: "work-07",
    vmid: 907,
  },
  owner: { ...workOwner, assignment: { kind: "operator", source: "auth" } },
  assignment_receipt: pointer,
  operator: {
    os_user: "work-07",
    home: "/home/work-07",
    lazurio_root: "/home/work-07/Lazurio",
  },
  entry: template("example.lazurio.io"),
};

const subject = "https://auth.example.invalid/realms/workspace/0000-0001";
function receipt(
  environment: string,
  organizationLabel: string | null,
  bound: boolean,
  linked = true,
): AssignmentReceipt {
  return {
    schema_version: "lazurio.assignment.v1",
    environment,
    state: bound ? "assigned" : "free",
    generation: bound ? 3 : 1,
    first: bound ? { generation: 2, subject, github_id: 4242 } : null,
    current: bound
      ? {
          generation: 3,
          assignee: {
            subject,
            github_id: linked ? 4242 : null,
            github_login: linked ? "Example-Person" : null,
          },
        }
      : null,
    dns_slug: bound ? "example-person" : null,
    organization: organizationLabel,
    account: bound ? "example-person" : null,
    hostname: bound
      ? `example-person-${organizationLabel ?? "personal"}-vm`
      : null,
  };
}
const personalReceipt = (bound = true) =>
  receipt("personal-env-0007", null, bound);
const workReceipt = (bound = true, linked = true) =>
  receipt("example-work-07", "example", bound, linked);
/** A bound work receipt whose first binding linked `first` (null: no
 * GitHub account) and whose current generation links `linked`. */
function workLinked(
  first: number | null,
  linked: Readonly<{ id: number; login: string }> | null,
): AssignmentReceipt {
  const bound = workReceipt();
  return {
    ...bound,
    first: { generation: 2, subject, github_id: first },
    current: {
      generation: 3,
      assignee: {
        subject,
        github_id: linked?.id ?? null,
        github_login: linked?.login ?? null,
      },
    },
  };
}
const handoverOf = (value: unknown) =>
  parseMachineHandover(bytes(value)) as AuthSourcedHandover;
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof MachineContextError ? error.code : String(error);
  }
  return "none";
};

test("the vendored schema takes the auth-sourced handover of both kinds, and only with its receipt pointer and templates", () => {
  const defs = (schema as unknown as { $defs: Record<string, unknown> }).$defs;
  for (const name of [
    "entry_template",
    "https_origin_template",
    "assignment_receipt",
  ])
    expect(defs[name]).toBeDefined();
  for (const handover of [personalHandover, workHandover]) {
    expect(parseMachineHandover(bytes(handover))).toEqual(handover as never);
    // A context only with its receipt.
    expect(code(() => parseMachineContext(bytes(handover)))).toBe(
      "machine-assignment-pending",
    );
    const { assignment_receipt: _pointer, ...without } = handover;
    expect(code(() => parseMachineHandover(bytes(without)))).toBe(
      "machine-context-invalid",
    );
    // A finished entry is not a template.
    expect(
      code(() =>
        parseMachineHandover(
          bytes({ ...handover, entry: handoverEntry("example.lazurio.io") }),
        ),
      ),
    ).toBe("machine-context-invalid");
  }
  // A handover declared the old way takes neither the pointer nor a template.
  expect(
    code(() =>
      parseMachineHandover(bytes({ ...personal, assignment_receipt: pointer })),
    ),
  ).toBe("machine-context-invalid");
  expect(
    code(() =>
      parseMachineHandover(
        bytes({ ...personal, entry: template("lazurio.io") }),
      ),
    ),
  ).toBe("machine-context-invalid");
  // Nobody is named beside the source.
  expect(
    code(() =>
      parseMachineHandover(
        bytes({
          ...workHandover,
          owner: {
            ...workHandover.owner,
            assignment: { kind: "operator", source: "auth", github_id: 1 },
          },
        }),
      ),
    ),
  ).toBe("machine-context-invalid");
});

test("before the receipt names a person there is nobody to act for", () => {
  for (const [handover, free] of [
    [personalHandover, personalReceipt(false)],
    [workHandover, workReceipt(false)],
  ] as const) {
    const parsed = handoverOf(handover);
    expect(code(() => assignedMachineContext(parsed, null))).toBe(
      "machine-assignment-pending",
    );
    expect(code(() => assignedMachineContext(parsed, bytes(free)))).toBe(
      "machine-assignment-pending",
    );
    expect(
      code(() =>
        assignedMachineContext(parsed, bytes({ ...free, state: "released" })),
      ),
    ).toBe("machine-assignment-released");
  }
});

test("a bound personal receipt makes its first assignee the owner, its account the operator and its slug the Environment's name", () => {
  const context = assignedMachineContext(
    handoverOf(personalHandover),
    bytes(personalReceipt()),
  );
  expect(context.machine).toEqual({
    id: "personal-env-0007",
    kind: "personal-vm",
    name: "example-person",
    vmid: 207,
  });
  expect(context.owner).toEqual({
    kind: "account",
    username: "example-person",
    subject,
    github: { login: "example-person", id: 4242 },
  } as never);
  expect(context.operator).toEqual({
    os_user: "example-person",
    home: "/home/example-person",
    lazurio_root: "/home/example-person/Lazurio",
  });
  expect(context.entry?.launchpad.external_origin).toBe(
    "https://launchpad.example-person.lazurio.io",
  );
  expect(context.entry?.launchpad.auth_check_url).toBe(
    "https://example-person.lazurio.io/oauth2/auth",
  );
  expect(context.entry?.modules.origin_template).toBe(
    "https://{module}.example-person.lazurio.io",
  );
  expect(context.entry?.buddy?.external_origin).toBe(
    "https://buddy.example-person.lazurio.io",
  );
  expect("assignment_receipt" in context).toBe(false);
  expect(Object.isFrozen(context.operator)).toBe(true);
  // The Folder is the person's, never the operational account's.
  expect(
    bindMachineOperator(context, {
      platform: "linux",
      uid: 2000,
      username: "example-person",
      homedir: "/home/example-person",
    }),
  ).toBe("/home/example-person/Lazurio");
  expect(
    code(() =>
      bindMachineOperator(context, {
        platform: "linux",
        uid: 1000,
        username: "env-0007",
        homedir: "/home/env-0007",
      }),
    ),
  ).toBe("machine-operator-mismatch");
  // Its preset is the personal one.
  expect(derivePreset(machineBinding(context, "a".repeat(64)))).toBe(
    "hosted-personal",
  );
});

test("a bound work receipt names its assignee by their Lazurio account, with the GitHub account linked now if any, and the Organization keeps owning it", () => {
  const context = assignedMachineContext(
    handoverOf(workHandover),
    bytes(workReceipt()),
  );
  expect(context.machine.name).toBe("work-07");
  expect(context.owner).toEqual({
    ...workOwner,
    assignment: {
      kind: "operator",
      account: {
        username: "example-person",
        subject,
        github: { login: "example-person", id: 4242 },
      },
    },
  } as never);
  expect(context.operator.os_user).toBe("example-person");
  expect(context.entry?.t3code.external_origin).toBe(
    "https://t3code.example-person.example.lazurio.io",
  );
  expect(derivePreset(machineBinding(context, "a".repeat(64)))).toBe(
    "hosted-organization-personal",
  );
  // A work Environment needs no GitHub account (root decision 0192): the
  // person without one is the same operator, by username and subject.
  const unlinked = assignedMachineContext(
    handoverOf(workHandover),
    bytes(workLinked(null, null)),
  );
  expect(unlinked.owner).toEqual({
    ...workOwner,
    assignment: {
      kind: "operator",
      account: { username: "example-person", subject, github: null },
    },
  } as never);
  expect(derivePreset(machineBinding(unlinked, "a".repeat(64)))).toBe(
    "hosted-organization-personal",
  );
});

test("a receipt of another Machine, or one the finisher would not have written, is refused whole", () => {
  const parsed = handoverOf(workHandover);
  const variants: Json[] = [
    { ...workReceipt(), environment: "example-work-08" },
    { ...workReceipt(), organization: "another" },
    { ...workReceipt(), extra: true },
    { ...workReceipt(), schema_version: "lazurio.assignment.v2" },
    { ...workReceipt(), dns_slug: null },
    { ...workReceipt(), account: "Example" },
    { ...workReceipt(), dns_slug: "{dns_slug}" },
    {
      ...workReceipt(),
      current: {
        generation: 3,
        assignee: {
          subject: `${subject}-other`,
          github_id: 1,
          github_login: "other",
        },
      },
    },
    { ...workReceipt(false), current: workReceipt().current },
  ];
  for (const variant of variants)
    expect(code(() => assignedMachineContext(parsed, bytes(variant)))).toBe(
      "machine-context-invalid",
    );
  expect(
    code(() => assignedMachineContext(parsed, Buffer.from("{unfinished"))),
  ).toBe("machine-context-invalid");
  // A personal receipt without the GitHub id linked at the first binding.
  const unlinked = personalReceipt();
  expect(
    code(() =>
      assignedMachineContext(
        handoverOf(personalHandover),
        bytes({
          ...unlinked,
          first: { ...unlinked.first, github_id: null },
        }),
      ),
    ),
  ).toBe("machine-context-invalid");
});

const uid = process.getuid?.() ?? -1;
async function machine(
  handover: unknown,
  receiptValue?: unknown,
  mode = 0o644,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-free-environment-")),
  );
  const root = join(parent, "machine");
  await mkdir(join(root, dirname(machineContextPath)), {
    recursive: true,
    mode: 0o755,
  });
  await chmod(root, 0o755);
  await writeFile(join(root, machineContextPath), JSON.stringify(handover), {
    mode: 0o644,
  });
  if (receiptValue !== undefined) {
    const file = join(root, assignmentReceiptPath);
    await writeFile(file, JSON.stringify(receiptValue), { mode: 0o644 });
    await chmod(file, mode);
  }
  return {
    source: { platform: "linux", root, custodian: uid },
    close: () => rm(parent, { recursive: true, force: true }),
  };
}

test.skipIf(process.platform === "win32" || uid === 0)(
  "the receipt is read beside the handover under the same custody, and only for an auth-sourced handover",
  async () => {
    const free = await machine(personalHandover);
    const bound = await machine(personalHandover, personalReceipt());
    const shared = await machine(personalHandover, personalReceipt(), 0o666);
    const old = await machine(personal, { anything: true }, 0o666);
    try {
      // Before the finisher wrote a receipt: nobody yet, and inspect prints
      // the handover as written.
      expect(
        await readMachineContext(free.source).then(
          () => "none",
          (error) => error.code,
        ),
      ).toBe("machine-assignment-pending");
      const written = await readMachineHandover(free.source);
      expect(machineInspection(written).context).toEqual(
        personalHandover as never,
      );
      // Bound: the person's context, the handover's digest.
      const read = await readMachineContext(bound.source);
      expect(read.context.operator.os_user).toBe("example-person");
      expect(read.digest).toBe(
        (await readMachineHandover(bound.source)).digest,
      );
      // A receipt anyone may write is never trusted.
      expect(
        await readMachineContext(shared.source).then(
          () => "none",
          (error) => error.code,
        ),
      ).toBe("machine-context-custody");
      // A handover declared the old way never reads a receipt.
      expect((await readMachineContext(old.source)).context.owner).toEqual(
        personal.owner as never,
      );
      // The hosted Folder: nobody's before the binding, the person's after,
      // never the operational account's.
      const person = async () =>
        Object.freeze({
          platform: "linux",
          uid: 2000,
          username: "example-person",
          homedir: "/home/example-person",
        });
      expect(
        await discoverHostedOperator({
          handover: free.source,
          operator: person,
        }),
      ).toEqual({ kind: "absent", reason: "machine-assignment-pending" });
      expect(
        await discoverHostedOperator({
          handover: bound.source,
          operator: person,
        }),
      ).toEqual({
        kind: "hosted",
        folder: join(bound.source.root, "/home/example-person/Lazurio"),
      });
      expect(
        await discoverHostedOperator({
          handover: bound.source,
          operator: async () =>
            Object.freeze({
              platform: "linux",
              uid: 1000,
              username: "env-0007",
              homedir: "/home/env-0007",
            }),
        }),
      ).toEqual({ kind: "absent", reason: "machine-operator-mismatch" });
    } finally {
      for (const world of [free, bound, shared, old]) await world.close();
    }
  },
);

const initChoices = {
  preset: undefined,
  locale: "en",
  detail: undefined,
  coordination: undefined,
} as const;

/** Every entry under `root`, by `lstat`, never following a link: what a
 * refused operation must leave exactly as it was. */
async function tree(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (path: string, name: string) => {
    const entry = await lstat(path);
    found.push(
      `${name} ${entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file"} ${(entry.mode & 0o7777).toString(8)}`,
    );
    if (entry.isDirectory() && !entry.isSymbolicLink())
      for (const child of (await readdir(path)).sort())
        await walk(join(path, child), `${name}/${child}`);
  };
  await walk(root, ".");
  return found;
}

test.skipIf(process.platform === "win32" || uid === 0)(
  "folder-init creates the person's Folder, its layout included, with the preset the receipt's kind derives",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "lazurio-free-environment-folder-")),
    );
    try {
      for (const [name, handover, bound, preset] of [
        ["personal", personalHandover, personalReceipt(), "hosted-personal"],
        ["work", workHandover, workReceipt(), "hosted-organization-personal"],
      ] as const) {
        const binding = machineBinding(
          assignedMachineContext(handoverOf(handover), bytes(bound)),
          "c".repeat(64),
        );
        const home = join(parent, name);
        await mkdir(home, { mode: 0o700 });
        const folder = join(home, "Lazurio");
        // Nothing was delivered ahead: the Platform creates the layout, as
        // the Machines role does elsewhere, then adopts it.
        const { code: exit, result } = await initializeMachineFolder(
          folder,
          binding,
          initChoices,
          true,
        );
        expect(exit).toBe(0);
        expect(result).toMatchObject({
          kind: "initialized",
          preset: { name: preset, selection: "derived" },
        });
        expect((await stat(folder)).mode & 0o777).toBe(0o750);
        expect((await stat(join(folder, "organizations"))).mode & 0o777).toBe(
          0o755,
        );
        expect(
          await stat(join(folder, "personalspace")).then(
            (found) => found.mode & 0o777,
            () => null,
          ),
        ).toBe(name === "personal" ? 0o700 : null);
        // Running it again changes nothing that exists.
        const before = await tree(home);
        expect(
          (await initializeMachineFolder(folder, binding, initChoices, true))
            .result,
        ).toMatchObject({ kind: "already-adopted" });
        expect(await tree(home)).toEqual(before);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32" || uid === 0)(
  "a free Environment's layout is created only after its preset and every existing entry passed, never through a link, and a refusal writes nothing",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "lazurio-free-environment-links-")),
    );
    const binding = machineBinding(
      assignedMachineContext(
        handoverOf(personalHandover),
        bytes(personalReceipt()),
      ),
      "c".repeat(64),
    );
    type Setup = (folder: string, outside: string) => Promise<unknown>;
    const cases: readonly (readonly [string, Setup, string | undefined])[] = [
      [
        "a link at the Folder",
        (folder, outside) => symlink(outside, folder),
        undefined,
      ],
      [
        "a dangling link at the Folder",
        (folder, outside) => symlink(join(outside, "missing"), folder),
        undefined,
      ],
      ["a file at the Folder", (folder) => writeFile(folder, ""), undefined],
      [
        "a link at organizations",
        async (folder, outside) => {
          await mkdir(folder, { mode: 0o750 });
          await symlink(outside, join(folder, "organizations"));
        },
        undefined,
      ],
      [
        "a link at personalspace",
        async (folder, outside) => {
          await mkdir(folder, { mode: 0o750 });
          await symlink(outside, join(folder, "personalspace"));
        },
        undefined,
      ],
      [
        "a shared Folder",
        async (folder) => {
          await mkdir(folder);
          await chmod(folder, 0o770);
        },
        undefined,
      ],
      [
        "a preset the handover does not allow",
        async () => {},
        "hosted-organization-team",
      ],
    ];
    try {
      for (const [index, [name, setup, preset]] of cases.entries()) {
        const home = join(parent, `home-${index}`);
        const outside = join(parent, `outside-${index}`);
        await mkdir(home, { mode: 0o700 });
        await mkdir(outside, { mode: 0o700 });
        const folder = join(home, "Lazurio");
        await setup(folder, outside);
        const before = [await tree(home), await tree(outside)];
        const refused = await initializeMachineFolder(
          folder,
          binding,
          { ...initChoices, preset: preset as never },
          true,
        ).then(
          (answer) => answer.code,
          () => "thrown",
        );
        expect([name, refused]).not.toEqual([name, 0]);
        expect([name, await tree(home), await tree(outside)]).toEqual([
          name,
          ...before,
        ]);
        if (preset === undefined) {
          // The layout's own step refuses it before it writes anything.
          await expect(
            createAssignedFolderLayout(folder, binding, "present"),
          ).rejects.toThrow();
          expect([name, await tree(home), await tree(outside)]).toEqual([
            name,
            ...before,
          ]);
        }
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

/** A bound personal receipt whose frozen username is `slug` and whose
 * current generation links `linked` (null: no GitHub account), the first
 * binding having linked GitHub id 4242. */
function personalLinked(
  slug: string,
  linked: Readonly<{ id: number; login: string }> | null,
): AssignmentReceipt {
  const bound = personalReceipt();
  return {
    ...bound,
    dns_slug: slug,
    account: slug,
    hostname: `${slug}-personal-vm`,
    current: {
      generation: 3,
      assignee: {
        subject,
        github_id: linked?.id ?? null,
        github_login: linked?.login ?? null,
      },
    },
  };
}
const personalBinding = (bound: AssignmentReceipt) =>
  machineBinding(
    assignedMachineContext(handoverOf(personalHandover), bytes(bound)),
    "c".repeat(64),
  );

test("a personal owner is the receipt's Lazurio account: its username is never taken for a GitHub login, and its GitHub account is only the one the receipt verifies", () => {
  // A chosen username that differs from the GitHub login of the first
  // binding's account: the owner is the username, the GitHub account is the
  // current generation's link of that same id.
  const chosen = personalBinding(
    personalLinked("chosen-name", { id: 4242, login: "Example-Person" }),
  );
  expect(chosen.name).toBe("chosen-name");
  expect(chosen.owner).toEqual({
    kind: "account",
    username: "chosen-name",
    subject,
    github: { login: "example-person", id: 4242 },
  } as never);
  expect(operatorLogin(chosen)).toBe("chosen-name");
  expect(operatorAvatar(chosen)).toContain("example-person");
  // A relink to another GitHub account, or none: the receipt verifies no
  // GitHub account of the first binding's id, so none is recorded, and the
  // username is never offered as one.
  for (const linked of [{ id: 5151, login: "other-login" }, null]) {
    const relinked = personalBinding(personalLinked("chosen-name", linked));
    expect(relinked.owner).toEqual({
      kind: "account",
      username: "chosen-name",
      subject,
      github: null,
    } as never);
    expect(operatorLogin(relinked)).toBe("chosen-name");
    expect(operatorAvatar(relinked)).toBeNull();
    // The same person and the same Environment: the Folder follows.
    expect(machineIdentity(relinked)).toEqual(machineIdentity(chosen));
  }
  // A GitHub rename keeps the id: the new login is recorded.
  expect(
    personalBinding(
      personalLinked("chosen-name", { id: 4242, login: "renamed-login" }),
    ).owner,
  ).toMatchObject({ github: { login: "renamed-login", id: 4242 } });
  // Its private values are withheld from recovery evidence.
  const withheld = bindingValues(chosen).map(({ value }) => value);
  for (const value of ["chosen-name", subject, "example-person", "4242"])
    expect(withheld).toContain(value);
});

test.skipIf(process.platform === "win32" || uid === 0)(
  "the personal Folder names its owner by username and verified GitHub account, and a later relink is recorded by folder-refresh",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "lazurio-free-environment-owner-")),
    );
    const ownerLine = async (folder: string) =>
      (await readFile(join(folder, "AGENTS.md"), "utf8"))
        .split("\n")
        .filter((line) => line.startsWith("- Owner:"));
    try {
      const home = join(parent, "home");
      await mkdir(home, { mode: 0o700 });
      const folder = join(home, "Lazurio");
      const linked = personalBinding(
        personalLinked("chosen-name", { id: 4242, login: "Example-Person" }),
      );
      expect(
        (await initializeMachineFolder(folder, linked, initChoices, true)).code,
      ).toBe(0);
      expect(await ownerLine(folder)).toEqual([
        "- Owner: the user with Lazurio username `chosen-name` (GitHub login `example-person`, id 4242). This is their one personal Remote Environment.",
      ]);
      const relinked = personalBinding(
        personalLinked("chosen-name", { id: 5151, login: "other-login" }),
      );
      expect(
        (await refreshMachineFolder(folder, relinked)).result,
      ).toMatchObject({ kind: "refreshed" });
      expect(await ownerLine(folder)).toEqual([
        "- Owner: the user with Lazurio username `chosen-name` (no verified GitHub account). This is their one personal Remote Environment.",
      ]);
      const agents = await readFile(join(folder, "AGENTS.md"), "utf8");
      expect(agents).not.toContain("GitHub login `chosen-name`");
      expect(agents).not.toContain("other-login");
      // Linked again to the first binding's account.
      expect((await refreshMachineFolder(folder, linked)).result).toMatchObject(
        {
          kind: "refreshed",
        },
      );
      expect((await ownerLine(folder))[0]).toContain(
        "(GitHub login `example-person`, id 4242)",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

const workBinding = (bound: AssignmentReceipt) =>
  machineBinding(
    assignedMachineContext(handoverOf(workHandover), bytes(bound)),
    "c".repeat(64),
  );

test.skipIf(process.platform === "win32" || uid === 0)(
  "a work assignee without a GitHub account gets their Folder, and a later link or unlink is recorded by folder-refresh",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "lazurio-free-environment-unlinked-")),
    );
    const assignmentLine = async (folder: string) =>
      (await readFile(join(folder, "AGENTS.md"), "utf8"))
        .split("\n")
        .filter((line) => line.startsWith("- Assignment:"));
    try {
      const home = join(parent, "home");
      await mkdir(home, { mode: 0o700 });
      const folder = join(home, "Lazurio");
      const unlinked = workBinding(workLinked(null, null));
      // The services' folder-init initializes it with the derived preset.
      expect(
        (await initializeMachineFolder(folder, unlinked, initChoices, true))
          .result,
      ).toMatchObject({
        kind: "initialized",
        preset: { name: "hosted-organization-personal" },
      });
      expect(await assignmentLine(folder)).toEqual([
        "- Assignment: assigned to the user with Lazurio username `example-person` (no verified GitHub account).",
      ]);
      expect(operatorLogin(unlinked)).toBe("example-person");
      expect(assigneeLogin(unlinked, "work")).toBe("example-person");
      expect(operatorAvatar(unlinked)).toBeNull();
      // No GitHub account to check a GitHub sign-in against.
      expect(await workEnvironment(async () => folder)).toMatchObject({
        kind: "refused",
        reason: "subject-unknown",
      });
      const withheld = bindingValues(unlinked).map(({ value }) => value);
      expect(withheld).toContain("example-person");
      expect(withheld).toContain(subject);
      // The person links a GitHub account later: the same operator, now
      // with it.
      const linked = workBinding(
        workLinked(null, { id: 4242, login: "Example-Person" }),
      );
      expect(machineIdentity(linked)).toEqual(machineIdentity(unlinked));
      expect((await refreshMachineFolder(folder, linked)).result).toMatchObject(
        { kind: "refreshed" },
      );
      expect(await assignmentLine(folder)).toEqual([
        "- Assignment: assigned to the user with Lazurio username `example-person` (GitHub login `example-person`, id 4242).",
      ]);
      expect(operatorAvatar(linked)).toContain("example-person");
      expect(await workEnvironment(async () => folder)).toMatchObject({
        kind: "work",
        subject: { login: "example-person", id: 4242 },
      });
      // And unlinks it again.
      expect(
        (await refreshMachineFolder(folder, unlinked)).result,
      ).toMatchObject({ kind: "refreshed" });
      expect((await assignmentLine(folder))[0]).toContain(
        "(no verified GitHub account)",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("every refusal of a free Environment is one blocked answer that names no person", () => {
  for (const reason of [
    "machine-assignment-pending",
    "machine-assignment-released",
  ] as const) {
    const answer = machineFailureAnswer(new MachineContextError(reason));
    expect(answer.code).toBe(2);
    expect(answer.result).toMatchObject({ kind: "blocked", reason });
    expect(JSON.stringify(answer)).not.toContain("example-person");
  }
});
