import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import { withFolderOperationLock } from "../src/folder/lock";
import { parseMachineEntry } from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import {
  bootElementId,
  bootJson,
  bootSchema,
  type LaunchpadBoot,
  parseBoot,
} from "../src/launchpad/boot";
import { launchpadBoot } from "../src/launchpad/boot-document";
import type { AuthFetcher } from "../src/launchpad/hosted-trust";
import { messages } from "../src/launchpad/messages";
import { notModified, shellEtag, shellSource } from "../src/launchpad/page";
import { startRecoveryMode } from "../src/launchpad/recovery-mode";
import { startLaunchpad } from "../src/launchpad/server";
import {
  createGithubProbe,
  createSetupCache,
} from "../src/launchpad/setup-state";
import { shellDocument } from "../src/launchpad/shell-document";
import { LaunchpadStartRefused } from "../src/launchpad/start-check";
import { readFolderCatalog } from "../src/organizations/catalog";
import { parseShell, type ShellSetup } from "../src/shell/contract";
import type { ToolRunner } from "../src/tools/status";
import { folderFixture, writeOrganization } from "./fixtures/catalog-folder";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// The hosted page's first paint (F36's addendum of 2026-10-08): a hosted
// Launchpad serves its page, after admission only, with its boot document
// and its words in the Folder's language, read from the Folder alone and
// never waited for; the page's assets keep their caching through the
// gateway; and `/.lazurio/shell.json` never waits for GitHub.

const posixTest = test.skipIf(process.platform === "win32");

const freePort = () => {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
};

test("the boot document reads back as written, and nothing in it ends its script", () => {
  const hostile = "Ex </script><script>alert(1)</script> <!-- \u2028\u2029";
  const shell = shellDocument({
    preset: "hosted-organization-personal",
    machine: organizationWithEntry(),
    locale: "cs",
    catalog: { kind: "catalog", organizations: [] },
  });
  const boot: LaunchpadBoot = {
    locale: "cs",
    shell,
    catalog: { kind: "catalog", organizations: [] },
    entry: {
      launchpadOrigin: "https://launchpad.workspace.example.lazurio.io",
      t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
      moduleOriginTemplate: "https://{module}.workspace.example.lazurio.io",
    },
  };
  const named = {
    ...boot,
    shell: {
      ...shell,
      environments: shell.environments.map((entry) => ({
        ...entry,
        label: hostile,
      })),
    },
  };
  const text = bootJson(named);
  expect(text).not.toContain("<");
  expect(text).not.toContain("\u2028");
  expect(text).not.toContain("\u2029");
  expect(JSON.parse(text).schema).toBe(bootSchema);
  // The hostile label reads back whole.
  expect(parseBoot(text)?.shell?.environments[0]?.label).toBe(hostile);
  expect(parseBoot(bootJson(boot))).toEqual(boot);
  for (const wrong of [
    null,
    undefined,
    "",
    "{",
    "[]",
    "null",
    JSON.stringify({ ...JSON.parse(bootJson(boot)), schema: "other" }),
    JSON.stringify({ ...JSON.parse(bootJson(boot)), locale: "de" }),
  ])
    expect([wrong, parseBoot(wrong)]).toEqual([wrong, null]);
  // A member that does not parse is null; the page reads it itself.
  const broken = parseBoot(
    JSON.stringify({
      ...JSON.parse(bootJson(boot)),
      shell: { schema: "other" },
      catalog: { kind: "other" },
      entry: { launchpadOrigin: "http://insecure.example" },
    }),
  );
  expect(broken).toEqual({
    locale: "cs",
    shell: null,
    catalog: null,
    entry: null,
  });
});

test("the boot document carries the shell document without setup, the catalog and only the entry's public parts", async () => {
  await folderFixture(async (folder) => {
    const catalog = await readFolderCatalog(folder);
    const machine = organizationWithEntry(24_000);
    const entry = parseMachineEntry({
      externalOrigin: "https://launchpad.workspace.example.lazurio.io",
      authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
      authCookieName: "__Secure-lazurio-workspace",
      listenPort: 24_000,
      t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
      moduleOriginTemplate: "https://{module}.workspace.example.lazurio.io",
    });
    const boot = launchpadBoot({
      preset: "hosted-organization-personal",
      machine,
      locale: "cs",
      catalog,
      entry,
      tailnet: "https://headscale.example.lazurio.io",
    });
    const expected = shellDocument({
      preset: "hosted-organization-personal",
      machine,
      locale: "cs",
      catalog,
    });
    expect(boot.shell).toEqual({ ...expected, offlineGuide: true });
    expect(boot.shell?.setup).toBeUndefined();
    expect(boot.catalog).toEqual(catalog);
    expect(boot.entry).toEqual({
      launchpadOrigin: entry.externalOrigin,
      t3codeOrigin: entry.t3codeOrigin,
      moduleOriginTemplate: entry.moduleOriginTemplate,
    });
    const text = bootJson(boot);
    for (const secret of [
      entry.authCheckUrl,
      entry.authCookieName,
      "oauth2",
      "listenPort",
      "authCheckUrl",
      "Bearer",
    ])
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    expect(parseBoot(text)).toEqual(boot);
    // Without a tailnet no guide; an entry with no base host no document.
    expect(
      launchpadBoot({
        preset: "hosted-organization-personal",
        machine,
        locale: "cs",
        catalog,
        entry,
        tailnet: null,
      }).shell,
    ).toEqual(expected);
    expect(
      launchpadBoot({
        preset: "hosted-organization-personal",
        machine: organizationWithEntry(24_000, "example.com"),
        locale: "en",
        catalog,
        entry,
        tailnet: null,
      }).shell,
    ).toBeNull();
  });
});

test("the shell's setup is read in the background and never awaited", async () => {
  let clock = 0;
  const asked: ((setup: ShellSetup | undefined) => void)[] = [];
  const read = () =>
    new Promise<ShellSetup | undefined>((resolve) => asked.push(resolve));
  const cache = createSetupCache(read, { ttlMs: 1000, now: () => clock });
  // Nothing known: nothing said, one reading asked, never two at once.
  expect(cache.peek()).toBeUndefined();
  expect(cache.peek()).toBeUndefined();
  expect(asked.length).toBe(1);
  asked[0]?.({ github: "missing" });
  await cache.settled();
  expect(cache.peek()).toEqual({ github: "missing" });
  expect(asked.length).toBe(1);
  // Older than the TTL: the last reading still answers, a new one runs.
  clock = 1500;
  expect(cache.peek()).toEqual({ github: "missing" });
  expect(asked.length).toBe(2);
  asked[1]?.({ github: "connected", content: "ready" });
  await cache.settled();
  expect(cache.peek()).toEqual({ github: "connected", content: "ready" });
  // Forgotten while a reading runs: nothing said, and that reading is not
  // kept; the next one is.
  clock = 3000;
  expect(cache.peek()).toEqual({ github: "connected", content: "ready" });
  expect(asked.length).toBe(3);
  cache.forget();
  expect(cache.peek()).toBeUndefined();
  expect(asked.length).toBe(4);
  asked[2]?.({ github: "connected", content: "ready" });
  await Bun.sleep(0);
  expect(cache.peek()).toBeUndefined();
  asked[3]?.({ github: "missing" });
  await cache.settled();
  expect(cache.peek()).toEqual({ github: "missing" });
  // A failed reading says nothing, and is asked again later.
  const failing = createSetupCache(() => Promise.reject(new Error("x")));
  expect(failing.peek()).toBeUndefined();
  await failing.settled();
  expect(failing.peek()).toBeUndefined();
});

test("a Tools reading says whether it changed GitHub's state", () => {
  const probe = createGithubProbe({
    path: undefined,
    home: undefined,
    platform: process.platform,
    run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
  });
  expect(probe.remember(true, { state: "signed-out" })).toBe(true);
  expect(probe.remember(true, { state: "signed-out" })).toBe(false);
  expect(probe.remember(true, undefined)).toBe(false);
  expect(probe.remember(true, { state: "signed-in" })).toBe(true);
  expect(probe.remember(false, undefined)).toBe(true);
});

test("the shell script is revalidated by its ETag", () => {
  const asked = (value?: string) =>
    new Request("http://launchpad.invalid/.lazurio/shell.js", {
      headers: value === undefined ? {} : { "if-none-match": value },
    });
  expect(shellEtag).toMatch(/^"[0-9a-f]{32}"$/);
  expect(notModified(asked(), shellEtag)).toBe(false);
  expect(notModified(asked(shellEtag), shellEtag)).toBe(true);
  expect(notModified(asked(`W/${shellEtag}`), shellEtag)).toBe(true);
  expect(notModified(asked(`"other", ${shellEtag}`), shellEtag)).toBe(true);
  expect(notModified(asked("*"), shellEtag)).toBe(true);
  expect(notModified(asked('"other"'), shellEtag)).toBe(false);
});

// A hosted work Environment in Czech whose gh is signed out (`run`), with
// one Organization in its Folder; `displayName` its name.
async function hosted(
  options: Readonly<{ run?: ToolRunner; displayName?: string }> = {},
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-first-paint-")),
  );
  const home = join(parent, "home");
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await Bun.write(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  await Bun.$`chmod 755 ${join(bin, "gh")}`;
  await mkdir(join(home, "Documents"), { mode: 0o700 });
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  await mkdir(join(folder, "personalspace"), { mode: 0o700 });
  await writeOrganization(folder, "example_GEN3", {
    slug: "example",
    state: "current",
    modules: [{ id: "deals" }],
    ...(options.displayName === undefined
      ? {}
      : { displayName: options.displayName }),
  });
  const preset = "hosted-organization-personal";
  const machine = organizationWithEntry(freePort());
  const entry = machine.entry;
  if (entry === undefined) throw new Error("The fixture has an entry");
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  const fetcher: AuthFetcher = async (_url, init) =>
    new Headers(init.headers).get("cookie") ===
    "__Secure-lazurio-workspace=valid"
      ? new Response("ok")
      : new Response("no", { status: 401 });
  const run: ToolRunner =
    options.run ??
    (async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "You are not logged into any GitHub hosts.",
    }));
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    { fetcher },
    { path: bin, home, platform: process.platform, run },
    {},
    undefined,
    undefined,
    { home, platform: process.platform, folder },
  );
  const host = new URL(entry.externalOrigin).host;
  return {
    folder,
    entry,
    base: `http://127.0.0.1:${entry.listenPort}`,
    host,
    valid: { host, cookie: "__Secure-lazurio-workspace=valid" },
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const bootOf = (html: string) =>
  new RegExp(
    `<script type="application/json" id="${bootElementId}">([\\s\\S]*?)</script>`,
  ).exec(html)?.[1];

posixTest(
  "hosted: after admission the page carries its boot document and is in the Folder's language",
  async () => {
    const name = "Example </script><script>alert(1)</script> s.r.o.";
    const app = await hosted({ displayName: name });
    try {
      const { base, host, valid, entry } = app;
      // Nothing before admission, not even the page.
      const anonymous = await fetch(`${base}/`, { headers: { host } });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.text()).not.toContain(bootElementId);
      const answer = await fetch(`${base}/settings/tools`, { headers: valid });
      expect(answer.status).toBe(200);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(answer.headers.get("content-type")).toContain("text/html");
      const html = await answer.text();
      expect(html).toContain('<html lang="cs" data-lazurio-shell="host">');
      const cs = messages("cs");
      expect(html).toContain(`data-message="appsAll">${cs.appsAll}<`);
      expect(html).toContain(`data-message="toolsTitle">${cs.toolsTitle}<`);
      expect(html).toContain(`data-message="settingsBack">${cs.settingsBack}<`);
      expect(html).toContain(
        `aria-live="polite">${cs.catalogLoading}</p>\n<div id="catalog-body"`,
      );
      expect(html).not.toContain(">Reading Organizations…<");
      // One boot document, at the end of the head; the hostile name is
      // escaped in it and reads back whole.
      expect(html.split(bootElementId).length).toBe(2);
      expect(html.indexOf(bootElementId)).toBeLessThan(html.indexOf("</head>"));
      const text = bootOf(html);
      expect(text).toBeDefined();
      expect(text).not.toContain("</script");
      const boot = parseBoot(text);
      expect(boot?.locale).toBe("cs");
      expect(boot?.shell?.locale).toBe("cs");
      expect(boot?.shell?.setup).toBeUndefined();
      expect(
        boot?.shell?.organizations.find((entry) => entry.slug === "example")
          ?.name,
      ).toBe(name);
      expect(
        boot?.catalog?.organizations.map((entry) => entry.organization),
      ).toEqual(["example"]);
      expect(boot?.entry?.t3codeOrigin).toBe(entry.t3codeOrigin);
      for (const secret of [entry.authCheckUrl, entry.authCookieName])
        expect(text?.includes(secret)).toBe(false);
      // The shell document says the same, but for what it reads later.
      const shell = parseShell(
        await (
          await fetch(`${base}/.lazurio/shell.json`, { headers: valid })
        ).json(),
      );
      expect(shell === null ? null : { ...shell, setup: undefined }).toEqual(
        boot?.shell === null || boot?.shell === undefined
          ? null
          : { ...boot.shell, setup: undefined },
      );
      // Every page route is the same page; Files' too.
      const home = await (await fetch(`${base}/`, { headers: valid })).text();
      expect(home).toBe(html);
      const files = await fetch(`${base}/files`, { headers: valid });
      expect(files.status).toBe(200);
      expect(bootOf(await files.text())).toBe(text);
    } finally {
      await app.close();
    }
  },
  30_000,
);

posixTest(
  "hosted: the page's assets keep their caching through the gateway; data and missing files are never stored",
  async () => {
    const app = await hosted();
    try {
      const { base, valid } = app;
      const html = await (await fetch(`${base}/`, { headers: valid })).text();
      const assets = [
        ...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(\/[^"]*)"/g),
      ].map((match) => match[1] as string);
      expect(assets.length).toBeGreaterThanOrEqual(3);
      for (const path of assets) {
        const asset = await fetch(`${base}${path}`, { headers: valid });
        expect([
          path,
          asset.status,
          asset.headers.get("cache-control"),
        ]).toEqual([path, 200, "public, max-age=31536000, immutable"]);
        expect(asset.headers.get("etag")).not.toBeNull();
        expect(await asset.text()).not.toContain(
          '<script type="application/json"',
        );
      }
      for (const path of [
        "/.lazurio/fonts/inter-tight-latin-wght-normal.woff2",
        "/.lazurio/stones/deals-96.png",
      ]) {
        const asset = await fetch(`${base}${path}`, { headers: valid });
        await asset.arrayBuffer();
        expect([
          path,
          asset.status,
          asset.headers.get("cache-control"),
        ]).toEqual([path, 200, "public, max-age=604800, immutable"]);
      }
      // The shell's script: revalidated, and unchanged it costs no body.
      const script = await fetch(`${base}/.lazurio/shell.js`, {
        headers: valid,
      });
      expect(script.headers.get("cache-control")).toBe("no-cache");
      expect(script.headers.get("etag")).toBe(shellEtag);
      expect(await script.text()).toBe(shellSource);
      const unchanged = await fetch(`${base}/.lazurio/shell.js`, {
        headers: { ...valid, "if-none-match": shellEtag },
      });
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("etag")).toBe(shellEtag);
      expect(await unchanged.text()).toBe("");
      const changed = await fetch(`${base}/.lazurio/shell.js`, {
        headers: { ...valid, "if-none-match": '"older"' },
      });
      expect(changed.status).toBe(200);
      expect(await changed.text()).toBe(shellSource);
      // Not before admission, not even revalidated.
      expect(
        (
          await fetch(`${base}/.lazurio/shell.js`, {
            headers: { host: app.host, "if-none-match": shellEtag },
          })
        ).status,
      ).toBe(401);
      for (const path of ["/chunk-missing.js", "/.lazurio/shell.json"]) {
        const answer = await fetch(`${base}${path}`, { headers: valid });
        await answer.arrayBuffer();
        expect([path, answer.headers.get("cache-control")]).toEqual([
          path,
          "no-store",
        ]);
      }
      const entry = await fetch(`${base}/api/entry`, { headers: valid });
      expect(entry.headers.get("cache-control")).toBe("no-store");
    } finally {
      await app.close();
    }
  },
  30_000,
);

posixTest(
  "hosted: neither the page nor the shell document waits for GitHub; the shell says what is missing once it is known",
  async () => {
    // gh answers each question after a second and a half: two questions,
    // three seconds, as a slow GitHub would.
    const run: ToolRunner = async (command) => {
      if (command.includes("auth")) await Bun.sleep(1500);
      return {
        exitCode: 1,
        stdout: "",
        stderr: "You are not logged into any GitHub hosts.",
      };
    };
    const app = await hosted({ run });
    try {
      const { base, valid } = app;
      const timed = async (path: string) => {
        const started = performance.now();
        const answer = await fetch(`${base}${path}`, { headers: valid });
        const body = await answer.text();
        return { answer, body, ms: performance.now() - started };
      };
      const first = await timed("/.lazurio/shell.json");
      expect(first.answer.status).toBe(200);
      expect(first.ms).toBeLessThan(1000);
      expect(parseShell(JSON.parse(first.body))?.setup).toBeUndefined();
      const html = await timed("/");
      expect(html.ms).toBeLessThan(1000);
      expect(parseBoot(bootOf(html.body))?.shell).not.toBeNull();
      let setup: ShellSetup | undefined;
      for (let attempt = 0; attempt < 100 && setup === undefined; attempt++) {
        await Bun.sleep(100);
        const next = await timed("/.lazurio/shell.json");
        expect(next.ms).toBeLessThan(1000);
        setup = parseShell(JSON.parse(next.body))?.setup;
      }
      expect(setup?.github).toBe("missing");
    } finally {
      await app.close();
    }
  },
  30_000,
);

posixTest(
  "hosted: a Folder held by another operation serves the page at once, without its boot document",
  async () => {
    const app = await hosted();
    try {
      const { base, valid, folder } = app;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = withFolderOperationLock(
        join(folder, ".lazurio"),
        () => held,
      );
      try {
        const started = performance.now();
        const answer = await fetch(`${base}/`, { headers: valid });
        const html = await answer.text();
        expect(answer.status).toBe(200);
        expect(performance.now() - started).toBeLessThan(1500);
        expect(html).not.toContain(bootElementId);
        // The page names its words in English then, and reads the rest.
        expect(html).toContain('<html lang="en"');
      } finally {
        release();
        await holding;
      }
    } finally {
      await app.close();
    }
  },
  30_000,
);

posixTest(
  "locally the page carries no boot document; the shell script is revalidated there too",
  async () => {
    await folderFixture(async (folder) => {
      const app = await startLaunchpad(folder);
      try {
        const session = new URL(app.url);
        const html = await (await fetch(new URL("/", session))).text();
        expect(html).not.toContain(bootElementId);
        const unchanged = await fetch(new URL("/.lazurio/shell.js", session), {
          headers: { "if-none-match": shellEtag },
        });
        expect(unchanged.status).toBe(304);
      } finally {
        await app.close();
      }
    });
  },
  30_000,
);

posixTest(
  "hosted Recovery mode still serves the page, as before, with nothing of the Folder in it",
  async () => {
    const entry = parseMachineEntry({
      externalOrigin: "https://launchpad.workspace.example.lazurio.io",
      authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
      authCookieName: "__Secure-lazurio-workspace",
      listenPort: freePort(),
      t3codeOrigin: "https://t3code.workspace.example.lazurio.io",
      moduleOriginTemplate: "https://{module}.workspace.example.lazurio.io",
    });
    const recovery = await startRecoveryMode({
      refusal: new LaunchpadStartRefused("folder-state-unreadable", entry),
      hostedOptions: { fetcher: async () => new Response("ok") },
    });
    try {
      const answer = await fetch(
        `http://127.0.0.1:${entry.listenPort}/settings/recovery`,
        {
          headers: {
            host: "launchpad.workspace.example.lazurio.io",
            cookie: "__Secure-lazurio-workspace=valid",
          },
        },
      );
      expect(answer.status).toBe(503);
      const html = await answer.text();
      expect(html).toContain("<html");
      expect(html).not.toContain(bootElementId);
    } finally {
      await recovery.close();
    }
  },
  30_000,
);
