import { expect, test } from "bun:test";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { createHermesGateway } from "../src/buddy/hermes-gateway";
import {
  type BotCheck,
  createBuddyTelegram,
  pairingMessage,
  type TelegramCard,
  type TelegramJournalEntry,
  telegramBotChecker,
  telegramBotPath,
  telegramCardOf,
  telegramQuietConfig,
  telegramStatusOf,
} from "../src/buddy/telegram";
import {
  type FakeHermesGateway,
  fakeHermesGateway,
} from "./fixtures/fake-hermes-gateway";

// Decision F66: Buddy's own Telegram bot through Hermes's own writers, read
// live from Hermes, against the stand-in for his gateway whose Telegram is
// derived from Hermes's code at v0.22.4-lazurio.3. The token reaches Hermes's
// writer once, after Telegram said it is a bot's, and nothing else: not an
// answer, not the journal, not a file. Hermes's own words and ids stay in the
// core. Telegram's flood limit and timeouts read as "on its way", never as an
// error.

const posix = test.skipIf(process.platform === "win32");

/** A token of a bot's shape, made here so the repository holds none. */
const token = `${"7".repeat(10)}:AAH${"q".repeat(32)}`;
const otherToken = `${"8".repeat(10)}:BBH${"w".repeat(32)}`;
const person = "4242424242";
const stranger = "5151515151";

type Fixture = Readonly<{
  fake: FakeHermesGateway;
  core: ReturnType<typeof createBuddyTelegram>;
  journal: TelegramJournalEntry[];
  checked: string[];
  changes: () => number;
  owe: (value: boolean) => void;
}>;

async function within(
  body: (fixture: Fixture) => Promise<void>,
  check: (token: string) => BotCheck | Promise<BotCheck> = () => ({
    kind: "bot",
    username: "rex_buddy_bot",
  }),
  setup: Readonly<{
    fake?: Parameters<typeof fakeHermesGateway>[0];
    pairingText?: () => Promise<string | undefined>;
    /** How long the client waits for an answer of Hermes. */
    httpMs?: number;
  }> = {},
) {
  const fake = await fakeHermesGateway(setup.fake);
  const journal: TelegramJournalEntry[] = [];
  const checked: string[] = [];
  let changes = 0;
  let owed = false;
  const core = createBuddyTelegram({
    gateway: createHermesGateway({
      home: fake.userHome,
      ...(setup.httpMs === undefined ? {} : { httpMs: setup.httpMs }),
    }),
    home: fake.userHome,
    owed: () => owed,
    changed: async () => {
      changes += 1;
      owed = true;
    },
    checkBot: async (value) => {
      checked.push(value);
      return check(value);
    },
    pairingText: setup.pairingText,
    journal: (entry) => journal.push(entry),
  });
  try {
    await body({
      fake,
      core,
      journal,
      checked,
      changes: () => changes,
      owe: (value) => {
        owed = value;
      },
    });
  } finally {
    await fake.close();
  }
}

/** Neither the token, an account, Hermes's request ids nor its words leave
 * the core. */
function clean(value: unknown, fake: FakeHermesGateway) {
  const text = JSON.stringify(value);
  for (const secret of [token, otherToken, person, stranger, "Hermes words"])
    expect(text).not.toContain(secret);
  for (const entry of fake.state.telegram.pending)
    expect(text).not.toContain(entry.request_id);
}

/** What reached Hermes besides reads: method, path and body. */
const writesOf = (fake: FakeHermesGateway) =>
  fake.requests
    .filter((request) => request.method !== "GET")
    .map((request) => [request.method, request.path, JSON.parse(request.body)]);

/** Hermes answering 500 to exactly one write. */
const failing =
  (method: string, path: string) =>
  (request: { method: string; path: string }) =>
    request.method === method && request.path === path
      ? Response.json({ detail: "Internal server error" }, { status: 500 })
      : undefined;

const card = (patch: Partial<TelegramCard> = {}): TelegramCard => ({
  enabled: true,
  configured: true,
  runtime: "connected",
  errorCode: null,
  allowlisted: false,
  allowed: [],
  preview: "«redacted:7777...qqqq»",
  ...patch,
});

test("the state is a pure function of Hermes's card: Telegram's waits and refusals at first read as on its way", () => {
  const facts = { owed: false };
  expect(telegramStatusOf(null, facts)).toEqual({ state: "unknown" });
  expect(telegramStatusOf(card({ configured: false }), facts)).toEqual({
    state: "none",
  });
  expect(telegramStatusOf(card({ enabled: false }), facts)).toEqual({
    state: "none",
  });
  // A disconnect that waits for Buddy says so.
  expect(telegramStatusOf(card({ enabled: false }), { owed: true })).toEqual({
    state: "none",
    pending: true,
  });
  // A restart owed: the running gateway still has what it read before,
  // whatever its card says of the platform.
  for (const runtime of ["connected", "fatal", "pending_restart", null])
    expect(
      telegramStatusOf(card({ runtime, errorCode: "telegram_auth_error" }), {
        owed: true,
        bot: "rex_buddy_bot",
      }),
    ).toEqual({ state: "starting", bot: "rex_buddy_bot", pending: true });
  // Connecting, retrying after a flood limit or a timeout, never started,
  // briefly disconnected: on its way, never an error.
  for (const runtime of [
    "connecting",
    "retrying",
    "pending_restart",
    "disconnected",
    "paused",
    null,
  ])
    expect(
      telegramStatusOf(
        card({ runtime, errorCode: "telegram_connect_error" }),
        facts,
      ),
    ).toEqual({ state: "starting" });
  expect(
    telegramStatusOf(
      card({ runtime: "fatal", errorCode: "telegram_auth_error" }),
      facts,
    ),
  ).toEqual({ state: "failed", reason: "refused" });
  expect(
    telegramStatusOf(
      card({ runtime: "fatal", errorCode: "telegram_polling_conflict" }),
      facts,
    ),
  ).toEqual({ state: "failed", reason: "conflict" });
  expect(
    telegramStatusOf(
      card({ runtime: "fatal", errorCode: "missing_dependency" }),
      facts,
    ),
  ).toEqual({ state: "failed", reason: "failed" });
  // Running: connected once anyone is allowed, else it waits for the
  // person's Start with who asked.
  expect(
    telegramStatusOf(card({ allowlisted: true, allowed: [person] }), facts),
  ).toEqual({ state: "connected" });
  expect(
    telegramStatusOf(card(), {
      owed: false,
      requests: [{ request: "a".repeat(32), name: "rex" }],
    }),
  ).toEqual({
    state: "waiting",
    requests: [{ request: "a".repeat(32), name: "rex" }],
  });
});

test("Hermes's card is read only as Telegram's, of its known shape", () => {
  const entry = {
    id: "telegram",
    enabled: true,
    configured: true,
    state: "connected",
    error_code: null,
    env_vars: [
      { key: "TELEGRAM_BOT_TOKEN", redacted_value: "«redacted:7777...qqqq»" },
      {
        key: "TELEGRAM_ALLOWED_USERS",
        value: ` ${person}, *,x `,
        is_set: true,
      },
    ],
  };
  expect(
    telegramCardOf({ platforms: [{ ...entry, id: "discord" }, entry] }),
  ).toEqual({
    enabled: true,
    configured: true,
    runtime: "connected",
    errorCode: null,
    allowlisted: true,
    allowed: [person],
    preview: "«redacted:7777...qqqq»",
  });
  for (const body of [
    null,
    { platforms: {} },
    { platforms: [] },
    { platforms: [entry, entry] },
    { platforms: [{ ...entry, enabled: "yes" }] },
  ])
    expect(telegramCardOf(body)).toBeNull();
});

posix(
  "connect: Telegram first, then Hermes's writer once with exactly the token and enabled, the quiet keys, the restart asked; the token nowhere else",
  () =>
    within(async ({ fake, core, journal, checked, changes }) => {
      const answer = await core.connect(token);
      expect(checked).toEqual([token]);
      const writes = fake.requests.filter(
        (request) => request.method !== "GET",
      );
      expect(writes.map((request) => [request.method, request.path])).toEqual([
        ["PUT", "/api/messaging/platforms/telegram"],
        ["PUT", "/api/config"],
      ]);
      expect(JSON.parse(writes[0]?.body ?? "")).toEqual({
        env: { TELEGRAM_BOT_TOKEN: token },
        enabled: true,
      });
      // Explicit, so a token saved any other way ends the same.
      expect(fake.state.telegram.enabled).toBe(true);
      expect(JSON.parse(writes[1]?.body ?? "")).toEqual({
        config: telegramQuietConfig,
      });
      expect(fake.state.telegram.config).toEqual({
        display: {
          platforms: {
            telegram: {
              tool_progress: false,
              long_running_notifications: false,
              suppress_warning_notifications: true,
            },
          },
        },
        compression: { codex_gpt55_autoraise_notice: false },
        platforms: {
          telegram: {
            gateway_restart_notification: false,
            extra: { drop_pending_on_cold_boot: false },
          },
        },
      });
      expect(changes()).toBe(1);
      // On its way, its bot named, its address as a code to scan.
      expect(answer).toMatchObject({
        kind: "telegram",
        state: "starting",
        bot: "rex_buddy_bot",
        pending: true,
      });
      expect(answer.kind === "telegram" && answer.botQr).toStartWith("<svg");
      expect(journal).toEqual([{ operation: "connect", outcome: "telegram" }]);
      clean([answer, journal], fake);
      // The record of the bot: its name and a digest of Hermes's preview.
      const record = await readFile(telegramBotPath(fake.userHome), "utf8");
      expect(record).not.toContain(token);
      expect(record).not.toContain("redacted");
      expect(JSON.parse(record)).toMatchObject({
        schema_version: "lazurio.buddy-telegram-bot.v1",
        username: "rex_buddy_bot",
      });
      expect((await lstat(telegramBotPath(fake.userHome))).mode & 0o777).toBe(
        0o600,
      );
    }),
);

posix(
  "connect: a token of another shape, one Telegram does not know or Telegram not answering saves nothing and asks no restart",
  async () => {
    await within(async ({ fake, core, checked, changes, journal }) => {
      for (const value of [
        "",
        "123",
        `${token}\n`,
        "abc:".concat("x".repeat(40)),
      ])
        expect(await core.connect(value)).toEqual({
          kind: "invalid",
          reason: "invalid-token",
        });
      expect(checked).toEqual([]);
      expect(fake.requests).toHaveLength(0);
      expect(changes()).toBe(0);
      clean(journal, fake);
    });
    await within(
      async ({ fake, core, changes }) => {
        expect(await core.connect(token)).toEqual({
          kind: "failed",
          reason: "token-refused",
        });
        expect(fake.requests).toHaveLength(0);
        expect(fake.state.telegram.token).toBeNull();
        expect(changes()).toBe(0);
      },
      () => ({ kind: "refused" }),
    );
    await within(
      async ({ fake, core, changes }) => {
        expect(await core.connect(token)).toEqual({
          kind: "failed",
          reason: "telegram-unreachable",
        });
        expect(fake.requests).toHaveLength(0);
        expect(changes()).toBe(0);
      },
      () => ({ kind: "unreachable" }),
    );
  },
);

posix(
  "connect: Hermes refusing the token, failing, or not running changes nothing it reports; its words never leave",
  () =>
    within(async ({ fake, core, changes, journal }) => {
      fake.state.http = (request) =>
        request.method === "PUT"
          ? Response.json(
              { detail: `Hermes words about ${token}` },
              { status: 400 },
            )
          : undefined;
      const refused = await core.connect(token);
      expect(refused).toEqual({ kind: "failed", reason: "token-refused" });
      fake.state.http = (request) =>
        request.method === "PUT"
          ? Response.json({ detail: "Internal server error" }, { status: 500 })
          : undefined;
      expect(await core.connect(token)).toEqual({
        kind: "failed",
        reason: "failed",
      });
      expect(changes()).toBe(0);
      fake.state.http = undefined;
      await fake.stop();
      const down = await core.connect(token);
      expect(down).toEqual({ kind: "unavailable", reason: "no-socket" });
      expect(await core.read()).toEqual({ state: "unknown" });
      clean([refused, down, journal], fake);
    }),
);

posix(
  "the bot's name shows only while Hermes still holds a token of the preview it was recorded with",
  () =>
    within(async ({ fake, core, owe }) => {
      await core.connect(token);
      owe(false);
      fake.state.telegram.runtime = "connected";
      fake.state.telegram.allowed = person;
      expect(await core.read()).toEqual({
        state: "connected",
        bot: "rex_buddy_bot",
      });
      // Replaced elsewhere (the installer, Hermes's own dashboard): no name.
      fake.state.telegram.token = otherToken;
      expect(await core.read()).toEqual({ state: "connected" });
      // A record that is not one, or a link, names nothing either.
      fake.state.telegram.token = token;
      await writeFile(telegramBotPath(fake.userHome), "{");
      expect(await core.read()).toEqual({ state: "connected" });
    }),
);

posix(
  "approve: who asked, by a handle of this process; the home channel, Hermes's approval, then the allowlist; the installer's end state",
  () =>
    within(async ({ fake, core, owe, journal }) => {
      await core.connect(token);
      owe(false);
      fake.state.telegram.runtime = "connected";
      // Nobody yet: it waits for the person's Start.
      expect(await core.read()).toMatchObject({
        state: "waiting",
        requests: [],
      });
      const mine = fake.telegramMessage(person, "jana_s");
      const theirs = fake.telegramMessage(stranger, "Somebody Else");
      expect(mine).not.toBeNull();
      const read = await core.read();
      if (read.state !== "waiting") throw new Error("waiting");
      expect(read.requests?.map((request) => request.name).sort()).toEqual([
        "Somebody Else",
        "jana_s",
      ]);
      // Two handles of the page's own shape, neither Hermes's id.
      const handles = read.requests?.map((request) => request.request) ?? [];
      expect(new Set(handles).size).toBe(2);
      for (const handle of handles) {
        expect(handle).toMatch(/^[0-9a-f]{32}$/);
        expect([mine, theirs]).not.toContain(handle);
      }
      clean(read, fake);
      const handle = read.requests?.find((request) => request.name === "jana_s")
        ?.request as string;
      fake.requests.length = 0;
      const answer = await core.approve(handle);
      const writes = fake.requests.filter(
        (request) => request.method !== "GET",
      );
      expect(
        writes.map((request) => [
          request.method,
          request.path,
          JSON.parse(request.body),
        ]),
      ).toEqual([
        ["PUT", "/api/env", { key: "TELEGRAM_HOME_CHANNEL", value: person }],
        [
          "POST",
          "/api/pairing/approve",
          { platform: "telegram", request_id: mine },
        ],
        [
          "PUT",
          "/api/messaging/platforms/telegram",
          { env: { TELEGRAM_ALLOWED_USERS: person } },
        ],
      ]);
      // As the installer leaves it: that account allowed, the home channel
      // its private chat, everyone else kept out.
      expect(fake.state.telegram.allowed).toBe(person);
      expect(fake.state.telegram.home).toBe(person);
      expect(fake.state.telegram.approved.map((user) => user.user_id)).toEqual([
        person,
      ]);
      expect(fake.telegramMessage("6161616161", "late")).toBeNull();
      expect(answer).toEqual({
        kind: "telegram",
        state: "connected",
        bot: "rex_buddy_bot",
      });
      expect(journal.at(-1)).toEqual({
        operation: "approve",
        outcome: "telegram",
      });
      clean([answer, journal], fake);
    }),
);

posix(
  "approve: a request no longer there writes nothing; one Hermes approved and the allowlist does not name is offered and completed without a second approval",
  () =>
    within(async ({ fake, core, owe }) => {
      await core.connect(token);
      owe(false);
      fake.state.telegram.runtime = "connected";
      fake.telegramMessage(person, "jana_s");
      const read = await core.read();
      const handle =
        read.state === "waiting" ? (read.requests?.[0]?.request as string) : "";
      // It expired meanwhile.
      fake.state.telegram.pending = [];
      fake.requests.length = 0;
      expect(await core.approve(handle)).toEqual({
        kind: "blocked",
        reason: "request-gone",
      });
      expect(
        fake.requests.filter((request) => request.method !== "GET"),
      ).toEqual([]);
      expect(await core.approve("f".repeat(32))).toEqual({
        kind: "blocked",
        reason: "request-gone",
      });
      // Approved by Hermes before (a reconnect, or a terminal), not allowed.
      fake.state.telegram.approved = [{ user_id: person, user_name: "jana_s" }];
      const again = await core.read();
      expect(again).toMatchObject({
        state: "waiting",
        requests: [{ name: "jana_s" }],
      });
      fake.requests.length = 0;
      const answer = await core.approve(
        again.state === "waiting"
          ? (again.requests?.[0]?.request as string)
          : "",
      );
      expect(answer).toMatchObject({ kind: "telegram", state: "connected" });
      expect(
        fake.requests
          .filter((request) => request.method !== "GET")
          .map((request) => request.path),
      ).toEqual(["/api/env", "/api/messaging/platforms/telegram"]);
      expect(fake.state.telegram.allowed).toBe(person);
      expect(fake.state.telegram.home).toBe(person);
    }),
);

posix(
  "approve: a write that fails halfway claims nothing; the account stays offered, and Ano again finishes it without a second approval",
  () =>
    within(async ({ fake, core, owe }) => {
      await core.connect(token);
      owe(false);
      fake.state.telegram.runtime = "connected";
      const mine = fake.telegramMessage(person, "jana_s");
      if (mine === null) throw new Error("Hermes recorded the request");
      const offered = async () => {
        const read = await core.read();
        expect(read).toMatchObject({
          state: "waiting",
          requests: [{ name: "jana_s" }],
        });
        return read.state === "waiting"
          ? (read.requests?.[0]?.request as string)
          : "";
      };
      const refused = { kind: "failed", reason: "failed" } as const;
      // The home channel: nothing written at all.
      fake.state.http = failing("PUT", "/api/env");
      expect(await core.approve(await offered())).toEqual(refused);
      expect(fake.state.telegram).toMatchObject({ allowed: "", home: null });
      expect(
        fake.state.telegram.pending.map((entry) => entry.request_id),
      ).toEqual([mine]);
      // Hermes's approval: the home channel is there, the allowlist is not.
      fake.state.http = failing("POST", "/api/pairing/approve");
      expect(await core.approve(await offered())).toEqual(refused);
      expect(fake.state.telegram).toMatchObject({ allowed: "", home: person });
      // The allowlist: Hermes approved the account, which stays offered.
      fake.state.http = failing("PUT", "/api/messaging/platforms/telegram");
      expect(await core.approve(await offered())).toEqual(refused);
      expect(fake.state.telegram.pending).toEqual([]);
      expect(fake.state.telegram.approved.map((user) => user.user_id)).toEqual([
        person,
      ]);
      expect(fake.state.telegram.allowed).toBe("");
      // The gateway gone at the allowlist: the same.
      fake.state.http = (request) =>
        request.method === "PUT" &&
        request.path === "/api/messaging/platforms/telegram"
          ? Response.json(
              { error: "gateway_not_ready", state: "draining" },
              { status: 503 },
            )
          : undefined;
      expect(await core.approve(await offered())).toEqual({
        kind: "unavailable",
        reason: "draining",
      });
      // Ano again: the home channel and the allowlist, no second approval.
      fake.state.http = undefined;
      const handle = await offered();
      fake.requests.length = 0;
      expect(await core.approve(handle)).toEqual({
        kind: "telegram",
        state: "connected",
        bot: "rex_buddy_bot",
      });
      expect(
        writesOf(fake).map(([method, path]) => `${method} ${path}`),
      ).toEqual(["PUT /api/env", "PUT /api/messaging/platforms/telegram"]);
      expect(fake.state.telegram).toMatchObject({
        allowed: person,
        home: person,
      });
    }),
);

posix(
  "approve: while the restart the last connect owes is not done, Ano writes nothing and answers the state as it is, Připojuje se…; after the restart it goes through",
  () =>
    within(async ({ fake, core, owe, journal }) => {
      await core.connect(token);
      owe(false);
      fake.state.telegram.runtime = "connected";
      const mine = fake.telegramMessage(person, "jana_s");
      if (mine === null) throw new Error("Hermes recorded the request");
      const read = await core.read();
      const handle =
        read.state === "waiting" ? (read.requests?.[0]?.request as string) : "";
      expect(handle).toMatch(/^[0-9a-f]{32}$/);
      // Připojit again (another tab): a restart is owed, and a page from
      // before still offers Ano.
      await core.connect(token);
      fake.requests.length = 0;
      expect(await core.approve(handle)).toMatchObject({
        kind: "telegram",
        state: "starting",
        bot: "rex_buddy_bot",
        pending: true,
      });
      expect(writesOf(fake)).toEqual([]);
      expect(fake.state.telegram).toMatchObject({ allowed: "", home: null });
      expect(
        fake.state.telegram.pending.map((entry) => entry.request_id),
      ).toEqual([mine]);
      expect(journal.at(-1)).toEqual({
        operation: "approve",
        outcome: "pending",
        reason: "restart-owed",
      });
      // The restart is done: a new gateway, and Ano goes through.
      owe(false);
      fake.restart();
      expect(await core.approve(handle)).toEqual({
        kind: "telegram",
        state: "connected",
        bot: "rex_buddy_bot",
      });
      expect(
        writesOf(fake).map(([method, path]) => `${method} ${path}`),
      ).toEqual([
        "PUT /api/env",
        "POST /api/pairing/approve",
        "PUT /api/messaging/platforms/telegram",
      ]);
      expect(fake.state.telegram).toMatchObject({
        allowed: person,
        home: person,
      });
    }),
);

posix(
  "approve: a request that expires between the list and the approval leaves nothing to approve; the account is allowed",
  () =>
    within(async ({ fake, core, owe }) => {
      await core.connect(token);
      owe(false);
      fake.state.telegram.runtime = "connected";
      fake.telegramMessage(person, "jana_s");
      const read = await core.read();
      const handle =
        read.state === "waiting" ? (read.requests?.[0]?.request as string) : "";
      // Hermes's hour ends as the person presses Ano.
      fake.state.http = (request) => {
        if (request.method !== "POST") return undefined;
        fake.state.telegram.pending = [];
        return undefined;
      };
      expect(await core.approve(handle)).toEqual({
        kind: "telegram",
        state: "connected",
        bot: "rex_buddy_bot",
      });
      expect(fake.state.telegram).toMatchObject({
        allowed: person,
        home: person,
        approved: [],
      });
    }),
);

/** Until `done`, at most two seconds. */
async function until(done: () => boolean) {
  for (let wait = 0; wait < 400 && !done(); wait += 1) await Bun.sleep(5);
  expect(done()).toBe(true);
}

/** Connected as the installer leaves it: the person allowed, their chat the
 * home channel. */
async function connected(fixture: Fixture) {
  const { fake, core, owe } = fixture;
  await core.connect(token);
  owe(false);
  Object.assign(fake.state.telegram, {
    runtime: "connected",
    allowed: person,
    home: person,
  });
}

/** The DELETEs that reached Hermes. */
const deletesOf = (fake: FakeHermesGateway) =>
  fake.requests.filter((request) => request.method === "DELETE");

/** The person connects another bot; the restart that connect owes is made
 * (a new gateway: Hermes serves these calls in the gateway's own process,
 * F63); the stranger's account presses Start and the person approves it. */
async function reconnectAndApprove(fixture: Fixture) {
  const { fake, core, owe } = fixture;
  await core.connect(otherToken);
  owe(false);
  fake.restart();
  fake.state.telegram.runtime = "connected";
  fake.telegramMessage(stranger, "jana_s");
  const read = await core.read();
  return core.approve(
    read.state === "waiting" ? (read.requests?.[0]?.request as string) : "",
  );
}

posix(
  "disconnect: its home-channel DELETE, held by Hermes past the client's timeout, is asked once and after the restart is owed; no reading asks again, and the account approved after the reconnect's restart keeps its home channel",
  () =>
    within(
      async (fixture) => {
        const { fake, core, changes, journal } = fixture;
        await connected(fixture);
        const before = changes();
        // Hermes holds the DELETE. It runs in the gateway that took it, and
        // a request of a gateway that has stopped never runs after.
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let ran = false;
        fake.state.http = async (request) => {
          if (request.method !== "DELETE") return undefined;
          const on = fake.state.instance;
          await held;
          if (fake.state.instance !== on)
            return Response.json(
              { error: "gateway_not_ready", state: "draining" },
              { status: 503 },
            );
          ran = true;
          return undefined;
        };
        const disconnecting = core.disconnect();
        await until(() => deletesOf(fake).length === 1);
        // Before Hermes answers the DELETE, the restart that takes the bot
        // out is already owed, and the bot's record is gone.
        expect(changes()).toBe(before + 1);
        await expect(lstat(telegramBotPath(fake.userHome))).rejects.toThrow();
        // The client gives up on it; the disconnect answers all the same.
        expect(await disconnecting).toEqual({
          kind: "telegram",
          state: "none",
          pending: true,
        });
        expect(journal.slice(-2)).toEqual([
          { operation: "home-channel", outcome: "left", reason: "timeout" },
          { operation: "disconnect", outcome: "telegram" },
        ]);
        expect(fake.state.telegram).toMatchObject({
          token: null,
          enabled: false,
          allowed: "",
          home: person,
        });
        // Readings while it is off ask nothing of Hermes's files.
        for (let reading = 0; reading < 3; reading += 1)
          expect(await core.read()).toMatchObject({ state: "none" });
        await Bun.sleep(50);
        expect(deletesOf(fake)).toHaveLength(1);
        // The person connects another bot, and after its restart approves
        // another account.
        expect(await reconnectAndApprove(fixture)).toEqual({
          kind: "telegram",
          state: "connected",
          bot: "rex_buddy_bot",
        });
        expect(fake.state.telegram).toMatchObject({
          allowed: stranger,
          home: stranger,
        });
        // The held DELETE is released: its gateway has stopped, and the new
        // account's home channel stays.
        release();
        await Bun.sleep(50);
        expect(ran).toBe(false);
        for (let reading = 0; reading < 3; reading += 1)
          expect(await core.read()).toMatchObject({ state: "connected" });
        await Bun.sleep(50);
        expect(fake.state.telegram.home).toBe(stranger);
        expect(deletesOf(fake)).toHaveLength(1);
      },
      undefined,
      { httpMs: 1_000 },
    ),
);

posix(
  "disconnect: a home channel Hermes refuses to remove stays; no reading asks again, with or without a token saved elsewhere, and the next approval writes its own over it",
  () =>
    within(async (fixture) => {
      const { fake, core, changes, journal } = fixture;
      await connected(fixture);
      const before = changes();
      fake.state.http = failing("DELETE", "/api/env");
      expect(await core.disconnect()).toEqual({
        kind: "telegram",
        state: "none",
        pending: true,
      });
      expect(changes()).toBe(before + 1);
      expect(journal.slice(-2)).toEqual([
        { operation: "home-channel", outcome: "left", reason: "failed" },
        { operation: "disconnect", outcome: "telegram" },
      ]);
      expect(fake.state.telegram).toMatchObject({
        token: null,
        enabled: false,
        allowed: "",
        home: person,
      });
      fake.state.http = undefined;
      // Off; then a token saved elsewhere, switched off or on: no reading
      // asks Hermes to remove anything.
      expect(await core.read()).toMatchObject({ state: "none" });
      fake.state.telegram.token = otherToken;
      expect(await core.read()).toMatchObject({ state: "none" });
      fake.state.telegram.token = null;
      fake.state.telegram.enabled = true;
      expect(await core.read()).toMatchObject({ state: "none" });
      fake.state.telegram.enabled = false;
      await Bun.sleep(50);
      expect(deletesOf(fake)).toHaveLength(1);
      expect(fake.state.telegram.home).toBe(person);
      // Connected again and approved: its own home channel over the old one.
      await reconnectAndApprove(fixture);
      expect(fake.state.telegram).toMatchObject({
        allowed: stranger,
        home: stranger,
      });
      expect(deletesOf(fake)).toHaveLength(1);
    }),
);

posix(
  "disconnect: off, the token and the allowlist cleared by Hermes's writer, no home channel left, the bot's record gone, one restart asked",
  () =>
    within(async ({ fake, core, owe, changes, journal }) => {
      await core.connect(token);
      owe(false);
      fake.state.telegram.runtime = "connected";
      fake.state.telegram.allowed = person;
      fake.state.telegram.home = person;
      fake.requests.length = 0;
      const answer = await core.disconnect();
      expect(
        fake.requests
          .filter((request) => request.method !== "GET")
          .map((request) => [
            request.method,
            request.path,
            JSON.parse(request.body),
          ]),
      ).toEqual([
        [
          "PUT",
          "/api/messaging/platforms/telegram",
          {
            enabled: false,
            clear_env: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"],
          },
        ],
        ["DELETE", "/api/env", { key: "TELEGRAM_HOME_CHANNEL" }],
      ]);
      expect(fake.state.telegram).toMatchObject({
        token: null,
        enabled: false,
        allowed: "",
        home: null,
      });
      expect(changes()).toBe(2);
      // It says so until the restart that takes it out.
      expect(answer).toEqual({
        kind: "telegram",
        state: "none",
        pending: true,
      });
      await expect(lstat(telegramBotPath(fake.userHome))).rejects.toThrow();
      // Without a home channel Hermes answers 404: still disconnected.
      expect(await core.disconnect()).toMatchObject({
        kind: "telegram",
        state: "none",
      });
      clean([answer, journal], fake);
    }),
);

posix(
  "one operation at a time: a connect and an approval asked together run one after the other",
  () =>
    within(async ({ fake, core, owe }) => {
      fake.state.telegram.runtime = "connected";
      const order: string[] = [];
      fake.state.http = async (request) => {
        if (request.method !== "GET") order.push(request.path);
        return undefined;
      };
      await Promise.all([core.connect(token), core.disconnect()]);
      owe(false);
      expect(order).toEqual([
        "/api/messaging/platforms/telegram",
        "/api/config",
        "/api/messaging/platforms/telegram",
        "/api/env",
      ]);
    }),
);

// ---- Buddy's words to an account his bot does not know --------------------------

/** His words as the Launchpad renders them (buddy-view.ts), in Czech. */
const wordsVy =
  "Dobrý den, tady Rex. Potvrďte prosím v Lazuriu, že jste to vy, a pak mi napište znovu.";
const wordsTy =
  "Ahoj, tady Rex. Potvrď prosím v Lazuriu, že jsi to ty, a pak mi napiš znovu.";
const bodyOf = (text: string) => ({
  config: { gateway: { unauthorized_dm_pairing_message: text } },
});

posix(
  "his words: where Hermes lists the capability, the connect writes them through its config writer, and the person's Start gets them instead of a command",
  () =>
    within(
      async ({ fake, core, owe, journal }) => {
        const answer = await core.connect(token);
        expect(writesOf(fake)).toEqual([
          [
            "PUT",
            "/api/messaging/platforms/telegram",
            { env: { TELEGRAM_BOT_TOKEN: token }, enabled: true },
          ],
          ["PUT", "/api/config", { config: telegramQuietConfig }],
          ["PUT", "/api/config", bodyOf(wordsVy)],
        ]);
        expect(pairingMessage).toEqual({
          capability: "lazurio-pairing-message-v1",
          key: "unauthorized_dm_pairing_message",
        });
        // Beside the quiet keys, in the gateway's own section.
        expect(fake.state.telegram.config).toMatchObject({
          gateway: { unauthorized_dm_pairing_message: wordsVy },
          compression: { codex_gpt55_autoraise_notice: false },
        });
        expect(answer).toMatchObject({ kind: "telegram", state: "starting" });
        expect(journal).toEqual([
          { operation: "pairing-text", outcome: "written" },
          { operation: "connect", outcome: "telegram" },
        ]);
        // The journal names no word of his.
        expect(JSON.stringify(journal)).not.toContain("Rex");
        owe(false);
        fake.state.telegram.runtime = "connected";
        fake.telegramMessage(person, "jana_s");
        expect(fake.state.telegram.replies).toEqual([wordsVy]);
      },
      undefined,
      { fake: { pairingMessage: true }, pairingText: async () => wordsVy },
    ),
);

posix(
  "his words: an older Hermes is never asked and keeps its own reply, and one that refuses them, or words that cannot be read, change nothing else; the connect works the same",
  async () => {
    const connects = async (
      fake: FakeHermesGateway,
      core: Fixture["core"],
      owe: Fixture["owe"],
    ) => {
      const answer = await core.connect(token);
      expect(answer).toMatchObject({ kind: "telegram", state: "starting" });
      expect(fake.state.telegram).toMatchObject({ token, enabled: true });
      owe(false);
      fake.state.telegram.runtime = "connected";
      fake.telegramMessage(person, "jana_s");
      // Hermes's own reply, with its code and its command.
      expect(fake.state.telegram.replies).toHaveLength(1);
      expect(fake.state.telegram.replies[0]).toContain(
        "hermes pairing approve telegram",
      );
    };
    // v0.22.4-lazurio.3: no capability, so no write at all.
    await within(
      async ({ fake, core, owe, journal }) => {
        await connects(fake, core, owe);
        expect(writesOf(fake).map(([, path]) => path)).toEqual([
          "/api/messaging/platforms/telegram",
          "/api/config",
        ]);
        expect(journal).toEqual([
          { operation: "pairing-text", outcome: "outdated" },
          { operation: "connect", outcome: "telegram" },
        ]);
      },
      undefined,
      { pairingText: async () => wordsVy },
    );
    // A Hermes that refuses the write.
    await within(
      async ({ fake, core, owe, journal }) => {
        fake.state.http = (request) =>
          request.method === "PUT" && request.body.includes(pairingMessage.key)
            ? Response.json(
                { detail: "Internal server error" },
                { status: 500 },
              )
            : undefined;
        await connects(fake, core, owe);
        expect(journal).toEqual([
          { operation: "pairing-text", outcome: "failed" },
          { operation: "connect", outcome: "telegram" },
        ]);
      },
      undefined,
      { fake: { pairingMessage: true }, pairingText: async () => wordsVy },
    );
    // Words that cannot be read: nothing written.
    await within(
      async ({ fake, core, owe, journal }) => {
        await connects(fake, core, owe);
        expect(writesOf(fake)).toHaveLength(2);
        expect(journal).toEqual([
          { operation: "pairing-text", outcome: "unknown" },
          { operation: "connect", outcome: "telegram" },
        ]);
      },
      undefined,
      {
        fake: { pairingMessage: true },
        pairingText: async () => {
          throw new Error("no Folder");
        },
      },
    );
  },
);

posix(
  "his words after a change of his persona: written again only while his bot is connected from here, and only when they changed",
  () => {
    let words = wordsVy;
    return within(
      async ({ fake, core, owe, journal }) => {
        // Not connected from here: nothing.
        await core.persona();
        expect(fake.requests).toHaveLength(0);
        await core.connect(token);
        owe(false);
        fake.requests.length = 0;
        journal.length = 0;
        // The same words: nothing.
        await core.persona();
        expect(fake.requests).toHaveLength(0);
        words = wordsTy;
        await core.persona();
        expect(writesOf(fake)).toEqual([
          ["PUT", "/api/config", bodyOf(wordsTy)],
        ]);
        expect(journal).toEqual([
          { operation: "pairing-text", outcome: "written" },
        ]);
        fake.state.telegram.runtime = "connected";
        fake.telegramMessage(person, "jana_s");
        expect(fake.state.telegram.replies).toEqual([wordsTy]);
        // Disconnected: his bot answers nobody, nothing is written.
        await core.disconnect();
        fake.requests.length = 0;
        words = wordsVy;
        await core.persona();
        expect(writesOf(fake)).toEqual([]);
      },
      undefined,
      { fake: { pairingMessage: true }, pairingText: async () => words },
    );
  },
);

// ---- Telegram's own word on a token -------------------------------------------

posix(
  "getMe: a bot and its name, a token Telegram does not know, and nothing usable as unreachable; the token only in the path",
  async () => {
    const seen: string[] = [];
    let answer: () => Response = () =>
      Response.json({
        ok: true,
        result: { id: 7777777777, is_bot: true, username: "rex_buddy_bot" },
      });
    const telegram = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname}${url.search}`);
        for (const [name, value] of request.headers)
          if (name !== "host") expect(value).not.toContain(token);
        // Where a redirect would lead: a bot, which must never count.
        if (url.pathname === "/elsewhere")
          return Response.json({
            ok: true,
            result: { is_bot: true, username: "other_buddy_bot" },
          });
        return answer();
      },
    });
    try {
      const check = telegramBotChecker({
        origin: `http://127.0.0.1:${telegram.port}`,
        timeoutMs: 1_000,
      });
      expect(await check(token)).toEqual({
        kind: "bot",
        username: "rex_buddy_bot",
      });
      expect(seen).toEqual([`GET /bot${token}/getMe`]);
      const cases: readonly (readonly [() => Response, string])[] = [
        [
          () =>
            Response.json(
              { ok: false, error_code: 401, description: "Unauthorized" },
              { status: 401 },
            ),
          "refused",
        ],
        [
          () =>
            Response.json(
              { ok: false, error_code: 404, description: "Not Found" },
              { status: 404 },
            ),
          "refused",
        ],
        [
          () =>
            Response.json({
              ok: true,
              result: { is_bot: false, username: "x" },
            }),
          "refused",
        ],
        // Telegram's flood limit, its own failure, an answer of no shape, a
        // redirect, a name of no shape: not a refusal of the token.
        [
          () =>
            Response.json(
              { ok: false, error_code: 429, parameters: { retry_after: 9 } },
              { status: 429 },
            ),
          "unreachable",
        ],
        [() => new Response("oops", { status: 500 }), "unreachable"],
        [() => new Response("not json"), "unreachable"],
        [
          () =>
            new Response(null, {
              status: 302,
              headers: { location: "/elsewhere" },
            }),
          "unreachable",
        ],
        [
          () =>
            Response.json({
              ok: true,
              result: { is_bot: true, username: "x!" },
            }),
          "unreachable",
        ],
        [
          () => new Response("x".repeat(70 * 1024), { status: 200 }),
          "unreachable",
        ],
      ];
      for (const [reply, kind] of cases) {
        answer = reply;
        expect((await check(token)).kind as string).toBe(kind);
      }
      // Not a token's shape: Telegram is not asked.
      seen.length = 0;
      expect(await check("123:short")).toEqual({ kind: "refused" });
      expect(seen).toEqual([]);
      // No answer in time.
      answer = () => {
        throw new Error("never");
      };
      const slow = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Promise<Response>(() => {}),
      });
      try {
        expect(
          await telegramBotChecker({
            origin: `http://127.0.0.1:${slow.port}`,
            timeoutMs: 200,
          })(token),
        ).toEqual({ kind: "unreachable" });
      } finally {
        slow.stop(true);
      }
      // Nobody listening.
      expect(
        await telegramBotChecker({
          origin: "http://127.0.0.1:9",
          timeoutMs: 500,
        })(token),
      ).toEqual({ kind: "unreachable" });
    } finally {
      telegram.stop(true);
    }
  },
);

posix(
  "before anything was asked of it, Hermes that cannot be asked claims nothing",
  () =>
    within(async ({ fake, core }) => {
      // Nothing asked yet: no claim.
      await fake.stop();
      expect(await core.read()).toEqual({ state: "unknown" });
    }),
);

posix(
  "after a connect or a disconnect, a gateway restarting reads as Připojuje se… or as off, with its pending line only while owed",
  async () => {
    const fake = await fakeHermesGateway();
    let owed = false;
    let recently = false;
    const core = createBuddyTelegram({
      gateway: createHermesGateway({ home: fake.userHome }),
      home: fake.userHome,
      owed: () => owed,
      restartedRecently: () => recently,
      changed: async () => {
        owed = true;
      },
      checkBot: async () => ({ kind: "bot", username: "rex_buddy_bot" }),
    });
    try {
      await core.connect(token);
      fake.state.http = () =>
        Response.json(
          { error: "gateway_not_ready", state: "draining" },
          { status: 503 },
        );
      expect(await core.read()).toEqual({ state: "starting", pending: true });
      owed = false;
      recently = true;
      expect(await core.read()).toEqual({ state: "starting" });
      recently = false;
      expect(await core.read()).toEqual({ state: "unknown" });
      fake.state.http = undefined;
      await core.disconnect();
      fake.state.http = () =>
        Response.json(
          { error: "gateway_not_ready", state: "starting" },
          { status: 503 },
        );
      expect(await core.read()).toEqual({ state: "none", pending: true });
    } finally {
      await fake.close();
    }
  },
);
