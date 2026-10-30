import { expect, test } from "bun:test";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import {
  createHermesGateway,
  type GatewayResult,
  gatewayBodyBytesMax,
  gatewayBodyCalls,
  oauthCancelContract,
} from "../src/buddy/hermes-gateway";
import {
  type FakeHermesGateway,
  fakeHermesGateway,
  recorded,
} from "./fixtures/fake-hermes-gateway";

// Decision F63: the Launchpad as a local client of Buddy's Hermes gateway,
// against a stand-in that answers with the shapes recorded from
// Lazurio/hermes-agent v0.22.4-lazurio.1 (tests/fixtures). The control socket
// and its pointer only as Desktop and Hermes's own discovery accept them, one
// ticket per call spent once, exactly the headers Hermes's native grant takes
// (no Origin, no profile query), never through a proxy, and every failure a
// closed reason.

const posix = test.skipIf(process.platform === "win32");

async function within(
  options: Parameters<typeof fakeHermesGateway>[0],
  body: (fake: FakeHermesGateway) => Promise<void>,
) {
  const fake = await fakeHermesGateway(options);
  try {
    await body(fake);
  } finally {
    await fake.close();
  }
}

const client = (fake: FakeHermesGateway, extra: object = {}) =>
  createHermesGateway({ home: fake.userHome, ...extra });

const verbs = (fake: FakeHermesGateway) =>
  fake.control.map((request) => request.value?.verb);

const failure = (reason: string): GatewayResult<never> => ({
  ok: false,
  reason: reason as never,
});
/** A failure after the request was handed to Hermes: it may still run. */
const uncertain = (reason: string): GatewayResult<never> => ({
  ok: false,
  reason: reason as never,
  uncertain: true,
});

posix(
  "identify: the recorded answer of a ready gateway serving exactly this home, its socket in the home",
  () =>
    within({}, async (fake) => {
      expect(await client(fake).identify()).toEqual({
        ok: true,
        value: {
          home: fake.home,
          socket: join(fake.home, "gateway.sock"),
          instanceId: recorded.control.identify.result.instance_id,
          apiOrigin: fake.apiOrigin,
          contract: true,
          capabilities: [
            "session-authority-v1",
            "durable-admission-v1",
            "event-replay-v1",
            oauthCancelContract.value,
          ],
        },
      });
      expect(fake.control.map((request) => request.line)).toEqual([
        '{"protocol":1,"verb":"identify","id":1}',
      ]);
    }),
);

posix(
  "the cancellation contract: read from identify, and a call that requires it never reaches a gateway without it",
  async () => {
    // The recorded tag advertises none.
    await within({ contract: false }, async (fake) => {
      const identified = await client(fake).identify();
      expect(identified.ok && identified.value.contract).toBe(false);
      expect(
        await client(fake).request(
          "POST",
          "/api/providers/oauth/openai-codex/start",
          { requireContract: true },
        ),
      ).toEqual(failure("outdated"));
      // Asked who it is, then nothing: no ticket, no call.
      expect(verbs(fake)).toEqual(["identify", "identify"]);
      expect(fake.requests).toHaveLength(0);
      // A call that does not require it goes ahead, and says so.
      const read = await client(fake).request("GET", "/api/providers/oauth");
      expect(read.ok && read.value.contract).toBe(false);
    });
    await within({}, async (fake) => {
      const answer = await client(fake).request(
        "POST",
        "/api/providers/oauth/openai-codex/start",
        { requireContract: true },
      );
      expect(answer.ok && answer.value.contract).toBe(true);
      // The member may hold the value or list it; only that value counts.
      // (`capabilities` must also keep `session-authority-v1`.)
      const { member, value } = oauthCancelContract;
      const cases: readonly (readonly [unknown, boolean])[] =
        member === "capabilities"
          ? [
              [[value], true],
              [[`${value}-draft`], false],
              [[], false],
            ]
          : [
              [value, true],
              [[value], true],
              [`${value}-draft`, false],
              [undefined, false],
              [1, false],
            ];
      for (const [advertised, expected] of cases) {
        fake.state.identify = (identify) => {
          const result = identify.result as Record<string, unknown>;
          if (member === "capabilities")
            result.capabilities = [
              "session-authority-v1",
              ...(advertised as readonly string[]),
            ];
          else if (advertised === undefined) delete result[member];
          else result[member] = advertised;
          return identify;
        };
        const identified = await client(fake).identify();
        expect(identified.ok && identified.value.contract).toBe(expected);
      }
    });
  },
);

posix(
  "a capability a call names: read from identify, and the call never reaches a gateway that does not list it",
  async () => {
    const capability = "lazurio-pairing-message-v1";
    const write = {
      body: { config: { gateway: { unauthorized_dm_pairing_message: "x" } } },
      capability,
    };
    // v0.22.4-lazurio.3 lists none.
    await within({}, async (fake) => {
      const identified = await client(fake).identify();
      expect(identified.ok && identified.value.capabilities).not.toContain(
        capability,
      );
      expect(await client(fake).request("PUT", "/api/config", write)).toEqual(
        failure("outdated"),
      );
      // Asked who it is, then nothing: no ticket, no call.
      expect(verbs(fake)).toEqual(["identify", "identify"]);
      expect(fake.requests).toHaveLength(0);
    });
    await within({ pairingMessage: true }, async (fake) => {
      const answer = await client(fake).request("PUT", "/api/config", write);
      expect(answer.ok && answer.value.status).toBe(200);
      expect(fake.requests.map((request) => JSON.parse(request.body))).toEqual([
        write.body,
      ]);
      // Only text counts, and only that exact name.
      fake.state.identify = (identify) => {
        const result = identify.result as Record<string, unknown>;
        result.capabilities = [
          "session-authority-v1",
          1,
          null,
          { capability },
          `${capability}-draft`,
        ];
        return identify;
      };
      const identified = await client(fake).identify();
      expect(identified.ok && identified.value.capabilities).toEqual([
        "session-authority-v1",
        `${capability}-draft`,
      ]);
      fake.requests.length = 0;
      expect(await client(fake).request("PUT", "/api/config", write)).toEqual(
        failure("outdated"),
      );
      expect(fake.requests).toHaveLength(0);
    });
  },
);

posix(
  "a ticket of its own for every call, each spent once, with exactly Hermes's native grant: no Origin, no profile, no proxy",
  () =>
    within({ signedIn: true }, async (fake) => {
      const gateway = client(fake);
      for (const [method, path] of [
        ["GET", "/api/providers/oauth"],
        ["POST", "/api/providers/oauth/openai-codex/start"],
        ["DELETE", "/api/providers/oauth/openai-codex"],
      ] as const) {
        const answer = await gateway.request(method, path);
        expect(answer.ok).toBe(true);
      }
      expect(verbs(fake)).toEqual([
        "identify",
        "session-ticket",
        "identify",
        "session-ticket",
        "identify",
        "session-ticket",
      ]);
      for (const request of fake.control.filter(
        (entry) => entry.value?.verb === "session-ticket",
      ))
        expect(request.value).toEqual({
          protocol: 1,
          id: 1,
          verb: "session-ticket",
          params: {
            profile_id: fake.home,
            instance_id: recorded.control.identify.result.instance_id,
            purpose: "native-http",
          },
        });
      // Three tickets, three redemptions, none twice, none left over.
      expect(fake.spent).toHaveLength(3);
      expect(new Set(fake.spent).size).toBe(3);
      expect(fake.minted.size).toBe(0);
      expect(fake.requests.map((request) => request.method)).toEqual([
        "GET",
        "POST",
        "DELETE",
      ]);
      for (const [index, request] of fake.requests.entries()) {
        expect(request.query).toBe("");
        expect(request.peer).toBe("127.0.0.1");
        expect(request.headers["x-hermes-gateway-ticket"]).toBe(
          fake.spent[index] as string,
        );
        expect(request.headers.host).toBe(new URL(fake.apiOrigin).host);
        for (const name of [
          "origin",
          "referer",
          "cookie",
          "authorization",
          "x-hermes-session-token",
          "sec-fetch-site",
        ])
          expect(request.headers[name]).toBeUndefined();
      }
    }),
);

posix(
  "HTTP_PROXY never sees a ticket: the call goes to the loopback listener itself",
  () =>
    within({}, async (fake) => {
      const proxied: string[] = [];
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          proxied.push(request.headers.get("x-hermes-gateway-ticket") ?? "");
          return Response.json({ providers: [] });
        },
      });
      try {
        // In a process of its own: Bun's fetch keeps the first proxy it saw
        // for the rest of the process, which would reach every later test.
        const module = join(import.meta.dir, "../src/buddy/hermes-gateway.ts");
        const child = Bun.spawn(
          [
            process.execPath,
            "-e",
            `const { createHermesGateway } = await import(${JSON.stringify(module)});
             const answer = await createHermesGateway({ home: process.argv.at(-1) })
               .request("GET", "/api/providers/oauth");
             console.log(JSON.stringify(answer.ok ? answer.value.status : answer));`,
            fake.userHome,
          ],
          {
            env: {
              ...process.env,
              HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
              http_proxy: `http://127.0.0.1:${proxy.port}`,
              NO_PROXY: "",
              no_proxy: "",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(await new Response(child.stdout).text()).toBe("200\n");
        expect(await child.exited).toBe(0);
        expect(proxied).toEqual([]);
        expect(fake.requests).toHaveLength(1);
        expect(fake.spent).toHaveLength(1);
      } finally {
        proxy.stop(true);
      }
    }),
);

posix(
  "a refused ticket is replaced once, then the answer is refused; nothing else is asked again, a write least of all",
  () =>
    within({}, async (fake) => {
      // The socket refuses the ticket (a gateway that restarted between
      // identify and the ticket): one more round, then `refused`.
      fake.state.ticket = () => recorded.control.ticketStaleInstance;
      expect(await client(fake).request("GET", "/api/providers/oauth")).toEqual(
        failure("refused"),
      );
      expect(verbs(fake)).toEqual([
        "identify",
        "session-ticket",
        "identify",
        "session-ticket",
      ]);
      expect(fake.requests).toHaveLength(0);
      fake.state.ticket = undefined;
      fake.control.length = 0;

      // The API refuses one ticket (401, nothing ran): a new ticket, once.
      let refusals = 1;
      fake.state.http = () =>
        refusals-- > 0
          ? Response.json(recorded.http.unauthorized.body, { status: 401 })
          : undefined;
      const answer = await client(fake).request(
        "POST",
        "/api/providers/oauth/openai-codex/start",
      );
      expect(answer.ok && answer.value.status).toBe(200);
      expect(fake.requests.map((request) => request.method)).toEqual([
        "POST",
        "POST",
      ]);
      expect(fake.spent).toHaveLength(2);

      // Refused again: `refused` after exactly two calls.
      fake.requests.length = 0;
      fake.state.http = () =>
        Response.json(recorded.http.unauthorized.body, { status: 401 });
      expect(await client(fake).request("GET", "/api/providers/oauth")).toEqual(
        failure("refused"),
      );
      expect(fake.requests).toHaveLength(2);

      // Any other answer of a write is the answer: never sent twice.
      fake.requests.length = 0;
      fake.state.http = () =>
        Response.json(recorded.derived.startFailed.body, { status: 500 });
      const failed = await client(fake).request(
        "POST",
        "/api/providers/oauth/openai-codex/start",
      );
      expect(failed).toEqual({
        ok: true,
        value: {
          status: 500,
          body: recorded.derived.startFailed.body,
          instanceId: recorded.control.identify.result.instance_id,
          contract: true,
        },
      });
      expect(fake.requests).toHaveLength(1);
      // Each answer names the instance that gave it; a restart is another.
      fake.state.http = undefined;
      fake.restart();
      const after = await client(fake).request("GET", "/api/providers/oauth");
      expect(after.ok && after.value.instanceId).toBe(fake.state.instance);
      expect(fake.state.instance).not.toBe(
        recorded.control.identify.result.instance_id,
      );

      // The listener stopped taking requests after identify.
      fake.state.http = () =>
        Response.json(recorded.derived.notReady.body, { status: 503 });
      expect(await client(fake).request("GET", "/api/providers/oauth")).toEqual(
        failure("draining"),
      );
      fake.state.http = () =>
        Response.json(
          { error: "gateway_not_ready", state: "starting" },
          { status: 503 },
        );
      expect(await client(fake).request("GET", "/api/providers/oauth")).toEqual(
        failure("not-ready"),
      );
    }),
);

posix(
  "a ticket answer is taken only for this instance and this home, of a ticket's shape",
  () =>
    within({}, async (fake) => {
      const grant = (change: Record<string, unknown>) => () => ({
        ...recorded.control.ticket,
        result: {
          ...recorded.control.ticket.result,
          profile_id: fake.home,
          instance_id: recorded.control.identify.result.instance_id,
          ...change,
        },
      });
      for (const replace of [
        grant({ instance_id: "another-instance" }),
        grant({ profile_id: `${fake.home}/profiles/other` }),
        grant({ ticket: "short" }),
        grant({ ticket: "x".repeat(300) }),
        grant({ ticket: "has space in it 000000000000" }),
        () => ({ ...recorded.control.ticket, id: 2 }),
        () => ({ ...recorded.control.ticket, protocol: 2 }),
        () => ({ raw: "[]" }),
      ]) {
        fake.state.ticket = replace as never;
        expect(
          await client(fake).request("GET", "/api/providers/oauth"),
        ).toEqual(failure("invalid-answer"));
      }
      expect(fake.requests).toHaveLength(0);
    }),
);

posix(
  "an API origin other than exactly http://127.0.0.1:<port> or http://[::1]:<port> is refused before any ticket is minted",
  () =>
    within({}, async (fake) => {
      for (const origin of [
        "http://10.0.0.5:8080",
        "http://localhost:4123",
        "https://127.0.0.1:4123",
        "http://127.0.0.1:4123/",
        "http://127.0.0.1:4123/api",
        "http://127.0.0.1",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://user@127.0.0.1:4123",
        "http://127.0.0.2:4123",
        "http://[::2]:4123",
        "http://0.0.0.0:4123",
        "http://launchpad.example.lazurio.io:443",
      ]) {
        fake.state.identify = (answer) => {
          (answer.result as Record<string, unknown>).api_origin = origin;
          return answer;
        };
        expect(
          await client(fake).request("GET", "/api/providers/oauth"),
        ).toEqual(failure("invalid-answer"));
      }
      expect(verbs(fake).every((verb) => verb === "identify")).toBe(true);
      expect(fake.requests).toHaveLength(0);
      fake.state.identify = (answer) => {
        (answer.result as Record<string, unknown>).api_origin =
          "http://[::1]:4123";
        return answer;
      };
      const ipv6 = await client(fake).identify();
      expect(ipv6.ok && ipv6.value.apiOrigin).toBe("http://[::1]:4123");
    }),
);

posix(
  "identify: starting, draining, another home, another protocol, no session authority, a broken answer",
  () =>
    within({}, async (fake) => {
      const gateway = client(fake, { controlMs: 300 });
      const answerWith =
        (change: (result: Record<string, unknown>) => void) =>
        (answer: Record<string, unknown>) => {
          change(answer.result as Record<string, unknown>);
          return answer;
        };
      const recordedAnswer = (answer: object) => () =>
        JSON.parse(
          JSON.stringify(answer)
            .replaceAll("{{home}}", fake.home)
            .replaceAll("{{apiOrigin}}", fake.apiOrigin),
        );
      const cases: [
        (answer: Record<string, unknown>) => unknown,
        GatewayResult<never>,
      ][] = [
        [
          recordedAnswer(recorded.control.identifyStarting),
          failure("not-ready"),
        ],
        [
          recordedAnswer(recorded.control.identifyDraining),
          failure("draining"),
        ],
      ];
      cases.push(
        [
          answerWith((result) => {
            result.state = "failed";
          }),
          failure("not-ready"),
        ],
        [
          answerWith((result) => {
            result.served_profiles = [
              { profile_id: `${fake.home}-other`, home: `${fake.home}-other` },
            ];
          }),
          failure("invalid-answer"),
        ],
        [
          answerWith((result) => {
            result.served_profiles = [
              { profile_id: fake.home, home: fake.home },
              { profile_id: fake.home, home: fake.home },
            ];
          }),
          failure("invalid-answer"),
        ],
        [
          answerWith((result) => {
            result.runtime_protocol = 2;
          }),
          failure("invalid-answer"),
        ],
        [
          answerWith((result) => {
            result.capabilities = ["durable-admission-v1"];
          }),
          failure("invalid-answer"),
        ],
        [
          answerWith((result) => {
            result.authority_epoch = 0;
          }),
          failure("invalid-answer"),
        ],
        [
          answerWith((result) => {
            result.instance_id = "";
          }),
          failure("invalid-answer"),
        ],
        [(answer) => ({ ...answer, id: 2 }), failure("invalid-answer")],
        [
          () => ({ ok: false, error: "unknown verb: 'identify'", protocol: 1 }),
          failure("invalid-answer"),
        ],
        [() => ({ raw: "not json" }), failure("invalid-answer")],
        [() => "close", failure("invalid-answer")],
        [() => "hang", failure("timeout")],
      );
      for (const [replace, expected] of cases) {
        fake.state.identify = replace as never;
        expect(await gateway.identify()).toEqual(expected);
        expect(await gateway.request("GET", "/api/providers/oauth")).toEqual(
          expected,
        );
      }
      expect(fake.requests).toHaveLength(0);
      expect(verbs(fake).every((verb) => verb === "identify")).toBe(true);
    }),
);

posix(
  "the paths: a link, another account's, open to others or missing are refused before anything is sent",
  async () => {
    // The socket as a link to the real one.
    await within({}, async (fake) => {
      const real = join(fake.home, "real.sock");
      await rename(fake.socket, real);
      await symlink(real, fake.socket);
      expect(await client(fake).identify()).toEqual(failure("unsafe-path"));
      expect(fake.control).toHaveLength(0);
    });
    // Another account's home and socket.
    await within({}, async (fake) => {
      expect(
        await client(fake, { uid: (process.getuid?.() ?? 0) + 1 }).identify(),
      ).toEqual(failure("unsafe-path"));
      expect(fake.control).toHaveLength(0);
    });
    // The socket open to the group or to others.
    await within({}, async (fake) => {
      for (const mode of [0o660, 0o606, 0o640, 0o604]) {
        await chmod(fake.socket, mode);
        expect(await client(fake).identify()).toEqual(failure("unsafe-path"));
      }
      await chmod(fake.socket, 0o600);
      expect((await client(fake).identify()).ok).toBe(true);
      expect(fake.control).toHaveLength(1);
    });
    // The home: nobody else may write to it; reading and searching are the
    // operator's choice (HERMES_HOME_MODE 0750/0701), as in Desktop.
    await within({}, async (fake) => {
      for (const mode of [0o770, 0o702, 0o777, 0o730])
        await (async () => {
          await chmod(fake.home, mode);
          expect(await client(fake).identify()).toEqual(failure("unsafe-path"));
        })();
      expect(fake.control).toHaveLength(0);
      for (const mode of [0o700, 0o750, 0o755, 0o701]) {
        await chmod(fake.home, mode);
        expect((await client(fake).identify()).ok).toBe(true);
      }
    });
    // No home, a file for a home, no socket, a gateway that stopped.
    await within({}, async (fake) => {
      expect(
        await createHermesGateway({
          home: join(fake.root, "nobody"),
        }).identify(),
      ).toEqual(failure("no-socket"));
      expect(
        await createHermesGateway({ home: "relative" }).identify(),
      ).toEqual(failure("no-socket"));
      expect(await createHermesGateway({ home: undefined }).identify()).toEqual(
        failure("no-socket"),
      );
      const fileHome = join(fake.root, "file-home");
      await mkdir(fileHome, { mode: 0o700 });
      await writeFile(join(fileHome, ".hermes"), "", { mode: 0o600 });
      expect(await createHermesGateway({ home: fileHome }).identify()).toEqual(
        failure("unsafe-path"),
      );
      await fake.stop();
      expect(await client(fake).identify()).toEqual(failure("no-socket"));
      expect(await client(fake).request("GET", "/api/providers/oauth")).toEqual(
        failure("no-socket"),
      );
    });
    // A socket file nobody listens on (a gateway that died).
    await within({}, async (fake) => {
      await fake.stop();
      const { createServer } = await import("node:net");
      const stale = createServer();
      await new Promise<void>((resolve) => stale.listen(fake.socket, resolve));
      await new Promise<void>((resolve) => stale.close(() => resolve()));
      // `close` unlinks the path on some systems; leave a plain stale socket.
      await chmod(fake.socket, 0o600).catch(() => undefined);
      const answer = await client(fake).identify();
      expect(answer).toEqual(failure("no-socket"));
    });
  },
);

posix(
  "a symlinked ~/.hermes is followed to the real home the gateway reserves, and tickets name that home",
  () =>
    within({ linkedHome: true }, async (fake) => {
      const answer = await client(fake).request("GET", "/api/providers/oauth");
      expect(answer.ok).toBe(true);
      const ticket = fake.control.find(
        (request) => request.value?.verb === "session-ticket",
      );
      const params = ticket?.value?.params as
        | Record<string, unknown>
        | undefined;
      expect(params?.profile_id).toBe(fake.home);
    }),
);

posix(
  "the pointer: only to hermes-gw-<sha256(home)[:16]>/control.sock, private and never a link",
  async () => {
    await within({ pointer: true }, async (fake) => {
      const pointer = join(fake.home, "gateway.sock.path");
      const identified = await client(fake).identify();
      expect(identified.ok && identified.value.socket).toBe(fake.socket);
      expect(
        (await client(fake).request("GET", "/api/providers/oauth")).ok,
      ).toBe(true);
      const write = async (text: string) => {
        await rm(pointer, { force: true });
        await writeFile(pointer, text, { mode: 0o600 });
        await chmod(pointer, 0o600);
      };
      for (const text of [
        "relative/hermes-gw-0000000000000000/control.sock",
        "/tmp/hermes-gw-0000000000000000/control.sock",
        fake.socket.replace("control.sock", "other.sock"),
        join(fake.home, "gateway.sock"),
        `${fake.socket}\nextra`,
        "x".repeat(4097),
      ]) {
        await write(text);
        expect(await client(fake).identify()).toEqual(failure("unsafe-path"));
      }
      // The same pointer with a trailing newline, as Python strips it.
      await write(`${fake.socket}\n`);
      expect((await client(fake).identify()).ok).toBe(true);
      // The pointer open to others, or a link to a good pointer.
      await chmod(pointer, 0o644);
      expect(await client(fake).identify()).toEqual(failure("unsafe-path"));
      await chmod(pointer, 0o600);
      const good = join(fake.home, "good.path");
      await rename(pointer, good);
      await symlink(good, pointer);
      expect(await client(fake).identify()).toEqual(failure("unsafe-path"));
      await rm(pointer);
      await rename(good, pointer);
      // Its directory open to others.
      await chmod(fake.pointerDirectory, 0o755);
      expect(await client(fake).identify()).toEqual(failure("unsafe-path"));
      await chmod(fake.pointerDirectory, 0o700);
      // Its socket a link to the real one.
      const real = join(fake.pointerDirectory, "real.sock");
      await rename(fake.socket, real);
      await symlink(real, fake.socket);
      expect(await client(fake).identify()).toEqual(failure("unsafe-path"));
      await rm(fake.socket);
      await rename(real, fake.socket);
      expect((await client(fake).identify()).ok).toBe(true);
      // A pointer to a socket that is gone.
      await rm(fake.socket);
      expect(await client(fake).identify()).toEqual(failure("no-socket"));
    });
  },
);

posix(
  "deadlines and bounds: an API that does not answer, an answer too large, a control answer too large",
  () =>
    within({}, async (fake) => {
      const gateway = client(fake, { httpMs: 300, controlMs: 300 });
      // Handed to Hermes and no clear answer: it may still run there.
      fake.state.http = () => new Promise<Response>(() => undefined);
      expect(await gateway.request("GET", "/api/providers/oauth")).toEqual(
        uncertain("timeout"),
      );
      fake.state.http = () =>
        new Response(JSON.stringify({ providers: "x".repeat(300 * 1024) }), {
          headers: { "content-type": "application/json" },
        });
      expect(await gateway.request("GET", "/api/providers/oauth")).toEqual(
        uncertain("invalid-answer"),
      );
      fake.state.http = undefined;
      fake.state.identify = () => ({ raw: "x".repeat(600 * 1024) });
      expect(await gateway.identify()).toEqual(failure("invalid-answer"));
    }),
);

posix("only an /api/ path without a query is ever asked", () =>
  within({}, async (fake) => {
    for (const path of [
      "/api/providers/oauth?profile=other",
      "/api/../x",
      "/health",
      "api/providers",
      "http://127.0.0.1:1/api/x",
    ])
      await expect(client(fake).request("GET", path)).rejects.toThrow();
    expect(fake.control).toHaveLength(0);
  }),
);

// Decision F66: a body only for Hermes's own writers of Buddy's Telegram.

/** A token of a bot's shape, made here so the repository holds none. */
const syntheticToken = `${"7".repeat(10)}:AAH${"x".repeat(32)}`;

posix(
  "a named write carries its JSON body as application/json with its exact length; every other call carries none",
  () =>
    within({}, async (fake) => {
      const gateway = client(fake);
      const body = {
        env: { TELEGRAM_BOT_TOKEN: syntheticToken },
        enabled: true,
      };
      const answer = await gateway.request(
        "PUT",
        "/api/messaging/platforms/telegram",
        { body },
      );
      expect(answer.ok && answer.value.status).toBe(200);
      await gateway.request("GET", "/api/messaging/platforms");
      await gateway.request("POST", "/api/providers/oauth/openai-codex/start");
      const [put, get, post] = fake.requests;
      expect(put?.method).toBe("PUT");
      expect(put?.body).toBe(JSON.stringify(body));
      expect(put?.headers["content-type"]).toBe("application/json");
      expect(put?.headers["content-length"]).toBe(
        String(Buffer.byteLength(JSON.stringify(body))),
      );
      // The same grant as every call: one ticket, no Origin, no proxy.
      expect(put?.headers["x-hermes-gateway-ticket"]).toBe(
        fake.spent[0] as string,
      );
      for (const name of ["origin", "referer", "cookie", "authorization"])
        expect(put?.headers[name]).toBeUndefined();
      expect(get?.body).toBe("");
      expect(get?.headers["content-type"]).toBeUndefined();
      expect(post?.body).toBe("");
      expect(post?.headers["content-length"]).toBe("0");
      // The answer is Hermes's; the token is not in it.
      expect(JSON.stringify(answer)).not.toContain(syntheticToken);
    }),
);

posix(
  "a body only for the named writes, one JSON object of at most 16 KiB: anything else is refused before anything is sent",
  () =>
    within({}, async (fake) => {
      const gateway = client(fake);
      expect([...gatewayBodyCalls].sort()).toEqual([
        "DELETE /api/env",
        "POST /api/pairing/approve",
        "PUT /api/config",
        "PUT /api/env",
        "PUT /api/messaging/platforms/telegram",
      ]);
      const refused: [
        Parameters<typeof gateway.request>[0],
        string,
        unknown,
      ][] = [
        ["GET", "/api/messaging/platforms", { a: 1 }],
        ["POST", "/api/providers/oauth/openai-codex/start", {}],
        ["PUT", "/api/messaging/platforms/discord", { enabled: true }],
        ["POST", "/api/pairing/revoke", { platform: "telegram" }],
        ["PUT", "/api/messaging/platforms/telegram", ["not", "an", "object"]],
        [
          "PUT",
          "/api/config",
          { config: { big: "x".repeat(gatewayBodyBytesMax) } },
        ],
      ];
      for (const [method, path, body] of refused)
        await expect(
          gateway.request(method, path, {
            body: body as Record<string, unknown>,
          }),
        ).rejects.toThrow();
      // Asked nothing: not who it is, no ticket, no call.
      expect(fake.control).toHaveLength(0);
      expect(fake.requests).toHaveLength(0);
      // At the bound it goes.
      const config = { config: { a: "" } };
      const room =
        gatewayBodyBytesMax - Buffer.byteLength(JSON.stringify(config));
      const answer = await gateway.request("PUT", "/api/config", {
        body: { config: { a: "x".repeat(room) } },
      });
      expect(answer.ok && answer.value.status).toBe(200);
      expect(fake.requests[0]?.body).toHaveLength(gatewayBodyBytesMax);
    }),
);

posix(
  "a write refused at authentication is sent once more with the same body and a new ticket; any other answer of a write is never sent again",
  () =>
    within({}, async (fake) => {
      const body = { env: { TELEGRAM_ALLOWED_USERS: "123456789" } };
      let refusals = 1;
      fake.state.http = () =>
        refusals-- > 0
          ? Response.json(recorded.http.unauthorized.body, { status: 401 })
          : undefined;
      const answer = await client(fake).request(
        "PUT",
        "/api/messaging/platforms/telegram",
        { body },
      );
      expect(answer.ok && answer.value.status).toBe(200);
      expect(fake.requests.map((request) => request.body)).toEqual([
        JSON.stringify(body),
        JSON.stringify(body),
      ]);
      expect(new Set(fake.spent).size).toBe(2);
      expect(fake.state.telegram.allowed).toBe("123456789");

      // Refused twice: `refused`, and not a third time.
      fake.requests.length = 0;
      fake.state.http = () =>
        Response.json(recorded.http.unauthorized.body, { status: 401 });
      expect(
        await client(fake).request("PUT", "/api/env", {
          body: { key: "TELEGRAM_HOME_CHANNEL", value: "123456789" },
        }),
      ).toEqual(failure("refused"));
      expect(fake.requests).toHaveLength(2);

      // A failed write is its answer: sent once.
      fake.requests.length = 0;
      fake.state.http = () =>
        Response.json({ detail: "Internal server error" }, { status: 500 });
      const failed = await client(fake).request(
        "POST",
        "/api/pairing/approve",
        { body: { platform: "telegram", request_id: "0123456789abcdef" } },
      );
      expect(failed.ok && failed.value.status).toBe(500);
      expect(fake.requests).toHaveLength(1);
      // The gateway stops answering in the middle: not sent again either.
      fake.requests.length = 0;
      fake.state.http = () =>
        new Promise<Response>(() => {
          // never answers
        });
      expect(
        await createHermesGateway({
          home: fake.userHome,
          httpMs: 200,
        }).request("DELETE", "/api/env", {
          body: { key: "TELEGRAM_HOME_CHANNEL" },
        }),
      ).toEqual(uncertain("timeout"));
      expect(fake.requests).toHaveLength(1);
    }),
);

posix(
  "a write is uncertain once Hermes may have taken it: no answer in time or a connection cut after it was sent; nothing listening, Hermes's own not-ready and a refused ticket are clear",
  async () => {
    const write = { body: { key: "TELEGRAM_HOME_CHANNEL", value: "1" } };
    // A listener that takes the request whole, then cuts the connection.
    const cutting = createServer((socket) => {
      socket.once("data", () => socket.destroy());
    });
    await new Promise<void>((resolve) =>
      cutting.listen(0, "127.0.0.1", () => resolve()),
    );
    const cutPort = (cutting.address() as AddressInfo).port;
    // A port where nothing listens.
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", () => resolve()),
    );
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    try {
      await within({}, async (fake) => {
        const to = (port: number) => {
          fake.state.identify = (identify) => {
            (identify.result as Record<string, unknown>).api_origin =
              `http://127.0.0.1:${port}`;
            return identify;
          };
        };
        to(cutPort);
        expect(await client(fake).request("PUT", "/api/env", write)).toEqual(
          uncertain("not-ready"),
        );
        to(closedPort);
        expect(await client(fake).request("PUT", "/api/env", write)).toEqual(
          failure("not-ready"),
        );
        fake.state.identify = undefined;
        fake.state.http = () =>
          Response.json(
            { error: "gateway_not_ready", state: "starting" },
            { status: 503 },
          );
        expect(await client(fake).request("PUT", "/api/env", write)).toEqual(
          failure("not-ready"),
        );
        fake.state.http = () =>
          Response.json(recorded.http.unauthorized.body, { status: 401 });
        expect(await client(fake).request("PUT", "/api/env", write)).toEqual(
          failure("refused"),
        );
      });
    } finally {
      await new Promise<void>((resolve) => cutting.close(() => resolve()));
    }
  },
);

posix(
  "HTTP_PROXY never sees a body: a write goes to the loopback listener itself",
  () =>
    within({}, async (fake) => {
      const proxied: string[] = [];
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          proxied.push(await request.text());
          return Response.json({ ok: true });
        },
      });
      try {
        const module = join(import.meta.dir, "../src/buddy/hermes-gateway.ts");
        const child = Bun.spawn(
          [
            process.execPath,
            "-e",
            `const { createHermesGateway } = await import(${JSON.stringify(module)});
             const answer = await createHermesGateway({ home: process.argv.at(-1) })
               .request("PUT", "/api/messaging/platforms/telegram", { body: { env: { TELEGRAM_BOT_TOKEN: process.argv.at(-2) }, enabled: true } });
             console.log(JSON.stringify(answer.ok ? answer.value.status : answer));`,
            syntheticToken,
            fake.userHome,
          ],
          {
            env: {
              ...process.env,
              HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
              http_proxy: `http://127.0.0.1:${proxy.port}`,
              NO_PROXY: "",
              no_proxy: "",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(await new Response(child.stdout).text()).toBe("200\n");
        expect(await child.exited).toBe(0);
        expect(proxied).toEqual([]);
        expect(fake.state.telegram.token).toBe(syntheticToken);
      } finally {
        proxy.stop(true);
      }
    }),
);
