import { expect, test } from "bun:test";
import {
  type BrowserCookie,
  githubLoginOf,
  githubSessionCookies,
  sweepCookies,
  sweptCookie,
} from "../src/browser/people/cookies";
import { readViewPublic } from "../src/browser/people/serve";
import { observeEnvironmentBrowser } from "../src/browser/units";
import { doctorContextRules } from "../src/doctor/doctor";

// LazurioPlatform#504 (F39's addendum of 2026-10-18): the view removes every
// Lazurio session from the Environment browser whenever it reaches it, keeps
// a module's own cookies, and in a public Environment also github.com's
// session; elsewhere it keeps that sign-in and says whose it is. A scripted
// DevTools peer answers `Storage.getCookies` and `Storage.setCookies` as
// Chrome 155 does at the browser target (removal by an expired cookie, which
// scripts/proof-browser-loopback-entry.ts runs against a real Chrome).

const base = "try-01.example.lazurio.io";
const cookie = (
  name: string,
  domain: string,
  extra: Partial<BrowserCookie> = {},
): BrowserCookie => ({
  name,
  value: "v",
  domain,
  path: "/",
  secure: true,
  ...extra,
});

const lazurio = [
  cookie("KEYCLOAK_SESSION", "auth.lazurio.ai", { path: "/realms/lazurio/" }),
  cookie("KEYCLOAK_IDENTITY", "auth.lazurio.ai", { path: "/realms/lazurio/" }),
  cookie("__Host-dashboard-session", "dashboard.lazurio.ai"),
  cookie("lazurio_consent", ".lazurio.ai", { secure: false }),
  cookie("__Secure-lazurio-workspace", `.${base}`),
  cookie("__Secure-lazurio-workspace_0", `.${base}`),
  cookie("__Secure-lazurio-workspace_1", `.${base}`),
  cookie("__Secure-lazurio-workspace", ".team-01.example.lazurio.io"),
  cookie("__Host-lazurio-public-notice", base),
];
const modules = [
  cookie("session", `mission-control.${base}`),
  cookie("csrf", `.${base}`, { secure: false }),
  cookie("theme", `deals.${base}`, { partitionKey: { topLevelSite: "x" } }),
];
const github = [
  cookie("user_session", "github.com", { value: "s" }),
  cookie("__Host-user_session_same_site", "github.com", { value: "s" }),
  cookie("logged_in", ".github.com", { value: "yes" }),
  cookie("dotcom_user", ".github.com", { value: "octocat" }),
  cookie("_gh_sess", "github.com"),
  cookie("_octo", ".github.com"),
];
const elsewhere = [
  cookie("SID", ".google.com"),
  cookie("session", "lazurio.ai.example.com"),
  cookie("__Secure-lazurio-workspace", "example.com"),
  cookie("user_session", "notgithub.com"),
];

test("which cookies go: every Lazurio session, the gateway's cookies, in a public Environment github.com's session; nothing else", () => {
  for (const found of lazurio) {
    expect(sweptCookie(found, false), `${found.name}@${found.domain}`).toBe(
      true,
    );
    expect(sweptCookie(found, true)).toBe(true);
  }
  for (const found of [...modules, ...elsewhere])
    for (const isPublic of [false, true])
      expect(
        sweptCookie(found, isPublic),
        `${found.name}@${found.domain}`,
      ).toBe(false);
  for (const found of github)
    expect(sweptCookie(found, false), found.name).toBe(false);
  expect(
    github.filter((found) => sweptCookie(found, true)).map((c) => c.name),
  ).toEqual([...githubSessionCookies]);
});

test("whom github.com's sign-in names: dotcom_user when logged_in is yes, a GitHub login only", () => {
  expect(githubLoginOf(github)).toBe("octocat");
  expect(githubLoginOf([])).toBeNull();
  const replaced = (name: string, value: string) =>
    github.map((found) => (found.name === name ? { ...found, value } : found));
  expect(githubLoginOf(replaced("logged_in", "no"))).toBeNull();
  for (const value of ["", "-octo", "octo--cat", "a".repeat(40), "o c"])
    expect(githubLoginOf(replaced("dotcom_user", value)), value).toBeNull();
  // Only github.com's own cookies.
  expect(
    githubLoginOf(
      github.map((found) => ({ ...found, domain: ".github.com.example" })),
    ),
  ).toBeNull();
});

/** A browser target that keeps cookies as Chrome does: one per name,
 * domain, path and partition; an expired one set again removes it. */
function fakeBrowser(initial: readonly BrowserCookie[], refuse = false) {
  let jar = [...initial];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const key = (c: Record<string, unknown>) =>
    JSON.stringify([c.name, c.domain, c.path, c.partitionKey ?? null]);
  return {
    calls,
    jar: () => jar,
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "Storage.getCookies") return { cookies: jar };
      if (method === "Storage.setCookies") {
        if (refuse) return {};
        for (const set of params.cookies as Record<string, unknown>[]) {
          const domain =
            set.domain ?? new URL(String(set.url)).hostname.toLowerCase();
          if (Number(set.expires) < Date.now() / 1000)
            jar = jar.filter(
              (c) =>
                key(c) !==
                key({
                  name: set.name,
                  domain,
                  path: set.path,
                  partitionKey: set.partitionKey,
                }),
            );
        }
        return {};
      }
      throw new Error(`${method} wasn't found`);
    },
  };
}

test("a sweep removes them at the browser target and keeps the rest; a public Environment's also loses github.com's session", async () => {
  const all = [...lazurio, ...modules, ...github, ...elsewhere];
  const work = fakeBrowser(all);
  expect(await sweepCookies(work, false)).toEqual({
    removed: lazurio.length,
    remaining: 0,
    github: "octocat",
  });
  expect(work.jar()).toEqual([...modules, ...github, ...elsewhere]);
  // One removal call: each cookie set again, already expired, with its
  // domain, or its host's URL for a host-only cookie; no value is read back
  // into anything but the GitHub login.
  const removal = work.calls.filter((c) => c.method === "Storage.setCookies");
  expect(removal).toHaveLength(1);
  const sent = removal[0]?.params.cookies as Record<string, unknown>[];
  expect(sent.find((c) => c.name === "KEYCLOAK_SESSION")).toEqual({
    name: "KEYCLOAK_SESSION",
    value: "",
    path: "/realms/lazurio/",
    secure: true,
    expires: 1,
    url: "https://auth.lazurio.ai/realms/lazurio/",
  });
  expect(sent.find((c) => c.name === "lazurio_consent")).toEqual({
    name: "lazurio_consent",
    value: "",
    path: "/",
    secure: false,
    expires: 1,
    domain: ".lazurio.ai",
  });

  const visitors = fakeBrowser(all);
  expect(await sweepCookies(visitors, true)).toEqual({
    removed: lazurio.length + githubSessionCookies.length,
    remaining: 0,
    github: null,
  });
  expect(visitors.jar().map((c) => `${c.name}@${c.domain}`)).toEqual(
    [
      ...modules,
      ...github.filter((c) => !githubSessionCookies.includes(c.name)),
      ...elsewhere,
    ].map((c) => `${c.name}@${c.domain}`),
  );

  // Nothing to remove: one read, no write.
  const clean = fakeBrowser(modules);
  expect(await sweepCookies(clean, false)).toEqual({
    removed: 0,
    remaining: 0,
    github: null,
  });
  expect(clean.calls.map((c) => c.method)).toEqual(["Storage.getCookies"]);

  // A browser that keeps them anyway: counted, never claimed removed.
  const stubborn = fakeBrowser(lazurio, true);
  expect(await sweepCookies(stubborn, false)).toEqual({
    removed: 0,
    remaining: lazurio.length,
    github: null,
  });
});

test("public is the handover's audience, else the Folder's record; neither readable is not public", async () => {
  const none = async () => undefined;
  expect(await readViewPublic(async () => "public", none)).toBe(true);
  expect(await readViewPublic(async () => undefined, none)).toBe(false);
  const unreadable = async (): Promise<"public" | undefined> => {
    throw new Error("custody");
  };
  expect(await readViewPublic(unreadable, none)).toBe(false);
  expect(
    await readViewPublic(unreadable, async () => {
      throw new Error("no folder");
    }),
  ).toBe(false);
});

test("doctor says whom the browser's GitHub sign-in names, a login only", async () => {
  const observed = (body: unknown) =>
    observeEnvironmentBrowser({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000/nonexistent" },
      supervised: true,
      hosted: async () => true,
      entry: { origin: `https://browser.${base}`, listenPort: 4848 },
      run: async () => ({
        exitCode: 0,
        stdout: "LoadState=loaded\nActiveState=active\n",
        stderr: "",
      }),
      fetch: async (url) =>
        new Response(url.includes("4848") ? JSON.stringify(body) : "{}", {
          status: 200,
        }),
    });
  expect(
    await observed({ ok: true, browser: "connected", github: "octocat" }),
  ).toEqual({ outcome: "ok", context: { github: "octocat" } });
  for (const body of [
    { ok: true, browser: "connected", github: null },
    { ok: true, browser: "connected" },
    { ok: true, github: "not a login" },
    "not an object",
  ])
    expect(await observed(body), JSON.stringify(body)).toEqual({
      outcome: "ok",
    });
  expect(doctorContextRules.github?.("octocat")).toBe(true);
  expect(doctorContextRules.github?.("user_session=abc")).toBe(false);
});
