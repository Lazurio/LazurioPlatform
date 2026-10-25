import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { oauthCancelContract } from "../../src/buddy/hermes-gateway";
import recorded from "./hermes-gateway-v0.22.4-lazurio.1.json";

// A stand-in for Buddy's Hermes gateway (Lazurio/hermes-agent
// v0.22.4-lazurio.1, decision F63): its owner-only control socket in the
// user's `~/.hermes` (`gateway.sock`, or a pointer to
// `/tmp/hermes-gw-<sha256(home)[:16]>/control.sock`), answering `identify`
// and `session-ticket` one line per connection, and its loopback dashboard
// API, which redeems each ticket once, as `native_http.py` does: exactly one
// ticket, no `Origin` of any kind, no `profile` query. Every answer is one
// recorded from the real gateway (hermes-gateway-v0.22.4-lazurio.1.json),
// with the fake's own home, origin and fresh tickets; a test may replace any
// of them. Everything that arrives is recorded as it arrived.
//
// Its sign-in sessions behave as Hermes's do: a cancel marks a session
// cancelled and removes it, and a worker saves only an unmarked one. Its
// 15-minute sweep (`collect`) removes a session without the mark, as the
// recorded tag does, unless the gateway keeps Lazurio/hermes-agent#17's
// cancellation contract (`contract`, on by default): then it marks it first,
// and its `identify` advertises the contract (derived from the recorded
// answer, which has none).

type Json = Record<string, unknown>;

export type ControlRequest = Readonly<{ line: string; value: Json | null }>;
export type GatewayRequest = Readonly<{
  method: string;
  path: string;
  query: string;
  headers: Readonly<Record<string, string>>;
  peer: string | null;
}>;

export type FakeGatewayOptions = Readonly<{
  /** The socket through a pointer, as for a home too long for a socket. */
  pointer?: boolean;
  /** Buddy's home as a link to his real one (a symlinked `~/.hermes`). */
  linkedHome?: boolean;
  signedIn?: boolean;
  /** Whether it keeps and advertises the cancellation contract (default:
   * yes; the recorded v0.22.4-lazurio.1 does not). */
  contract?: boolean;
}>;

type SignInSession = {
  status: string;
  error_message: string | null;
  /** Marked by a cancel, or by the sweep under the contract. */
  cancelled?: boolean;
};

/** What the fake answers on its control socket: a JSON value, a raw line
 * (`raw`), nothing at all (`hang`) or a closed connection (`close`). */
export type ControlReply = Json | { raw: string } | "hang" | "close";

const fill = (value: unknown, home: string, origin: string): unknown =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll("{{home}}", home)
      .replaceAll("{{apiOrigin}}", origin),
  );

export async function fakeHermesGateway(options: FakeGatewayOptions = {}) {
  // Short and real: a socket path has at most ~100 bytes, and the gateway
  // reserves its home's real path.
  const root = await realpath(await mkdtemp("/tmp/hg-"));
  const userHome = join(root, "user");
  await mkdir(userHome, { mode: 0o700 });
  const home = options.linkedHome
    ? join(root, "elsewhere")
    : join(userHome, ".hermes");
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  if (options.linkedHome)
    await Bun.$`ln -s ${home} ${join(userHome, ".hermes")}`.quiet();
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
  const pointerDirectory = `/tmp/hermes-gw-${hash}`;
  const socket = options.pointer
    ? join(pointerDirectory, "control.sock")
    : join(home, "gateway.sock");
  if (options.pointer) {
    await mkdir(pointerDirectory, { mode: 0o700 });
    await chmod(pointerDirectory, 0o700);
  }

  const control: ControlRequest[] = [];
  const requests: GatewayRequest[] = [];
  const minted = new Set<string>();
  const spent: string[] = [];
  // The sessions Hermes holds (its `_oauth_sessions`), and every session
  // whose worker may still run, held or not.
  const sessions = new Map<string, SignInSession>();
  const workers = new Map<string, SignInSession>();
  let started = 0;
  const state = {
    signedIn: options.signedIn === true,
    /** Replaces the `identify` answer; `answer` is the recorded one. */
    identify: undefined as ((answer: Json) => ControlReply) | undefined,
    /** Replaces the `session-ticket` answer. */
    ticket: undefined as
      | ((request: Json, answer: Json) => ControlReply)
      | undefined,
    /** Answers an API request after its ticket is redeemed; undefined: the
     * recorded route. */
    http: undefined as
      | ((
          request: GatewayRequest,
        ) => Response | undefined | Promise<Response | undefined>)
      | undefined,
    /** The instance this gateway runs as; a restart changes it. */
    instance: recorded.control.identify.result.instance_id,
    /** Whether it keeps and advertises the cancellation contract. */
    contract: options.contract !== false,
  };

  let apiOrigin = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const recordedRequest: GatewayRequest = Object.freeze({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: Object.freeze(Object.fromEntries(request.headers)),
        peer: server.requestIP(request)?.address ?? null,
      });
      requests.push(recordedRequest);
      const json = (entry: { status: number; body: unknown }) =>
        Response.json(fill(entry.body, home, apiOrigin), {
          status: entry.status,
        });
      // native_http.py: one ticket (Bun joins a repeated header with a
      // comma, which a ticket never holds), no Origin, loopback, redeemed
      // once.
      const ticket = request.headers.get("x-hermes-gateway-ticket");
      if (
        ticket === null ||
        ticket.includes(",") ||
        request.headers.has("origin") ||
        !["127.0.0.1", "::1"].includes(recordedRequest.peer ?? "") ||
        !minted.has(ticket)
      )
        return json(recorded.http.unauthorized);
      minted.delete(ticket);
      spent.push(ticket);
      if (url.searchParams.has("profile"))
        return json(recorded.http.profileScopeMismatch);
      const replaced = await state.http?.(recordedRequest);
      if (replaced !== undefined) return replaced;
      const codex = "/api/providers/oauth/openai-codex";
      if (request.method === "GET" && url.pathname === "/api/providers/oauth")
        return json(
          state.signedIn
            ? recorded.http.providersSignedIn
            : recorded.http.providersSignedOut,
        );
      if (request.method === "POST" && url.pathname === `${codex}/start`) {
        started += 1;
        const id = `Fixture_Session_${String(started).padStart(6, "0")}`;
        const session: SignInSession = {
          status: "pending",
          error_message: null,
        };
        sessions.set(id, session);
        workers.set(id, session);
        return json({
          status: 200,
          body: { ...recorded.http.start.body, session_id: id },
        });
      }
      const poll = new RegExp(`^${codex}/poll/(.+)$`).exec(url.pathname);
      if (request.method === "GET" && poll !== null) {
        const session = sessions.get(poll[1] as string);
        return session === undefined
          ? json(recorded.http.pollUnknown)
          : json({
              status: 200,
              body: {
                ...recorded.http.pollPending.body,
                session_id: poll[1],
                status: session.status,
                error_message: session.error_message,
              },
            });
      }
      const cancel = /^\/api\/providers\/oauth\/sessions\/(.+)$/.exec(
        url.pathname,
      );
      if (request.method === "DELETE" && cancel !== null) {
        const id = cancel[1] as string;
        // cancel_oauth_session: marked, then removed, under one lock.
        const session = sessions.get(id);
        if (session === undefined) return json(recorded.http.cancelUnknown);
        session.cancelled = true;
        sessions.delete(id);
        return json({
          status: 200,
          body: { ...recorded.http.cancel.body, session_id: id },
        });
      }
      if (request.method === "DELETE" && url.pathname === codex) {
        if (!state.signedIn) return json(recorded.http.signOutEmpty);
        state.signedIn = false;
        return json(recorded.http.signOut);
      }
      return Response.json({ detail: "Not Found" }, { status: 404 });
    },
  });
  apiOrigin = `http://127.0.0.1:${server.port}`;

  const reply = (request: Json | null): ControlReply => {
    if (request?.verb === "identify") {
      const answer = fill(recorded.control.identify, home, apiOrigin) as Json;
      const result = answer.result as Json;
      result.instance_id = state.instance;
      if (state.contract) {
        const { member, value } = oauthCancelContract;
        const listed = result[member];
        result[member] = Array.isArray(listed) ? [...listed, value] : value;
      }
      return state.identify === undefined ? answer : state.identify(answer);
    }
    if (request?.verb === "session-ticket") {
      // control_socket.py `_session_ticket` and runtime_bootstrap.py `mint`.
      const params = request.params as Json | undefined;
      const keys = Object.keys(request);
      let answer: Json;
      if (
        keys.some((key) => !["protocol", "verb", "id", "params"].includes(key))
      )
        answer = recorded.control.ticketInvalidEnvelope;
      else if (params?.instance_id !== state.instance)
        answer = recorded.control.ticketStaleInstance;
      else if (params?.profile_id !== home || params?.purpose !== "native-http")
        answer = recorded.control.ticketOtherProfile;
      else {
        const ticket = randomBytes(32).toString("base64url");
        minted.add(ticket);
        answer = fill(recorded.control.ticket, home, apiOrigin) as Json;
        answer.result = {
          ...(answer.result as Json),
          ticket,
          instance_id: state.instance,
        };
      }
      return state.ticket === undefined
        ? answer
        : state.ticket(request, answer);
    }
    return { ok: false, error: "unknown verb", protocol: 1 };
  };

  const listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(connection) {
        connection.data = { buffer: "" };
      },
      data(connection, chunk) {
        connection.data.buffer += new TextDecoder().decode(chunk);
        const newline = connection.data.buffer.indexOf("\n");
        if (newline === -1) return;
        const line = connection.data.buffer.slice(0, newline);
        let value: Json | null = null;
        try {
          value = JSON.parse(line) as Json;
        } catch {}
        control.push(Object.freeze({ line, value }));
        const answer = reply(value);
        if (answer === "hang") return;
        if (answer === "close") {
          connection.end();
          return;
        }
        connection.write(
          `${"raw" in answer ? answer.raw : JSON.stringify(answer)}\n`,
        );
        connection.end();
      },
    },
  });
  // Hermes binds under umask 0177 and sets 0600 (control_socket.py).
  await chmod(socket, 0o600);
  if (options.pointer) {
    const pointer = join(home, "gateway.sock.path");
    await writeFile(pointer, socket, { mode: 0o600 });
    await chmod(pointer, 0o600);
  }

  return {
    root,
    /** The user's home: where `~/.hermes` is. */
    userHome,
    /** Buddy's real Hermes home. */
    home,
    socket,
    pointerDirectory,
    apiOrigin,
    control,
    requests,
    /** Tickets the API redeemed, in order. */
    spent,
    /** Tickets minted and not yet redeemed. */
    minted,
    sessions,
    state,
    /** OpenAI approved the sign-in and its worker tries to save it, also
     * after the sweep removed it (`collect`): it checks the mark first, under
     * the lock its cancel takes, and saves only an unmarked session. Whether
     * it saved. */
    approve(id: string): boolean {
      const session = sessions.get(id) ?? workers.get(id);
      if (session === undefined) throw new Error(`No session ${id}`);
      if (session.cancelled === true) return false;
      session.status = "approved";
      state.signedIn = true;
      return true;
    },
    /** Hermes's 15-minute sweep (`_gc_oauth_sessions`): the session leaves the
     * map, so its poll answers 404 and its cancel "session not found". Under
     * the contract it is marked cancelled first; at v0.22.4-lazurio.1 it is
     * not, and its worker may still save. */
    collect(id: string) {
      const session = sessions.get(id);
      if (session === undefined) throw new Error(`No session ${id}`);
      if (state.contract) session.cancelled = true;
      sessions.delete(id);
    },
    /** A restart: every session in its memory is gone with its worker, a new
     * instance. */
    restart() {
      sessions.clear();
      workers.clear();
      minted.clear();
      state.instance = randomBytes(16).toString("hex");
    },
    /** Stops answering: the socket and the API are gone. */
    async stop() {
      listener.stop(true);
      server.stop(true);
      await rm(socket, { force: true });
    },
    async close() {
      listener.stop(true);
      server.stop(true);
      await rm(root, { recursive: true, force: true });
      if (options.pointer)
        await rm(pointerDirectory, { recursive: true, force: true });
    },
  };
}

export type FakeHermesGateway = Awaited<ReturnType<typeof fakeHermesGateway>>;

export { recorded };
