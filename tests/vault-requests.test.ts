import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import { runTool } from "../src/tools/status";
import { embeddedIdentity } from "../src/update/identity";
import { runVaultCommand, type VaultCliContext } from "../src/vault/cli";
import {
  type VaultHost,
  type VaultJournalEntry,
  vaultSecrets,
  vaultSetup,
} from "../src/vault/flow";
import { requestsDirectory } from "../src/vault/requests";
import { readRecord, vaultPaths } from "../src/vault/store";
import {
  fakeBw,
  fakeHost,
  fakePin,
  fakeRelease,
  ownAccount,
  pilotContext,
  startFakeVault,
  stateDirectory,
  zipOf,
} from "./fixtures/fake-vault";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// An agent's secret request (root decision 0198 point 9 (c), decision F53)
// over its real consumers: `lazurio vault request` creates it and reads its
// state, the Launchpad's routes show it to an admitted person, who saves the
// values or declines; the Environment saves them as one Secure note in its
// own vault (collection Agenti) through bw's standard input. A value lives in
// the vault only: never on argv (`$HOME/bw.calls`), in a request file, the
// journal or an answer. Against the fake Vaultwarden and the fake bw; every
// name and value is invented.

const posix = process.platform !== "win32";
type Json = Record<string, unknown>;

const origin = "https://launchpad.example.lazurio.io";
// Values that must never appear anywhere but in the vault.
const clientId = "fake-client-id-6d2f0b";
const clientSecret = "fake-client-secret-9a4c71e3";

const invoicing = [
  "request",
  "--item",
  "Fakturace API klient",
  "--need",
  "klíč pro připojení k fakturaci",
  "--why",
  "Abych mohl hledat a číst faktury.",
  "--where",
  "Najdete ho ve Fakturaci v Nastavení → API klienti.",
  "--field",
  "Client ID",
  "--field",
  "Client secret:secret",
] as const;

async function world(
  options: Readonly<{ context?: VaultHost["context"] }> = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "vault-requests-")),
  );
  const home = join(parent, "home");
  const vault = await startFakeVault(home);
  const zip = zipOf("bw", fakeBw);
  const pin = fakePin(zip);
  const journal: VaultJournalEntry[] = [];
  const host = fakeHost({
    home,
    vault,
    pin,
    download: fakeRelease(pin, zip).fetch,
    journal,
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  let recorded: string | null = origin;
  const context: VaultCliContext = {
    identity: embeddedIdentity(),
    platform: "linux",
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    executable: process.execPath,
    host,
    launchpadOrigin: async () => recorded,
  };
  const paths = vaultPaths(
    stateDirectory(home, "vaultwarden.example.lazurio.io", ownAccount),
  );
  return {
    parent,
    home,
    vault,
    host,
    journal,
    paths,
    cli: (args: readonly string[]) => runVaultCommand(args, context),
    /** The Folder records no entry: no link, only the page's path. */
    noOrigin: () => {
      recorded = null;
    },
    async setUp() {
      vault.allow(ownAccount);
      expect(await vaultSetup(host)).toMatchObject({ state: "connected" });
      return readRecord(paths);
    },
    async close() {
      await vault.stop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

/** A new request of `args`; its id. */
async function created(
  w: Awaited<ReturnType<typeof world>>,
  args: readonly string[] = invoicing,
): Promise<string> {
  const answer = await w.cli([...args, "--json"]);
  expect(answer.code).toBe(0);
  const value = JSON.parse(answer.stdout ?? "") as Json;
  return String(value.id);
}

/** A Launchpad of this computer over the world's vault. */
async function launchpad(w: Awaited<ReturnType<typeof world>>) {
  const folder = join(w.parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {},
    {
      path: "/usr/bin:/bin",
      home: w.home,
      xdg: {},
      platform: process.platform,
      run: runTool,
    },
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    w.host,
  );
  const url = new URL(app.url);
  const token = url.hash.slice(1);
  const answers: string[] = [];
  const send = async (
    route: string,
    init: Readonly<{
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    }> = {},
  ) => {
    const response = await fetch(new URL(route, url.origin), {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: JSON.parse(text) as Json };
  };
  const post = (route: string, body: unknown) =>
    send(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url.origin },
      body: JSON.stringify(body),
    });
  return {
    url,
    send,
    post,
    get: (route: string) => send(route),
    /** Every answer the Launchpad gave, as sent. */
    answers,
    close: () => app.close(),
  };
}

// Every file under a directory, read as text, but those under `skip`.
async function everyFile(directory: string, skip?: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && (skip === undefined || !path.startsWith(`${skip}/`)))
      text += await readFile(path, "utf8").catch(() => "");
  }
  return text;
}

test.skipIf(!posix)(
  "an agent creates a request where the Environment's own vault is connected, and lists and reads it back",
  async () => {
    const w = await world();
    try {
      // No vault yet: refused, nothing written.
      const early = await w.cli(invoicing);
      expect(early.code).toBe(2);
      expect(early.stdout).toBeUndefined();
      expect(early.stderr).toContain("(not-connected)");
      expect(
        await stat(requestsDirectory(w.paths)).catch(() => null),
      ).toBeNull();

      const record = await w.setUp();
      const text = await w.cli(invoicing);
      expect(text.code).toBe(0);
      const [first, next] = (text.stdout ?? "").split("\n");
      const match = /^Request ([a-z2-7]{24}): (\S+)$/.exec(first ?? "");
      expect(match).not.toBeNull();
      const id = match?.[1] as string;
      expect(match?.[2]).toBe(`${origin}/settings/vault/requests/${id}`);
      expect(next).toBe(
        `Give the person this link and go on with other work; lazurio vault request status ${id} says when it is answered.`,
      );

      const json = await w.cli([...invoicing, "--json"]);
      expect(json.code).toBe(0);
      const second = JSON.parse(json.stdout ?? "") as Json;
      expect(second).toEqual({
        kind: "vault-request",
        id: expect.stringMatching(/^[a-z2-7]{24}$/),
        item: "Fakturace API klient",
        need: "klíč pro připojení k fakturaci",
        why: "Abych mohl hledat a číst faktury.",
        where: "Najdete ho ve Fakturaci v Nastavení → API klienti.",
        fields: [
          { name: "Client ID", secret: false },
          { name: "Client secret", secret: true },
        ],
        createdAt: expect.stringMatching(/Z$/),
        state: "pending",
        answeredAt: null,
        link: `${origin}/settings/vault/requests/${second.id}`,
      });
      expect(second.id).not.toBe(id);

      // The file of each: owner-only, exactly the request, no link.
      const directory = requestsDirectory(w.paths);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      const file = join(directory, `${second.id}.json`);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const { kind: _, link: __, ...kept } = second;
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(kept);

      const list = await w.cli(["request", "list"]);
      expect(list.code).toBe(0);
      expect(list.stdout?.split("\n")).toEqual([
        `${id}  pending   Fakturace API klient`,
        `${second.id}  pending   Fakturace API klient`,
      ]);
      const listed = JSON.parse(
        (await w.cli(["request", "list", "--json"])).stdout ?? "",
      ) as { kind: string; requests: Json[] };
      expect(listed.kind).toBe("vault-requests");
      expect(listed.requests.map((request) => request.id)).toEqual([
        id,
        second.id,
      ]);

      expect(await w.cli(["request", "status", id])).toEqual({
        code: 0,
        stdout: `Pending: request ${id} waits for a person: ${origin}/settings/vault/requests/${id}`,
      });
      expect(
        JSON.parse(
          (await w.cli(["request", "status", id, "--json"])).stdout ?? "",
        ),
      ).toMatchObject({ kind: "vault-request", id, state: "pending" });

      // Without a recorded entry the page is named, not linked.
      w.noOrigin();
      expect((await w.cli(["request", "status", id])).stdout).toBe(
        `Pending: request ${id} waits for a person: Nastavení → Trezor in this Environment's Launchpad (/settings/vault/requests/${id})`,
      );
      expect(
        JSON.parse(
          (await w.cli(["request", "status", id, "--json"])).stdout ?? "",
        ),
      ).toMatchObject({ link: null });

      // An unknown request, of the right shape or not.
      for (const unknown of ["a".repeat(24), "../../etc/passwd", "-x"]) {
        const answer = await w.cli(["request", "status", "--", unknown]);
        expect([unknown, answer.code]).toEqual([unknown, 2]);
        expect(answer.stderr).toContain("(not-found)");
      }
      // The journal names what happened, nothing more.
      expect(
        w.journal.filter((entry) => entry.operation === "request"),
      ).toEqual([
        { operation: "request", outcome: "created" },
        { operation: "request", outcome: "created" },
      ]);
      expect(record.organizationId).not.toBeNull();
    } finally {
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a request the agent's words cannot make, or one without the Environment's own vault, is refused before anything is written",
  async () => {
    const w = await world();
    try {
      await w.setUp();
      const without = (option: string) => {
        const at = invoicing.indexOf(option as (typeof invoicing)[number]);
        return [...invoicing.slice(0, at), ...invoicing.slice(at + 2)];
      };
      const replaced = (option: string, value: string) =>
        invoicing.map((entry, index) =>
          invoicing[index - 1] === option ? value : entry,
        );
      const fields = (...specs: string[]) => [
        ...invoicing.slice(0, 9),
        ...specs.flatMap((spec) => ["--field", spec]),
      ];
      const cases: [readonly string[], string][] = [
        [without("--item"), "item-invalid"],
        [replaced("--item", "  "), "item-invalid"],
        [replaced("--item", "x".repeat(101)), "item-invalid"],
        [replaced("--need", "ab"), "need-invalid"],
        [replaced("--need", "klíč\nk fakturaci"), "need-invalid"],
        [replaced("--need", "x".repeat(201)), "need-invalid"],
        [without("--why"), "why-invalid"],
        [replaced("--why", "kvůli‮fakturám"), "why-invalid"],
        [without("--where"), "where-invalid"],
        [fields(), "fields-missing"],
        [
          fields(...Array.from({ length: 11 }, (_, i) => `Field ${i}`)),
          "too-many-fields",
        ],
        [fields(":secret"), "field-invalid"],
        [fields("Client\tID"), "field-invalid"],
        [fields("x".repeat(61)), "field-invalid"],
        [fields("Token", "token:secret"), "field-duplicate"],
      ];
      for (const [args, reason] of cases) {
        const answer = await w.cli(args);
        expect([reason, answer.code, answer.stdout]).toEqual([
          reason,
          2,
          undefined,
        ]);
        expect(answer.stderr).toContain(`Vault request invalid (${reason})`);
        const json = await w.cli([...args, "--json"]);
        expect(JSON.parse(json.stdout ?? "")).toEqual({
          kind: "vault-request-refused",
          reason,
        });
      }
      // Not one of its three forms: usage.
      for (const args of [
        [...invoicing, "--item", "Again"],
        [...invoicing, "--value", "x"],
        ["request", "status"],
        ["request", "status", "a".repeat(24), "extra"],
        ["request", "list", "--item", "x"],
        ["request", "list", "extra"],
        ["request", "other"],
      ]) {
        const answer = await w.cli(args);
        expect([args, answer.code]).toEqual([args, 2]);
        expect(answer.stderr).toStartWith("Usage: vault request");
      }
      expect(
        await stat(requestsDirectory(w.paths)).catch(() => null),
      ).toBeNull();

      // As many as a person answers wait already: the next is refused.
      for (let index = 0; index < 50; index++) await created(w);
      const tooMany = await w.cli(invoicing);
      expect(tooMany.code).toBe(2);
      expect(tooMany.stderr).toContain("(too-many)");
      expect(await readdir(requestsDirectory(w.paths))).toHaveLength(50);
    } finally {
      await w.close();
    }
    // A 0197 pilot is read only, and an Environment without a vault has none.
    for (const [context, reason] of [
      [async () => pilotContext(), "pilot-0197"],
      [
        async () => ({ kind: "unsupported", reason: "no-vault" }) as const,
        "no-vault",
      ],
      [
        async () => ({ kind: "unsupported", reason: "workstation" }) as const,
        "workstation",
      ],
    ] as const) {
      const other = await world({ context });
      try {
        for (const args of [
          invoicing,
          ["request", "list"],
          ["request", "status", "a".repeat(24)],
        ]) {
          const answer = await other.cli(args);
          expect([reason, answer.code]).toEqual([reason, 2]);
          expect(answer.stderr).toContain(`(${reason})`);
        }
      } finally {
        await other.close();
      }
    }
  },
  120_000,
);

test.skipIf(!posix)(
  "a person saves the values in the Launchpad: one Secure note in Agenti, the values in the vault and nowhere else",
  async () => {
    const w = await world();
    const page = await (async () => {
      await w.setUp();
      return launchpad(w);
    })();
    try {
      const record = await readRecord(w.paths);
      const id = await created(w);
      const waiting = await page.get("/api/vault/requests");
      expect(waiting).toEqual({
        status: 200,
        body: {
          kind: "vault-requests",
          requests: [
            {
              id,
              item: "Fakturace API klient",
              need: "klíč pro připojení k fakturaci",
              why: "Abych mohl hledat a číst faktury.",
              where: "Najdete ho ve Fakturaci v Nastavení → API klienti.",
              fields: [
                { name: "Client ID", secret: false },
                { name: "Client secret", secret: true },
              ],
              createdAt: expect.stringMatching(/Z$/),
              state: "pending",
              answeredAt: null,
            },
          ],
        },
      });
      expect(await page.get(`/api/vault/requests/${id}`)).toMatchObject({
        status: 200,
        body: { kind: "vault-request", id, state: "pending" },
      });

      const saved = await page.post(`/api/vault/requests/${id}/save`, {
        values: {
          "Client ID": clientId,
          "Client secret": ` ${clientSecret}\n`,
        },
      });
      expect(saved).toEqual({
        status: 200,
        body: {
          ...(waiting.body.requests as Json[])[0],
          kind: "vault-request",
          state: "saved",
          answeredAt: expect.stringMatching(/Z$/),
        },
      });

      // Exactly one item, a Secure note in Agenti of the Environment's own
      // vault: a text field and a hidden one, the need, why and where as its
      // notes; the copied white space around the secret gone.
      const items = await w.vault.created();
      expect(items).toEqual([
        {
          object: "item",
          id: expect.any(String),
          organizationId: record.organizationId,
          collectionIds: [record.collectionId],
          folderId: null,
          type: 2,
          name: "Fakturace API klient",
          notes:
            "Klíč pro připojení k fakturaci\nAbych mohl hledat a číst faktury.\nNajdete ho ve Fakturaci v Nastavení → API klienti.",
          favorite: false,
          fields: [
            { name: "Client ID", value: clientId, type: 0, linkedId: null },
            {
              name: "Client secret",
              value: clientSecret,
              type: 1,
              linkedId: null,
            },
          ],
          login: null,
          secureNote: { type: 0 },
          card: null,
          identity: null,
          reprompt: 0,
        },
      ]);
      // bw read the item on its standard input; a sync followed.
      const calls = (await w.vault.calls()).trim().split("\n");
      const create = calls.lastIndexOf(
        "create item --nointeraction|session=yes",
      );
      expect(create).toBeGreaterThan(-1);
      expect(calls.slice(create + 1)).toContain(
        "sync --nointeraction|session=yes",
      );

      // The agent learns it is saved, and under which name.
      const status = await w.cli(["request", "status", id]);
      expect(status.stdout).toBe(
        `Saved: the vault holds it as the item "Fakturace API klient" in the collection Agenti. Read it from the vault (eval "$(lazurio vault env)"; bw sync; bw get item "Fakturace API klient") and never print its values.`,
      );
      expect(await page.get("/api/vault/requests")).toEqual({
        status: 200,
        body: { kind: "vault-requests", requests: [] },
      });
      // Answered once: neither saved again nor declined.
      for (const [route, body] of [
        [`/api/vault/requests/${id}/save`, { values: {} }],
        [`/api/vault/requests/${id}/decline`, {}],
      ] as const)
        expect(await page.post(route, body)).toEqual({
          status: 409,
          body: { kind: "blocked", reason: "answered", state: "saved" },
        });
      expect(await w.vault.created()).toHaveLength(1);

      // What the request becomes is what a start reads (decision F46): the
      // one hidden field of the Secure note, right after it is saved.
      const key = await created(w, [
        "request",
        "--item",
        "EXTERNAL_API_KEY",
        "--need",
        "klíč ke službě s kurzy měn",
        "--why",
        "Aby aplikace mohla přepočítávat ceny.",
        "--where",
        "Ve službě s kurzy v Účet → API klíče.",
        "--field",
        "API key:secret",
      ]);
      expect(
        (
          await page.post(`/api/vault/requests/${key}/save`, {
            values: { "API key": clientSecret },
          })
        ).status,
      ).toBe(200);
      expect(
        await vaultSecrets(w.host, {
          company: "example",
          personalspace: true,
          names: ["EXTERNAL_API_KEY"],
        }),
      ).toEqual({
        kind: "vault-secrets",
        secrets: new Map([
          ["EXTERNAL_API_KEY", { kind: "value", value: clientSecret }],
        ]),
      });

      // The values are in the vault only: not on any argv, in a request
      // file or any file of this Platform, the journal or an answer. The
      // fake CLI keeps its synced copy in plain text under `fake/` of its
      // data directory, where the real bw keeps its encrypted store.
      const everything = [
        await w.vault.calls(),
        await everyFile(
          join(w.home, ".local", "state"),
          join(w.paths.data, "fake"),
        ),
        JSON.stringify(w.journal),
        page.answers.join("\n"),
        JSON.stringify(status),
      ].join("\n");
      for (const value of [clientId, clientSecret])
        expect(everything).not.toContain(value);
      expect(
        w.journal.filter((entry) => entry.operation === "request"),
      ).toEqual([
        { operation: "request", outcome: "created" },
        { operation: "request", outcome: "saved" },
        { operation: "request", outcome: "created" },
        { operation: "request", outcome: "saved" },
      ]);
    } finally {
      await page.close();
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a person declines a request: nothing goes to the vault and the agent learns it",
  async () => {
    const w = await world();
    await w.setUp();
    const page = await launchpad(w);
    try {
      const id = await created(w);
      expect(
        await page.post(`/api/vault/requests/${id}/decline`, {}),
      ).toMatchObject({
        status: 200,
        body: {
          kind: "vault-request",
          id,
          state: "declined",
          answeredAt: expect.stringMatching(/Z$/),
        },
      });
      expect(await w.vault.created()).toEqual([]);
      expect(await w.vault.calls()).not.toContain("create item");
      expect(await w.cli(["request", "status", id])).toEqual({
        code: 0,
        stdout: `Declined: the person declined request ${id}; nothing was saved.`,
      });
      expect(
        await page.post(`/api/vault/requests/${id}/save`, {
          values: { "Client ID": clientId, "Client secret": clientSecret },
        }),
      ).toEqual({
        status: 409,
        body: { kind: "blocked", reason: "answered", state: "declined" },
      });
      expect(await w.vault.created()).toEqual([]);
      expect(
        w.journal.filter((entry) => entry.operation === "request").at(-1),
      ).toEqual({ operation: "request", outcome: "declined" });
    } finally {
      await page.close();
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "values that are not exactly the request's fields, and requests that are not this page's, change nothing",
  async () => {
    const w = await world();
    await w.setUp();
    const page = await launchpad(w);
    try {
      const id = await created(w);
      const save = `/api/vault/requests/${id}/save`;
      for (const values of [
        { "Client ID": clientId },
        { "Client ID": clientId, "Client secret": clientSecret, Other: "x" },
        { "Client ID": clientId, "Client secret": "   " },
        { "Client ID": clientId, "Client secret": 42 },
        { "Client ID": clientId, "client secret": clientSecret },
        { "Client ID": clientId, "Client secret": "x".repeat(10_001) },
        [clientId, clientSecret],
        "values",
      ])
        expect([values, await page.post(save, { values })]).toEqual([
          values,
          {
            status: 400,
            body: { kind: "blocked", reason: "values-invalid" },
          },
        ]);
      // Exactly `{values}`, as JSON, by POST.
      expect(
        (
          await page.post(save, {
            values: { "Client ID": clientId, "Client secret": clientSecret },
            item: "Other",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await page.send(save, {
            method: "POST",
            headers: { "Content-Type": "text/plain", Origin: page.url.origin },
            body: JSON.stringify({ values: {} }),
          })
        ).status,
      ).toBe(415);
      expect((await page.get(save)).status).toBe(405);
      expect(
        (await page.post(`/api/vault/requests/${id}`, { values: {} })).status,
      ).toBe(405);
      expect((await page.post("/api/vault/requests", {})).status).toBe(405);
      expect((await page.get("/api/vault/requests?state=all")).status).toBe(
        400,
      );
      for (const unknown of ["a".repeat(24), "x", "..%2F..%2Fsecrets"])
        expect([
          unknown,
          await page.post(`/api/vault/requests/${unknown}/save`, {
            values: {},
          }),
        ]).toEqual([
          unknown,
          { status: 404, body: { kind: "blocked", reason: "not-found" } },
        ]);
      expect((await page.get("/api/vault/requests/a/b/c")).status).toBe(404);
      // The request still waits, and nothing reached bw.
      expect(await page.get(`/api/vault/requests/${id}`)).toMatchObject({
        status: 200,
        body: { state: "pending" },
      });
      expect(await w.vault.calls()).not.toContain("create item");
      expect(page.answers.join("\n")).not.toContain(clientSecret);
    } finally {
      await page.close();
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "only an admitted browser of this page reads or answers a request",
  async () => {
    const w = await world();
    await w.setUp();
    const page = await launchpad(w);
    try {
      const id = await created(w);
      const save = `/api/vault/requests/${id}/save`;
      const body = JSON.stringify({
        values: { "Client ID": clientId, "Client secret": clientSecret },
      });
      // Without the token nothing is read.
      for (const route of ["/api/vault/requests", `/api/vault/requests/${id}`])
        expect((await fetch(new URL(route, page.url.origin))).status).toBe(403);
      expect(
        (
          await page.send(`/api/vault/requests/${id}`, {
            headers: { Authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(403);
      // A write without this page's origin, or from another one.
      for (const headers of [
        { "Content-Type": "application/json" },
        { "Content-Type": "application/json", Origin: "http://evil.example" },
        {
          "Content-Type": "application/json",
          Origin: page.url.origin,
          Authorization: "Bearer wrong",
        },
      ])
        expect(
          (await page.send(save, { method: "POST", headers, body })).status,
        ).toBe(403);
      expect(await w.vault.created()).toEqual([]);
      expect(await page.get(`/api/vault/requests/${id}`)).toMatchObject({
        body: { state: "pending" },
      });
      // The page itself serves the request's route and Trezor's.
      for (const route of [
        `/settings/vault/requests/${id}`,
        "/settings/vault",
      ]) {
        const served = await fetch(new URL(route, page.url.origin));
        expect([route, served.status]).toEqual([route, 200]);
        const html = await served.text();
        expect(html).toContain('id="vault-request"');
        expect(html).toContain('id="vault-requests"');
      }
    } finally {
      await page.close();
      await w.close();
    }
  },
  60_000,
);

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port;
  probe.stop(true);
  return port;
};

test.skipIf(!posix)(
  "behind the gateway a save must be same-origin from the entry and admitted",
  async () => {
    const w = await world();
    await w.setUp();
    const folder = join(w.parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    const profile = presetProfile(preset, executionOs(process.platform));
    const machine = organizationWithEntry(freePort());
    const entry = machine.entry;
    if (entry === undefined) throw new Error("The fixture has an entry");
    await initializeHandoverFolder(folder, { preset, machine, profile });
    const fetcher: AuthFetcher = async (_url, init) =>
      new Headers(init.headers).get("cookie") ===
      "__Secure-lazurio-workspace=valid"
        ? new Response("ok")
        : new Response("no", { status: 401 });
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      { fetcher },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      w.host,
    );
    try {
      const id = await created(w);
      const base = `http://127.0.0.1:${entry.listenPort}`;
      const valid = {
        host: "launchpad.workspace.example.lazurio.io",
        cookie: "__Secure-lazurio-workspace=valid",
      };
      const save = (headers: Record<string, string>) =>
        fetch(`${base}/api/vault/requests/${id}/save`, {
          method: "POST",
          headers: { "content-type": "application/json", ...valid, ...headers },
          body: JSON.stringify({
            values: { "Client ID": clientId, "Client secret": clientSecret },
          }),
        });
      expect((await save({})).status).toBe(401);
      expect(
        (
          await save({
            origin: entry.externalOrigin,
            "sec-fetch-site": "cross-site",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await save({
            origin: "https://evil.example",
            "sec-fetch-site": "same-origin",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${base}/api/vault/requests`, {
            headers: { host: valid.host },
          })
        ).status,
      ).toBe(401);
      expect(await w.vault.created()).toEqual([]);
      const read = await fetch(`${base}/api/vault/requests/${id}`, {
        headers: valid,
      });
      expect(read.status).toBe(200);
      const admitted = await save({
        origin: entry.externalOrigin,
        "sec-fetch-site": "same-origin",
      });
      expect(admitted.status).toBe(200);
      expect(await admitted.json()).toMatchObject({ state: "saved" });
      expect(await w.vault.created()).toHaveLength(1);
    } finally {
      await app.close();
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a vault that refuses the item or does not answer leaves the request waiting for another try",
  async () => {
    const w = await world();
    await w.setUp();
    const page = await launchpad(w);
    try {
      const id = await created(w);
      const save = () =>
        page.post(`/api/vault/requests/${id}/save`, {
          values: { "Client ID": clientId, "Client secret": clientSecret },
        });
      await w.vault.createFails(true);
      expect(await save()).toEqual({
        status: 409,
        body: { kind: "blocked", reason: "vault-failed" },
      });
      await w.vault.createFails(false);
      await w.vault.unreachable(true);
      expect(await save()).toEqual({
        status: 503,
        body: { kind: "blocked", reason: "unreachable" },
      });
      await w.vault.unreachable(false);
      expect(await page.get(`/api/vault/requests/${id}`)).toMatchObject({
        body: { state: "pending" },
      });
      expect(await w.vault.created()).toEqual([]);
      expect((await save()).body).toMatchObject({ state: "saved" });
      expect(await w.vault.created()).toHaveLength(1);
      expect(
        w.journal.filter((entry) => entry.operation === "request"),
      ).toEqual([
        { operation: "request", outcome: "created" },
        { operation: "request", outcome: "refused", reason: "failed" },
        { operation: "request", outcome: "refused", reason: "unreachable" },
        { operation: "request", outcome: "saved" },
      ]);
      expect(JSON.stringify(w.journal)).not.toContain(clientSecret);
    } finally {
      await page.close();
      await w.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a process reads what the runner gives it on stdin, and nothing without it",
  async () => {
    const env = { PATH: "/usr/bin:/bin" };
    expect(
      await runTool(["/bin/sh", "-c", "cat"], 10_000, env, {
        stdin: "fake-stdin-value",
      }),
    ).toEqual({ exitCode: 0, stdout: "fake-stdin-value", stderr: "" });
    expect(await runTool(["/bin/sh", "-c", "cat"], 10_000, env)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    // A process that does not read it still answers.
    expect(
      await runTool(["/bin/sh", "-c", "exit 3"], 10_000, env, {
        stdin: "x".repeat(1024 * 1024),
      }),
    ).toEqual({ exitCode: 3, stdout: "", stderr: "" });
  },
);
