import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  chatPairing,
  chatPairingLabel,
  chatPairingPath,
  isChatPairingFetch,
  mintChatPairing,
  publicEntry,
  standardPairingScopes,
  t3PairUrl,
  takesPairingScopes,
} from "../src/launchpad/chat";
import {
  chatHref,
  chatPairLink,
  chatPromptHref,
  parseEntryAnswer,
  parsePromptHandoff,
} from "../src/launchpad/chat-view";
import { type AuthFetcher, nobody } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import type { ToolsEnvironment } from "../src/tools/overview";
import {
  runTool,
  type ToolProcessResult,
  type ToolRunner,
} from "../src/tools/status";
import {
  binding,
  handoverEntry,
  organizationWithEntry,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import { freePort } from "./fixtures/ports";

// Chat into T3 Code (launchpad-parity B8, slice P7): the resident's behaviour
// (`R:launchpad/src/t3-chat-lib.mjs`, `R:launchpad/public/app.js:2257-2281`)
// with every value from the recorded entry. Since the decision of 2026-10-17
// the Environment pairs its own browser: T3 Code's web client asks
// `GET /.lazurio/chat/pairing` on its own origin, minted by the same code as
// the Launchpad's click, with T3's operator pairing where T3 Code offers it.

const credential = "Pairing_Token-0123456789abcdef";
const expiresAt = "2026-10-17T12:01:00.000Z";

// The JSON `t3 auth pairing create --json` and `t3 lazurio pairing --json`
// print, with values of T3's own the Platform never passes on.
const pairingOutput = JSON.stringify({
  id: "pairing-1",
  credential,
  label: "as-t3-echoes-it",
  scopes: ["scope-a", "scope-b"],
  expiresAt,
});

// T3 Code's capabilities (`t3 lazurio capabilities`), with or without its
// operator pairing.
const capabilitiesOutput = (operatorPairing: boolean) =>
  JSON.stringify({
    version: 1,
    managedFolder: true,
    modelRecommendation: true,
    providerRefresh: true,
    ...(operatorPairing ? { operatorPairing: true } : {}),
  });

// A fake T3 launcher on a private PATH: it answers `t3 --version` (a T3 Code
// that takes `--scope`) and `t3 lazurio capabilities` (with the operator
// pairing when `operator`), refuses a `--json` to `t3 lazurio pairing` as
// T3's CLI refuses a flag it does not know (Lazurio/t3code#84: the command
// always prints JSON), records the arguments of the pairing call and answers
// it as T3 does, or as told by `mode`.
async function fakeLauncher(directory: string, mode: string, operator = false) {
  const script = join(directory, "t3");
  const outputs: Record<string, string> = {
    ok: `echo '${pairingOutput}'`,
    // A failing call whose output holds the credential: never passed on.
    fail: `echo 'could not pair ${credential}' >&2; exit 3`,
    unreadable: "echo 'not json'",
    shape: `echo '{"credential":"short","expiresAt":"${expiresAt}"}'`,
    // A credential without a readable expiry.
    expiry: `echo '{"credential":"${credential}","expiresAt":"in a minute"}'`,
  };
  await writeFile(
    script,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo 't3 v0.1.1-lazurio.1'
  exit 0
fi
if [ "$1 $2" = "lazurio capabilities" ]; then
  echo '${capabilitiesOutput(operator)}'
  exit 0
fi
if [ "$1 $2" = "lazurio pairing" ]; then
  for argument in "$@"; do
    if [ "$argument" = "--json" ]; then
      echo "Unrecognized flag: --json in command t3 lazurio pairing" >&2
      exit 1
    fi
  done
fi
printf '%s\\n' "$@" > "${join(directory, "t3.calls")}"
${outputs[mode]}
`,
  );
  await chmod(script, 0o755);
}

// The calls of one pairing: the capabilities, then the pairing itself,
// `operator` (`t3 lazurio pairing`, which always prints JSON) or standard
// (`t3 --version`, then `t3 auth pairing create --json` with the scopes it
// grants).
const capabilitiesCall = (bin: string, home: string) => ({
  command: [join(bin, "t3"), "lazurio", "capabilities"],
  timeoutMs: 15_000,
  env: { HOME: home, PATH: bin },
});
const versionCall = (bin: string, home: string) => ({
  command: [join(bin, "t3"), "--version"],
  timeoutMs: chatPairing.timeoutMs,
  env: { HOME: home, PATH: bin },
});
const standardScopeFlags = standardPairingScopes.flatMap((scope) => [
  "--scope",
  scope,
]);
const pairingCall = (
  bin: string,
  home: string,
  kind: "operator" | "standard",
  label: string,
) => ({
  command: [
    join(bin, "t3"),
    ...(kind === "operator"
      ? ["lazurio", "pairing"]
      : ["auth", "pairing", "create"]),
    "--base-dir",
    join(home, ".t3"),
    "--ttl",
    "60s",
    "--label",
    label,
    ...(kind === "operator" ? [] : ["--json", ...standardScopeFlags]),
  ],
  timeoutMs: chatPairing.timeoutMs,
  env: { HOME: home, PATH: bin },
});

async function hostedLaunchpad(
  options: Readonly<{
    /** The Lazurio username the gateway's answer names. */
    username?: string;
    /** A public Environment (root decision 0204). */
    audience?: boolean;
    /** A Team Environment. */
    team?: boolean;
  }> = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-chat-")),
  );
  const home = join(parent, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  const preset = options.team
    ? "hosted-organization-team"
    : "hosted-organization-personal";
  const port = freePort();
  const machine = options.team
    ? binding({
        ...organization,
        entry: handoverEntry("workspace.example.lazurio.io", port),
      })
    : organizationWithEntry(port, undefined, false, false, options.audience);
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok", {
          headers:
            options.username === undefined
              ? {}
              : { "x-auth-request-preferred-username": options.username },
        })
      : new Response("no", { status: 401 });
  const runs: { command: string[]; timeoutMs: number; env: object }[] = [];
  const run: ToolRunner = (command, timeoutMs, env) => {
    runs.push({ command: [...command], timeoutMs, env: { ...env } });
    return runTool(command, timeoutMs, env);
  };
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    { path: bin, home, platform: process.platform, run },
  );
  const base = `http://127.0.0.1:${entry.listenPort}`;
  const host = new URL(entry.externalOrigin).host;
  const valid = { host, cookie: "__Secure-lazurio-workspace=valid" };
  const sameOrigin = {
    ...valid,
    origin: entry.externalOrigin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const pair = (headers: Record<string, string> = sameOrigin) =>
    fetch(`${base}/api/chat/pair`, { method: "POST", headers, body: "{}" });
  // T3 Code's web client asking on its own origin, as the gateway forwards
  // it here (Machines `ingress.ts` `shellRoute`): the Launchpad's Host, the
  // session cookie alone and the browser's own Fetch Metadata of a script's
  // fetch.
  const ownFetch = {
    ...valid,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
  const selfPair = (
    headers: Record<string, string> = ownFetch,
    init: RequestInit = {},
    path = "/.lazurio/chat/pairing",
  ) => fetch(`${base}${path}`, { headers, ...init });
  return {
    entry,
    home,
    bin,
    base,
    host,
    valid,
    ownFetch,
    runs,
    pair,
    selfPair,
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")(
  "hosted: /api/entry answers the recorded entry's public parts, read-only and behind the gateway's admission",
  async () => {
    const hosted = await hostedLaunchpad();
    try {
      const { entry, base, host, valid } = hosted;
      const anonymous = await fetch(`${base}/api/entry`, { headers: { host } });
      expect([anonymous.status, await anonymous.json()]).toEqual([
        401,
        { error: "denied", reason: "cookie-missing" },
      ]);
      const answer = await fetch(`${base}/api/entry`, { headers: valid });
      const body = await answer.json();
      expect([answer.status, body]).toEqual([
        200,
        {
          kind: "entry",
          entry: {
            launchpadOrigin: entry.externalOrigin,
            t3codeOrigin: entry.t3codeOrigin,
            moduleOriginTemplate: entry.moduleOriginTemplate,
          },
        },
      ]);
      // The recorded T3 Code origin, byte for byte: the Chat link.
      expect(chatHref(parseEntryAnswer(body))).toBe(
        "https://t3code.workspace.example.lazurio.io",
      );
      // The admission values stay on the server.
      expect(JSON.stringify(body)).not.toContain(entry.authCheckUrl);
      expect(JSON.stringify(body)).not.toContain(entry.authCookieName);
      // Read-only: no other method.
      const posted = await fetch(`${base}/api/entry`, {
        method: "POST",
        headers: {
          ...valid,
          origin: entry.externalOrigin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(posted.status).toBe(405);
    } finally {
      await hosted.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted: Chat mints a one-time pairing link on the recorded T3 Code origin with T3's own call",
  async () => {
    const hosted = await hostedLaunchpad();
    try {
      const { entry, home, bin, runs, pair, valid } = hosted;
      // Without a T3 launcher on PATH: named, nothing run; the page then
      // follows the plain origin.
      const missing = await pair();
      expect([missing.status, await missing.json()]).toEqual([
        409,
        { kind: "blocked", reason: "t3-launcher-missing" },
      ]);
      expect(runs).toEqual([]);

      await fakeLauncher(bin, "ok");
      // A state-changing request needs the same-origin proof as every other.
      expect((await pair(valid)).status).toBe(401);
      expect(runs).toEqual([]);
      const paired = await pair();
      const body = await paired.json();
      expect([paired.status, body]).toEqual([
        200,
        {
          kind: "chat-link",
          url: `https://t3code.workspace.example.lazurio.io/pair#token=${credential}`,
        },
      ]);
      expect(body.url).toBe(t3PairUrl(entry.t3codeOrigin, credential));
      expect(chatPairLink(body, entry.t3codeOrigin)).toBe(body.url);
      // T3 Code's capabilities first; this one offers no operator pairing,
      // so the resident's call (`R:launchpad/src/t3-chat-lib.mjs:75` over
      // Machines' `t3 auth pairing create --base-dir ~/.t3`), labelled for
      // the admitted person (the gateway named nobody here), with only HOME
      // and PATH of this Launchpad's environment.
      expect(runs).toEqual([
        capabilitiesCall(bin, home),
        versionCall(bin, home),
        pairingCall(bin, home, "standard", "Lazurio"),
      ]);
      expect(
        (await readFile(join(bin, "t3.calls"), "utf8")).trim().split("\n"),
      ).toEqual(runs[2]?.command.slice(1) ?? []);

      // A failed call, output that is not the answer, a credential of
      // another shape or without a readable expiry: one reason, and the
      // tool's output never passed on.
      for (const mode of ["fail", "unreadable", "shape", "expiry"]) {
        await fakeLauncher(bin, mode);
        const failed = await pair();
        const text = await failed.text();
        expect([mode, failed.status, JSON.parse(text)]).toEqual([
          mode,
          409,
          { kind: "blocked", reason: "t3-pairing-failed" },
        ]);
        expect(text).not.toContain(credential);
      }
      // Nothing is recorded: the Folder and the home hold no token.
      expect(await readdir(home)).toEqual([".local"]);
    } finally {
      await hosted.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted: T3 Code's own fetch gets its pairing, exactly the JSON and no-store, with T3's operator pairing labelled for the admitted person",
  async () => {
    const hosted = await hostedLaunchpad({ username: "example" });
    try {
      const { home, bin, runs, selfPair, pair } = hosted;
      await fakeLauncher(bin, "ok", true);
      const answer = await selfPair();
      // What T3 Code's client accepts and nothing else (Lazurio/t3code#84):
      // 200 without a redirect, JSON, and exactly these three keys.
      expect([answer.status, answer.redirected]).toEqual([200, false]);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(answer.headers.get("content-type")).toStartWith(
        "application/json",
      );
      // Byte for byte: nothing else of T3's answer (its id, label or
      // scopes) is passed on.
      expect(await answer.text()).toBe(
        `{"kind":"chat-pairing","credential":"${credential}","expiresAt":"${expiresAt}"}`,
      );
      // T3 Code offers its operator pairing: `t3 lazurio pairing`, with the
      // standard call's arguments but `--json`, which it does not take.
      expect(runs).toEqual([
        capabilitiesCall(bin, home),
        pairingCall(bin, home, "operator", "Lazurio · example"),
      ]);
      expect(
        (await readFile(join(bin, "t3.calls"), "utf8")).trim().split("\n"),
      ).toEqual(runs[1]?.command.slice(1) ?? []);
      // The Launchpad's click mints through the same code: the same call.
      runs.length = 0;
      const clicked = await pair();
      expect([clicked.status, (await clicked.json()).url]).toEqual([
        200,
        `https://t3code.workspace.example.lazurio.io/pair#token=${credential}`,
      ]);
      expect(runs).toEqual([
        capabilitiesCall(bin, home),
        pairingCall(bin, home, "operator", "Lazurio · example"),
      ]);
      // Nothing is recorded: the home holds no token.
      expect(await readdir(home)).toEqual([".local"]);
    } finally {
      await hosted.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted: the self-pairing answers only an admitted page's own fetch: every other request mints nothing",
  async () => {
    const hosted = await hostedLaunchpad({ username: "example" });
    try {
      const { entry, host, valid, ownFetch, runs, bin, selfPair } = hosted;
      await fakeLauncher(bin, "ok", true);
      // Unadmitted: no session, a session the gateway refuses, or the T3
      // Code origin's own Host (the gateway must send the Launchpad's).
      const { cookie: _, ...withoutCookie } = ownFetch;
      for (const [headers, reason] of [
        [withoutCookie, "cookie-missing"],
        [
          { ...ownFetch, cookie: "__Secure-lazurio-workspace=expired" },
          "auth-denied",
        ],
        [
          { ...ownFetch, host: new URL(entry.t3codeOrigin).host },
          "host-mismatch",
        ],
      ] as const) {
        const denied = await selfPair(headers);
        expect([reason, denied.status, await denied.json()]).toEqual([
          reason,
          401,
          { error: "denied", reason },
        ]);
      }
      // Admitted, but not a page's own fetch: no Fetch Metadata at all,
      // another site, a sibling of the Environment, a typed address, a
      // navigation on T3 Code's own origin (a link, a bookmark), a
      // subresource and speculative loads.
      for (const headers of [
        valid,
        { ...ownFetch, "sec-fetch-site": "cross-site" },
        { ...ownFetch, "sec-fetch-site": "same-site" },
        {
          ...valid,
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
        {
          ...valid,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
        { ...ownFetch, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
        { ...ownFetch, "sec-purpose": "prefetch" },
        { ...ownFetch, purpose: "prefetch" },
        {
          ...valid,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-purpose": "prefetch;prerender",
        },
      ]) {
        const refused = await selfPair(headers);
        expect([headers, refused.status, await refused.json()]).toEqual([
          headers,
          403,
          { error: "not-allowed" },
        ]);
      }
      // A query, a HEAD and any other method: not the request either.
      const query = await selfPair(ownFetch, {}, "/.lazurio/chat/pairing?x=1");
      expect([query.status, await query.json()]).toEqual([
        400,
        { error: "invalid-request" },
      ]);
      const head = await selfPair(ownFetch, { method: "HEAD" });
      expect(head.status).toBe(405);
      const posted = await selfPair(
        {
          ...ownFetch,
          origin: entry.externalOrigin,
          "content-type": "application/json",
        },
        { method: "POST", body: "{}" },
      );
      expect([posted.status, await posted.json()]).toEqual([
        405,
        { error: "method-not-allowed" },
      ]);
      expect(runs).toEqual([]);
      // Any other path beside it is no pairing: the page's static listener
      // answers it.
      const neighbour = await fetch(`${hosted.base}/.lazurio/chat/other`, {
        headers: { host, cookie: valid.cookie },
      });
      expect(neighbour.status).toBe(404);
      expect(runs).toEqual([]);
    } finally {
      await hosted.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted: a public Environment's visitor gets the standard pairing without asking T3 Code; a Team Environment's person gets the operator pairing",
  async () => {
    const visited = await hostedLaunchpad({
      username: "visitor",
      audience: true,
    });
    try {
      const { home, bin, runs, selfPair } = visited;
      // Even where T3 Code offers its operator pairing.
      await fakeLauncher(bin, "ok", true);
      const answer = await selfPair();
      expect([answer.status, await answer.json()]).toEqual([
        200,
        { kind: "chat-pairing", credential, expiresAt },
      ]);
      expect(runs).toEqual([
        versionCall(bin, home),
        pairingCall(bin, home, "standard", "Lazurio · visitor"),
      ]);
    } finally {
      await visited.close();
    }
    const team = await hostedLaunchpad({ username: "example", team: true });
    try {
      const { home, bin, runs, selfPair } = team;
      await fakeLauncher(bin, "ok", true);
      const answer = await selfPair();
      expect(answer.status).toBe(200);
      expect(runs).toEqual([
        capabilitiesCall(bin, home),
        pairingCall(bin, home, "operator", "Lazurio · example"),
      ]);
    } finally {
      await team.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "hosted: without t3, or when its call fails, the self-pairing answers 409 with the reason and never the output",
  async () => {
    const hosted = await hostedLaunchpad({ username: "example" });
    try {
      const { bin, runs, selfPair } = hosted;
      const missing = await selfPair();
      expect([missing.status, await missing.json()]).toEqual([
        409,
        { kind: "blocked", reason: "t3-launcher-missing" },
      ]);
      expect(runs).toEqual([]);
      for (const mode of ["fail", "unreadable", "shape", "expiry"]) {
        await fakeLauncher(bin, mode, true);
        const failed = await selfPair();
        const text = await failed.text();
        expect([mode, failed.status, JSON.parse(text)]).toEqual([
          mode,
          409,
          { kind: "blocked", reason: "t3-pairing-failed" },
        ]);
        expect(text).not.toContain(credential);
      }
    } finally {
      await hosted.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "workstation: no entry, so no Chat: /api/entry answers null behind the fragment token and the pairing route does not exist",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-chat-local-")),
    );
    const folder = join(parent, "Lazurio");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    let ran = false;
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      {},
      {
        path: parent,
        home: parent,
        platform: process.platform,
        run: async () => {
          ran = true;
          return "timeout";
        },
      },
    );
    try {
      const url = new URL(app.url);
      const token = url.hash.slice(1);
      const denied = await fetch(new URL("/api/entry", url));
      expect(denied.status).toBe(403);
      const answer = await fetch(new URL("/api/entry", url), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await answer.json();
      expect([answer.status, body]).toEqual([
        200,
        { kind: "entry", entry: null },
      ]);
      expect(chatHref(parseEntryAnswer(body))).toBeNull();
      const pairing = await fetch(new URL("/api/chat/pair", url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: url.origin,
          Authorization: `Bearer ${token}`,
        },
        body: "{}",
      });
      expect([pairing.status, await pairing.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
      // Nor the self-pairing: refused without the token, absent with it.
      const ownFetch = {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
      };
      const unadmitted = await fetch(new URL(chatPairingPath, url), {
        headers: ownFetch,
      });
      expect(unadmitted.status).toBe(403);
      const self = await fetch(new URL(chatPairingPath, url), {
        headers: { ...ownFetch, Authorization: `Bearer ${token}` },
      });
      expect([self.status, await self.json()]).toEqual([
        404,
        { error: "not-found" },
      ]);
      expect(ran).toBe(false);
    } finally {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("T3 Code takes the pairing's scopes from v0.1.0, by the version it prints", () => {
  for (const [version, takes] of [
    ["0.1.1-lazurio.1", true],
    ["0.1.0-lazurio.5", true],
    ["0.1.0-preview.20261021.2", true],
    ["0.1.0", true],
    ["1.0.0", true],
    ["0.0.45-lazurio.9", false],
    ["0.0.45-preview.20261015.1", false],
    [null, null],
  ] as const)
    expect([version, takesPairingScopes(version)]).toEqual([version, takes]);
  // Never the scopes that manage the Environment's access or its T3 Connect.
  expect(standardPairingScopes).toHaveLength(13);
  for (const scope of ["access:read", "access:write", "relay:write"])
    expect(standardPairingScopes).not.toContain(scope);
});

test.skipIf(process.platform === "win32")(
  "a standard pairing grants only its own scopes on a T3 Code that takes them, and with no version to read nobody is paired",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-chat-scopes-")),
    );
    await writeFile(join(directory, "t3"), "#!/bin/sh\nexit 1\n");
    await chmod(join(directory, "t3"), 0o755);
    try {
      const visited = organizationWithEntry(
        20000,
        undefined,
        false,
        false,
        true,
      ).entry;
      if (visited === undefined) throw new Error("The fixture has an entry");
      // The pairing call a public Environment runs after `t3 --version`.
      const mint = async (version: ToolProcessResult | "timeout") => {
        const pairings: string[][] = [];
        const environment: ToolsEnvironment = {
          path: directory,
          home: directory,
          platform: process.platform,
          run: async (command) => {
            if (command[1] === "--version") return version;
            pairings.push(command.slice(1));
            return { exitCode: 0, stdout: pairingOutput, stderr: "" };
          },
        };
        const pairing = await mintChatPairing(visited, environment);
        return { kind: pairing.kind, pairings };
      };
      const printed = (stdout: string, exitCode = 0) => ({
        exitCode,
        stdout,
        stderr: "",
      });
      const scopesOf = (pairings: string[][]) =>
        pairings.map((call) =>
          call.flatMap((argument, index) =>
            call[index - 1] === "--scope" ? [argument] : [],
          ),
        );
      for (const version of [
        "t3 v0.1.1-lazurio.1",
        "t3 v0.1.0-lazurio.5",
        "t3 v0.1.0-preview.20261021.2",
      ]) {
        const { kind, pairings } = await mint(printed(version));
        expect([version, kind, scopesOf(pairings)]).toEqual([
          version,
          "chat-pairing",
          [[...standardPairingScopes]],
        ]);
      }
      // An older T3 Code refuses `--scope`: its own pairing, as before.
      const older = await mint(printed("t3 v0.0.45-lazurio.5"));
      expect([older.kind, scopesOf(older.pairings)]).toEqual([
        "chat-pairing",
        [[]],
      ]);
      // No version to read: no pairing call at all.
      for (const version of [
        printed("t3 vnext"),
        printed("", 1),
        "timeout" as const,
      ])
        expect([version, await mint(version)]).toEqual([
          version,
          { kind: "blocked", pairings: [] },
        ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a pairing is labelled with the admitted person's Lazurio username, and only with one", () => {
  const named = (username: string | null) =>
    chatPairingLabel({ subject: null, username });
  expect(named("example")).toBe("Lazurio · example");
  expect(named("a1-b2")).toBe("Lazurio · a1-b2");
  // Nobody named: a session without a Lazurio username, or a terminal.
  expect(named(null)).toBe("Lazurio");
  expect(chatPairingLabel(nobody)).toBe("Lazurio");
  expect(chatPairingLabel()).toBe("Lazurio");
  // Anything that is not a Lazurio username names nobody: never an option
  // for a command line, a line break, a capital, a service account or the
  // account's id from before the username.
  for (const username of [
    "",
    "ex",
    "a".repeat(40),
    "-example",
    "--json",
    "exa mple",
    "example\nx",
    "exa--mple",
    "Example",
    "service-account-x",
    "0b9f2c3e-5d4a-4f6b-9c1d-2e3f4a5b6c7d",
  ])
    expect([username, named(username)]).toEqual([username, "Lazurio"]);
  // Short: at most 49 characters.
  expect(named("a".repeat(39))).toHaveLength(49);
});

test("only a page's own script fetch on its origin asks for the pairing", () => {
  const ownFetch = (headers: Record<string, string>) =>
    isChatPairingFetch(new Headers(headers));
  expect(
    ownFetch({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }),
  ).toBe(true);
  expect(
    ownFetch({
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "same-origin",
      "sec-fetch-dest": "empty",
    }),
  ).toBe(true);
  const own = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
  for (const headers of [
    {},
    { "sec-fetch-mode": "cors" },
    { "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" },
    { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" },
    { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" },
    { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
    { "sec-fetch-site": "same-origin", "sec-fetch-mode": "nested-navigate" },
    { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" },
    { "sec-fetch-site": "same-origin", "sec-fetch-mode": "websocket" },
    { ...own, "sec-purpose": "prefetch" },
    { ...own, "sec-purpose": "prefetch;anonymous-client-ip" },
    { ...own, "sec-purpose": "prefetch;prerender" },
    { ...own, purpose: "prefetch" },
    { ...own, purpose: "Prefetch" },
  ])
    expect([headers, ownFetch(headers)]).toEqual([headers, false]);
});

test.skipIf(process.platform === "win32")(
  "the operator pairing only where T3 Code says it offers it, never on a public Environment",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "launchpad-chat-mint-")),
    );
    await writeFile(join(directory, "t3"), "#!/bin/sh\nexit 1\n");
    await chmod(join(directory, "t3"), 0o755);
    try {
      const work = organizationWithEntry().entry;
      const visited = organizationWithEntry(
        20000,
        undefined,
        false,
        false,
        true,
      ).entry;
      if (work === undefined || visited === undefined)
        throw new Error("The fixtures have entries");
      // Which calls one pairing ran, by their subcommand and `--json`. As
      // T3's CLI, `t3 lazurio pairing` refuses a `--json` it does not know.
      const mint = async (
        entry: typeof work,
        capabilities: ToolProcessResult | Error,
      ) => {
        const calls: string[] = [];
        const environment: ToolsEnvironment = {
          path: directory,
          home: directory,
          platform: process.platform,
          run: async (command) => {
            const json = command.includes("--json");
            calls.push(
              `${command.slice(1, 3).join(" ")}${json ? " --json" : ""}`,
            );
            if (command[2] === "capabilities") {
              if (capabilities instanceof Error) throw capabilities;
              return capabilities;
            }
            if (command[1] === "--version")
              return { exitCode: 0, stdout: "t3 v0.1.1-lazurio.1", stderr: "" };
            if (command[1] === "lazurio" && json)
              return { exitCode: 1, stdout: "", stderr: "Unrecognized flag" };
            return { exitCode: 0, stdout: pairingOutput, stderr: "" };
          },
        };
        const pairing = await mintChatPairing(entry, environment, {
          subject: null,
          username: "example",
        });
        return { pairing, calls };
      };
      const answer = (stdout: string, exitCode = 0) => ({
        exitCode,
        stdout,
        stderr: "",
      });
      const offered = (value: unknown) =>
        answer(JSON.stringify({ version: 1, operatorPairing: value }));
      expect(await mint(work, offered(true))).toEqual({
        pairing: { kind: "chat-pairing", credential, expiresAt },
        calls: ["lazurio capabilities", "lazurio pairing"],
      });
      expect(
        (await mint(work, answer(capabilitiesOutput(true)))).calls,
      ).toEqual(["lazurio capabilities", "lazurio pairing"]);
      // Anything but `true`: today's standard pairing.
      for (const capabilities of [
        offered(false),
        offered("true"),
        offered(1),
        answer(capabilitiesOutput(false)),
        // A vanilla upstream T3 Code has no `lazurio` command.
        answer("", 1),
        answer("not json"),
        answer("[true]"),
        "timeout" as const,
        new Error("The capabilities could not be asked"),
      ])
        expect([
          capabilities,
          await mint(work, capabilities as ToolProcessResult | Error),
        ]).toEqual([
          capabilities,
          {
            pairing: { kind: "chat-pairing", credential, expiresAt },
            calls: ["lazurio capabilities", "--version", "auth pairing --json"],
          },
        ]);
      // A public Environment: the standard pairing, and T3 Code is not even
      // asked what it offers.
      expect(await mint(visited, offered(true))).toEqual({
        pairing: { kind: "chat-pairing", credential, expiresAt },
        calls: ["--version", "auth pairing --json"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("the page accepts only the entry's shape and a pairing link on the recorded T3 Code origin", () => {
  const entry = {
    launchpadOrigin: "https://launchpad.workspace.example.lazurio.io",
    t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
    moduleOriginTemplate: "https://{module}.workspace.example.lazurio.io",
  };
  expect(parseEntryAnswer({ kind: "entry", entry })).toEqual(entry);
  expect(chatHref(parseEntryAnswer({ kind: "entry", entry }))).toBe(
    entry.t3codeOrigin,
  );
  for (const answer of [
    null,
    { kind: "entry", entry: null },
    { kind: "other", entry },
    { kind: "entry", entry: { ...entry, t3codeOrigin: "http://t3code.x.io" } },
    {
      kind: "entry",
      entry: { ...entry, t3codeOrigin: "https://t3code.x.io/" },
    },
    {
      kind: "entry",
      entry: { ...entry, moduleOriginTemplate: "https://x.io" },
    },
  ])
    expect([answer, parseEntryAnswer(answer)]).toEqual([answer, null]);
  expect(chatHref(null)).toBeNull();

  const link = `${entry.t3codeOrigin}/pair#token=${credential}`;
  expect(
    chatPairLink({ kind: "chat-link", url: link }, entry.t3codeOrigin),
  ).toBe(link);
  for (const url of [
    `https://t3code.other.lazurio.io/pair#token=${credential}`,
    `${entry.t3codeOrigin}/pair?token=${credential}`,
    `${entry.t3codeOrigin}/pair?x=1#token=${credential}`,
    `${entry.t3codeOrigin}/other#token=${credential}`,
    `${entry.t3codeOrigin}/pair#token=short`,
    `${entry.t3codeOrigin}/pair`,
    `https://user@t3code.workspace.example.lazurio.io/pair#token=${credential}`,
  ])
    expect([
      url,
      chatPairLink({ kind: "chat-link", url }, entry.t3codeOrigin),
    ]).toEqual([url, null]);
  expect(
    chatPairLink(
      { kind: "blocked", reason: "t3-launcher-missing" },
      entry.t3codeOrigin,
    ),
  ).toBeNull();
  // The server's projection carries exactly these three values.
  expect(
    publicEntry({
      externalOrigin: entry.launchpadOrigin,
      authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
      authCookieName: "__Secure-lazurio-workspace",
      listenPort: 20000,
      t3codeOrigin: entry.t3codeOrigin,
      moduleOriginTemplate: entry.moduleOriginTemplate,
    }),
  ).toEqual(entry);
  expect(publicEntry(null)).toBeNull();
});

// "+ Nový modul" (Lazurio/t3code#35): the prompt by link, never its text.
test("the link carries the prompt's id and the Organization's login in the fragment, on Chat's origin only", () => {
  const origin = "https://t3code.workspace.example.lazurio.io";
  const prompt = { id: "new-module", organization: "Example-Org" };
  const token = "Pairing_Token-0123456789abcdef";
  expect(chatPromptHref(`${origin}/pair#token=${token}`, origin, prompt)).toBe(
    `${origin}/pair#token=${token}&lazurio-prompt=new-module&lazurio-org=Example-Org`,
  );
  // Without a pairing: Chat's plain origin, which asks to pair first.
  expect(chatPromptHref(origin, origin, prompt)).toBe(
    `${origin}/#lazurio-prompt=new-module&lazurio-org=Example-Org`,
  );
  // The personal space's "+ Nový modul": the person's own login.
  expect(
    chatPromptHref(`${origin}/pair#token=${token}`, origin, {
      id: "new-personal-module",
      organization: "example",
    }),
  ).toBe(
    `${origin}/pair#token=${token}&lazurio-prompt=new-personal-module&lazurio-org=example`,
  );
  // Never the text, and nothing in the query a server or log would see.
  const href = new URL(
    chatPromptHref(`${origin}/pair#token=${token}`, origin, prompt) ?? "",
  );
  expect(href.search).toBe("");
  for (const [base, value] of [
    ["https://t3code.other.lazurio.io/pair#token=x", prompt],
    [`https://user@t3code.workspace.example.lazurio.io/`, prompt],
    ["not a url", prompt],
    [origin, { id: "New Module", organization: "Example-Org" }],
    [origin, { id: "new-module", organization: "a/b" }],
    [origin, { id: "new-module", organization: "-x" }],
  ] as const)
    expect(chatPromptHref(base, origin, value)).toBeNull();
  expect(
    parsePromptHandoff({ kind: "chat-prompt-handoff", accepted: true }),
  ).toBe(true);
  for (const value of [
    { kind: "chat-prompt-handoff", accepted: false },
    { kind: "chat-prompt-handoff", accepted: "true" },
    { kind: "other", accepted: true },
    null,
    "yes",
  ])
    expect(parsePromptHandoff(value)).toBe(false);
});

test("the page's Chat entry is the switch at the top of the column (decision F36): outside every view, so it stands on every route, and no link in the markup", async () => {
  const html = await readFile(
    join(import.meta.dir, "..", "src", "launchpad", "index.html"),
    "utf8",
  );
  const head =
    /<lazurio-column-head id="column-head" active="apps" settings="\/settings\/general">/.exec(
      html,
    );
  expect(head).not.toBeNull();
  // Not inside a view-specific part of the column: the same switch on the
  // home, an Organization, a module, Files and Settings.
  const before = html.slice(html.indexOf('<aside class="column"'), head?.index);
  expect(before).not.toContain("data-view");
  // No origin is written into the page: the switch draws the shell
  // document's (`/.lazurio/shell.json`, from the recorded entry).
  expect(html).not.toContain('href="http');
  expect(html).not.toContain('id="chat"');
});

// The page composes no origin (docs/hosted-entry.md "Where every origin comes
// from"): no source of the Launchpad builds a hostname from labels. The one
// sanctioned substitution is `moduleOrigin` in hosted-entry.ts, which fills
// the recorded template's `{module}` slot.
test("no Launchpad source builds an https origin or hostname from labels", async () => {
  const directory = join(import.meta.dir, "..", "src", "launchpad");
  const sources = (await readdir(directory)).filter((name) =>
    /\.(ts|html)$/.test(name),
  );
  expect(sources).toContain("chat.ts");
  const composing = [
    // `https://${…}`: an origin from a value.
    /`https?:\/\/\$\{/,
    // "https://" + …
    /["']https?:\/\/["']\s*\+/,
    // `${label}.${…}` or label + "." + …: a hostname from labels.
    /\$\{[^}]+\}\.\$\{/,
    /\+\s*["']\.["']\s*\+/,
    // A deployment's domain written into code.
    /^(?!\s*(?:\/\/|\*|\/\*)).*lazurio\.io/m,
  ];
  const found: string[] = [];
  for (const name of sources) {
    const text = await readFile(join(directory, name), "utf8");
    for (const pattern of composing)
      if (pattern.test(text)) found.push(`${name}: ${pattern}`);
  }
  expect(found).toEqual([]);
});
