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
import { chatPairing, publicEntry, t3PairUrl } from "../src/launchpad/chat";
import {
  chatHref,
  chatPairLink,
  parseEntryAnswer,
} from "../src/launchpad/chat-view";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { startLaunchpad } from "../src/launchpad/server";
import { runTool, type ToolRunner } from "../src/tools/status";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// Chat into T3 Code (launchpad-parity B8, slice P7): the resident's behaviour
// (`R:launchpad/src/t3-chat-lib.mjs`, `R:launchpad/public/app.js:2257-2281`)
// with every value from the recorded entry.

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

const credential = "Pairing_Token-0123456789abcdef";

// A fake T3 launcher on a private PATH: it records its arguments and answers
// as `t3 auth pairing create --json` does, or as told by `mode`.
async function fakeLauncher(directory: string, mode: string) {
  const script = join(directory, "t3");
  const outputs: Record<string, string> = {
    ok: `echo '{"credential":"${credential}","label":"launchpad-chat"}'`,
    // A failing call whose output holds the credential: never passed on.
    fail: `echo 'could not pair ${credential}' >&2; exit 3`,
    unreadable: "echo 'not json'",
    shape: `echo '{"credential":"short"}'`,
  };
  await writeFile(
    script,
    `#!/bin/sh
printf '%s\\n' "$@" > "${join(directory, "t3.calls")}"
${outputs[mode]}
`,
  );
  await chmod(script, 0o755);
}

async function hostedLaunchpad() {
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
  const preset = "hosted-organization-personal";
  const machine = organizationWithEntry(freePort());
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
      ? new Response("ok")
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
  return {
    entry,
    home,
    bin,
    base,
    host,
    valid,
    runs,
    pair,
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
  "hosted: Chat mints a one-time pairing link on the recorded T3 Code origin with the resident's exact call",
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
      // The resident's call (`R:launchpad/src/t3-chat-lib.mjs:75` over
      // Machines' `t3 auth pairing create --base-dir ~/.t3`), with only
      // HOME and PATH of this Launchpad's environment.
      expect(runs).toEqual([
        {
          command: [
            join(bin, "t3"),
            "auth",
            "pairing",
            "create",
            "--base-dir",
            join(home, ".t3"),
            "--ttl",
            "60s",
            "--label",
            "launchpad-chat",
            "--json",
          ],
          timeoutMs: chatPairing.timeoutMs,
          env: { HOME: home, PATH: bin },
        },
      ]);
      expect(
        (await readFile(join(bin, "t3.calls"), "utf8")).trim().split("\n"),
      ).toEqual(runs[0]?.command.slice(1) ?? []);

      // A failed call, output that is not the answer, or a credential of
      // another shape: one reason, and the tool's output never passed on.
      for (const mode of ["fail", "unreadable", "shape"]) {
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
      expect(ran).toBe(false);
    } finally {
      await app.server.stop(true);
      await rm(parent, { recursive: true, force: true });
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
