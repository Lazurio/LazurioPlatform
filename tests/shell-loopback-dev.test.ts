import { expect, test } from "bun:test";
import { renderManual } from "../src/folder/manual";
import { presetProfile } from "../src/folder/presets";
import {
  localShellAsset,
  shellFontsPrefix,
  shellScriptPath,
} from "../src/launchpad/page";
import { isLocalShellAsset } from "../src/launchpad/server";
import {
  applicationEnvironment,
  shellScriptVariable,
} from "../src/modules/application-environment";
import { shellFontBase, shellFontBaseOf } from "../src/shell/fonts";
import { bindings } from "./fixtures/machine-bindings";

// 0249's DEV frame, decided 2026-11-25: a Module's app in DEV, started
// by the agent from a worktree on its own loopback port, loads the shell's
// script and fonts from the Launchpad's loopback listener. The Launchpad
// answers those two, and nothing else, without admission there; they carry
// CORS; the element takes its fonts beside the script; and Lazurio never
// gives a STAGING app the variable that makes the module kit insert the
// element as DEV.

const port = 20000;
const ask = (
  pathname: string,
  init: { method?: string; host?: string; peer?: string | null } = {},
) =>
  isLocalShellAsset(
    {
      method: init.method ?? "GET",
      pathname,
      headers: new Headers({
        host: init.host ?? `127.0.0.1:${port}`,
        // A browser on the DEV page sends both; they do not matter here.
        origin: "http://127.0.0.1:5173",
        "sec-fetch-mode": "cors",
      }),
      peer: init.peer === undefined ? "127.0.0.1" : init.peer,
    },
    port,
  );

test("the script and the fonts, straight on loopback, are answered without admission", () => {
  expect(ask(shellScriptPath)).toBe(true);
  expect(ask(`${shellFontsPrefix}inter-latin-wght-normal.woff2`)).toBe(true);
  expect(ask(shellScriptPath, { method: "HEAD" })).toBe(true);
  expect(ask(shellScriptPath, { host: `localhost:${port}` })).toBe(true);
  expect(ask(shellScriptPath, { host: `[::1]:${port}`, peer: "::1" })).toBe(
    true,
  );
  expect(ask(shellScriptPath, { peer: "::ffff:127.0.0.1" })).toBe(true);
});

test("nothing else, and nothing through the gateway, is", () => {
  // Through the gateway: the Launchpad's own Host.
  expect(ask(shellScriptPath, { host: "launchpad.example.lazurio.io" })).toBe(
    false,
  );
  // Another listener's port, another peer, no peer.
  expect(ask(shellScriptPath, { host: "127.0.0.1:4100" })).toBe(false);
  expect(ask(shellScriptPath, { peer: "100.64.0.7" })).toBe(false);
  expect(ask(shellScriptPath, { peer: null })).toBe(false);
  // Writes.
  expect(ask(shellScriptPath, { method: "POST" })).toBe(false);
  // The document, the account, the stones, the page, the files.
  for (const path of [
    "/.lazurio/shell.json",
    "/.lazurio/account/environments",
    "/.lazurio/stones/a.png",
    "/",
    "/files",
    "/.lazurio/fonts/",
    "/.lazurio/fonts/../shell.json",
    "/.lazurio/fonts/%2e%2e%2fshell.json",
    "/.lazurio/fonts/a/b.woff2",
    "/.lazurio/fonts/A.woff2",
    "/.lazurio/shell.js/x",
  ])
    expect(ask(path)).toBe(false);
});

test("the script and a font carry CORS and CORP; an unknown font is 404", async () => {
  const script = await localShellAsset(
    new Request(`http://127.0.0.1:${port}${shellScriptPath}`),
    shellScriptPath,
  );
  expect(script.status).toBe(200);
  expect(script.headers.get("access-control-allow-origin")).toBe("*");
  expect(script.headers.get("access-control-allow-credentials")).toBeNull();
  expect(script.headers.get("cross-origin-resource-policy")).toBe(
    "cross-origin",
  );
  expect(script.headers.get("content-type")).toContain("text/javascript");
  const fontPath = `${shellFontsPrefix}inter-latin-wght-normal.woff2`;
  const font = await localShellAsset(
    new Request(`http://127.0.0.1:${port}${fontPath}`),
    fontPath,
  );
  expect(font.status).toBe(200);
  expect(font.headers.get("access-control-allow-origin")).toBe("*");
  expect(font.headers.get("content-type")).toBe("font/woff2");
  const unknownPath = `${shellFontsPrefix}nothing.woff2`;
  const unknown = await localShellAsset(
    new Request(`http://127.0.0.1:${port}${unknownPath}`),
    unknownPath,
  );
  expect(unknown.status).toBe(404);
});

test("the fonts are beside a /.lazurio/shell.js, on the page's origin otherwise", () => {
  expect(shellFontBaseOf("http://127.0.0.1:20000/.lazurio/shell.js")).toBe(
    "http://127.0.0.1:20000/.lazurio/fonts/",
  );
  expect(shellFontBaseOf("https://app.example/.lazurio/shell.js?v=1")).toBe(
    "https://app.example/.lazurio/fonts/",
  );
  // The Launchpad bundles the elements itself: its own fonts path.
  expect(shellFontBaseOf("https://launchpad.example/assets/ui-1a2b.js")).toBe(
    shellFontBase,
  );
  expect(shellFontBaseOf("blob:https://x/1")).toBe(shellFontBase);
  expect(shellFontBaseOf("not a url")).toBe(shellFontBase);
  expect(shellFontBaseOf(undefined)).toBe(shellFontBase);
});

test("a STAGING app never gets the DEV page's shell script", () => {
  const environment = applicationEnvironment({
    base: {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      [shellScriptVariable]: "http://127.0.0.1:20000/.lazurio/shell.js",
    },
    cwd: "/tmp/app",
    plan: {
      runtime: { id: "app", schema_version: "1" },
      listeners: [
        {
          id: "app",
          role: "entrypoint",
          host: "127.0.0.1",
          port: 4310,
          protocol: "http",
          health: "/health",
        },
      ],
    } as unknown as Parameters<typeof applicationEnvironment>[0]["plan"],
  });
  expect(environment[shellScriptVariable]).toBeUndefined();
  expect(environment.PATH).toBe("/usr/bin");
});

test("the hosted manual names the DEV shell script with this Launchpad's port; a computer's does not", () => {
  for (const locale of ["cs", "en"] as const) {
    const working = (
      preset: "hosted-organization-personal" | "local",
      machine: typeof bindings.organizationEntry | null,
    ) =>
      renderManual({
        preset,
        machine,
        profile: presetProfile(preset, "linux", { locale }),
      })["manual/working-here.md"] ?? "";
    expect(
      working("hosted-organization-personal", bindings.organizationEntry),
    ).toContain(
      "`LAZURIO_RUNTIME_SHELL_SCRIPT=http://127.0.0.1:20000/.lazurio/shell.js`",
    );
    // It promises the frame only with versions that draw it (review of #1251).
    expect(
      working("hosted-organization-personal", bindings.organizationEntry),
    ).toMatch(
      locale === "cs"
        ? /Dokud tvoje verze module-kitu nebo Lazuria tohle neumí, stránka se od stabilní aplikace neliší/
        : /Until your module kit or Lazurio can do this, the page looks like the stable application/,
    );
    // A computer's Launchpad has no known loopback port: nothing to name.
    expect(working("local", null)).not.toContain(shellScriptVariable);
  }
});
