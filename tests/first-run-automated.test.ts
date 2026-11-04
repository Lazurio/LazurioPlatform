import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import type { MachineBinding } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { type PresetName, presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import {
  type ContentReader,
  createGithubProbe,
} from "../src/launchpad/setup-state";
import { parseShell, type ShellSetup } from "../src/shell/contract";
import { runTool, type ToolRunner } from "../src/tools/status";
import { writeOrganization } from "./fixtures/catalog-folder";
import {
  fakeLoginTools,
  githubHostKeys,
  realSshKeygen,
} from "./fixtures/fake-login-tools";
import { binding, handoverEntry } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import { freePort } from "./fixtures/ports";
import { runChild } from "./fixtures/run-child";

// The Automated Environment has the onboarding of a work Environment
// (decision F27's addendum of 2026-10-30; root decision 0188's addendum of
// that day): the server's side of it, behind a hosted Launchpad's admission.
// The shell document carries `setup` for the column's prompt, "Vyřešit v
// Chatu" (`prepare-content`) serves its responsible user, and the soft check
// counts gh signed in as that user's own account as missing GitHub. A Team
// Environment keeps none of it. Synthetic names only: the responsible user
// is the fake gh's `octocat` or the fixtures' `example`.

const posixTest = test.skipIf(process.platform === "win32");
const sshTest = test.skipIf(process.platform === "win32" || !realSshKeygen);

const host = "workspace.example.lazurio.io";

/** An Organization work VM with its entry on `port`: the Automated
 * Environment of a persona whose responsible user is `responsible`, or the
 * Team Environment. */
function machine(
  port: number,
  kind: "automation" | "team",
  responsible = "example",
): MachineBinding {
  return binding({
    ...organization,
    // Its Team kept, as the handover states it.
    owner: {
      ...organization.owner,
      assignment:
        kind === "team"
          ? { kind: "team" }
          : {
              kind: "automation",
              github_login: responsible,
              github_id: 583231,
            },
    },
    entry: handoverEntry(host, port),
  }) as MachineBinding;
}

type Hosted = Awaited<ReturnType<typeof hosted>>;

/** A hosted Launchpad of `preset` on `binding`. Its gh is signed out unless
 * `tools` brings its own (the fake login tools); with `content`, what lives
 * here and the last installation are stubbed. */
async function hosted(
  preset: PresetName,
  port: number,
  bound: MachineBinding,
  options: Readonly<{
    content?: ContentReader;
    tools?: Readonly<{ path: string; home: string }>;
  }> = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-automated-")),
  );
  const home = options.tools?.home ?? join(parent, "home");
  const bin = join(home, ".local", "bin");
  if (options.tools === undefined) {
    await mkdir(bin, { recursive: true, mode: 0o700 });
    await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await writeOrganization(folder, "other_GEN3", {
    slug: "other",
    state: "current",
    modules: [{ id: "deals" }],
  });
  await initializeHandoverFolder(folder, {
    preset,
    machine: bound,
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const signedOut: ToolRunner = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "You are not logged into any GitHub hosts.",
  });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    options.tools === undefined
      ? { path: bin, home, platform: process.platform, run: signedOut }
      : {
          path: options.tools.path,
          home,
          platform: process.platform,
          run: runTool,
        },
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    options.content,
  );
  const external = new URL(`https://launchpad.${host}`).host;
  return {
    folder,
    base: `http://127.0.0.1:${port}`,
    host: external,
    valid: { host: external, cookie: "__Secure-lazurio-workspace=valid" },
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function shell(app: Hosted) {
  const answer = await fetch(`${app.base}/.lazurio/shell.json`, {
    headers: app.valid,
  });
  expect(answer.status).toBe(200);
  return parseShell(await answer.json());
}

// The shell document's `setup` once the Launchpad has read it: the document
// never waits for GitHub (F36's addendum of 2026-10-08).
async function knownSetup(app: Hosted): Promise<ShellSetup | undefined> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const setup = (await shell(app))?.setup;
    if (setup !== undefined) return setup;
    await Bun.sleep(50);
  }
  return undefined;
}

const stub = (list: unknown, job: unknown): ContentReader => ({
  list: async () => list,
  lastJob: async () => job,
});
const listAnswer = {
  allowed: true,
  items: [
    {
      kind: "organization",
      login: "example-org",
      name: "Example",
      state: "absent",
    },
  ],
};
const failedAnswer = {
  id: "job-7",
  state: "failed",
  steps: [],
  failure: {
    item: { kind: "organization", login: "example-org" },
    key: "root",
    code: "clone-failed",
    detail: "git clone failed: Permission denied (publickey)",
  },
};

posixTest(
  "hosted: the Automated Environment's shell document carries the onboarding's setup, as a work Environment's does; a Team Environment's none",
  async () => {
    const port = freePort();
    const automated = await hosted(
      "hosted-organization-steward",
      port,
      machine(port, "automation"),
    );
    try {
      expect(await knownSetup(automated)).toEqual({
        ai: "missing",
        github: "missing",
        content: "missing",
        item: { kind: "organization", name: "example", login: "example" },
      });
    } finally {
      await automated.close();
    }
    const teamPort = freePort();
    const team = await hosted(
      "hosted-organization-team",
      teamPort,
      machine(teamPort, "team"),
    );
    try {
      // Read again and again: the document never gains a `setup` there.
      for (let attempt = 0; attempt < 10; attempt++) {
        expect((await shell(team))?.setup).toBeUndefined();
        await Bun.sleep(30);
      }
    } finally {
      await team.close();
    }
  },
  60_000,
);

posixTest(
  "hosted: Vyřešit v Chatu serves the Automated Environment's responsible user behind its admission; a Team Environment's the same 404",
  async () => {
    const port = freePort();
    const automated = await hosted(
      "hosted-organization-steward",
      port,
      machine(port, "automation"),
      { content: stub(listAnswer, failedAnswer) },
    );
    try {
      const path = `${automated.base}/.lazurio/prompts/prepare-content?org=example-org`;
      // Outside the admission: nothing.
      expect(
        (await fetch(path, { headers: { host: automated.host } })).status,
      ).toBe(401);
      const answer = await fetch(path, { headers: automated.valid });
      expect(answer.status).toBe(200);
      const document = (await answer.json()) as Record<string, string>;
      expect(document.schema).toBe("lazurio.prompt.v1");
      expect(document.id).toBe("prepare-content");
      expect(document.cwd).toBe(automated.folder);
      // To people the Automated Environment is a work Environment (0207).
      expect(document.text?.split("\n")[0]).toBe(
        "Příprava Organizace Example (GitHub example-org) v tomto Pracovním Prostředí se zastavila u kroku „Stahuji Organizaci“:",
      );
      expect(document.text).toContain(
        "`lazurio organization install example-org`",
      );
      // Only for the content that stopped.
      const other = await fetch(
        `${automated.base}/.lazurio/prompts/prepare-content?org=someone-else`,
        { headers: automated.valid },
      );
      expect(other.status).toBe(404);
    } finally {
      await automated.close();
    }
    const teamPort = freePort();
    const team = await hosted(
      "hosted-organization-team",
      teamPort,
      machine(teamPort, "team"),
      { content: stub(listAnswer, failedAnswer) },
    );
    try {
      const refused = await fetch(
        `${team.base}/.lazurio/prompts/prepare-content?org=example-org`,
        { headers: team.valid },
      );
      expect([refused.status, await refused.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
    } finally {
      await team.close();
    }
  },
  60_000,
);

/** A home whose fake gh is signed in as `account` with this Machine's SSH
 * key registered to it, so that the fake ssh greets it: GitHub connected,
 * by every proof the Launchpad runs (decision F19, addendum 2026-10-19). The
 * fake ssh greets `octocat` only. */
async function linkedHome(account: string) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-automated-gh-")),
  );
  const path = await fakeLoginTools(home, ["gh"]);
  await mkdir(join(home, ".ssh"), { recursive: true, mode: 0o700 });
  await writeFile(join(home, "gh.state"), `${account}\n`);
  await writeFile(join(home, "gh.scopes"), "gist read:org repo\n");
  const key = join(home, ".ssh", "id_ed25519");
  const made = await runChild(
    [
      realSshKeygen as string,
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "test",
      "-f",
      key,
    ],
    { env: { HOME: home } },
  );
  if (made.exitCode !== 0) throw new Error("ssh-keygen failed");
  const publicKey = (await readFile(`${key}.pub`, "utf8"))
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  await writeFile(join(home, "gh.keys"), `101\tLazurio: vm-01\t${publicKey}\n`);
  await writeFile(
    join(home, ".ssh", "known_hosts"),
    `${githubHostKeys.map((entry) => `github.com ${entry}`).join("\n")}\n`,
  );
  return {
    home,
    path,
    close: () => rm(home, { recursive: true, force: true }),
  };
}

sshTest(
  "hosted: the shell counts gh signed in as the responsible user's own account as missing GitHub; the same sign-in where the binding names someone else is connected",
  async () => {
    const linked = await linkedHome("octocat");
    try {
      // The probe keeps the account with the state: what the soft check
      // compares.
      expect(
        await createGithubProbe({
          path: linked.path,
          home: linked.home,
          platform: process.platform,
          run: runTool,
        }).reading(),
      ).toEqual({ state: "connected", account: "octocat" });
      // The binding names `octocat` as the responsible user: its own
      // account is signed in where the persona's belongs.
      const ownPort = freePort();
      const own = await hosted(
        "hosted-organization-steward",
        ownPort,
        machine(ownPort, "automation", "octocat"),
        { tools: linked },
      );
      try {
        expect((await knownSetup(own))?.github).toBe("missing");
      } finally {
        await own.close();
      }
      // The binding names another user: the same sign-in is the persona's.
      const personaPort = freePort();
      const persona = await hosted(
        "hosted-organization-steward",
        personaPort,
        machine(personaPort, "automation", "example"),
        { tools: linked },
      );
      try {
        expect((await knownSetup(persona))?.github).toBe("connected");
      } finally {
        await persona.close();
      }
    } finally {
      await linked.close();
    }
  },
  90_000,
);
