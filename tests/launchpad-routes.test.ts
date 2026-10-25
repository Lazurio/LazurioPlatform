import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  legacyVaultPaths,
  modulePath,
  organizationPath,
  pageFrame,
  pagePaths,
  pageRoute,
  routeFrame,
  routePath,
  routeTitle,
  settingsSections,
  vaultPath,
} from "../src/launchpad/routes";
import { secretRequestPath } from "../src/vault/request-id";

test("a path names the view and the settings section; the canonical path is one", () => {
  expect(pageRoute("/")).toEqual({ view: "home" });
  expect(pageRoute("/elsewhere")).toEqual({ view: "home" });
  expect(pageRoute("/settingsx")).toEqual({ view: "home" });
  expect(pageRoute("/settings")).toEqual({
    view: "settings",
    section: "general",
  });
  expect(pageRoute("/settings/")).toEqual({
    view: "settings",
    section: "general",
  });
  expect(pageRoute("/settings/tools")).toEqual({
    view: "settings",
    section: "tools",
  });
  expect(pageRoute("/settings/tools/")).toEqual({
    view: "settings",
    section: "tools",
  });
  expect(pageRoute("/settings/unknown")).toEqual({
    view: "settings",
    section: "general",
  });
  for (const section of settingsSections)
    expect(pageRoute(routePath({ view: "settings", section }))).toEqual({
      view: "settings",
      section,
    });
  expect(routePath({ view: "home" })).toBe("/");
  // The Marketplace at the foot of the Apps column (F36 addendum).
  expect(pageRoute("/marketplace/")).toEqual({ view: "marketplace" });
  expect(routePath({ view: "marketplace" })).toBe("/marketplace");
  expect(pagePaths).toEqual([
    "/",
    "/o/:organization",
    "/o/:organization/:module",
    "/files",
    "/files/*",
    "/integrations",
    "/integrations/*",
    // Trezor, a page of the Apps column (F53's addendum of 2026-10-18).
    "/vault",
    "/vault/requests/:id",
    "/marketplace",
    "/settings",
    // Začínáme, first in Settings (root decision 0201).
    "/settings/start",
    "/settings/general",
    "/settings/communication",
    "/settings/machine",
    "/settings/tools",
    "/settings/ssh",
    "/settings/recovery",
    // Nastavení → Buddy (decision F65), drawn only with Buddy.
    "/settings/buddy",
    // Trezor's old addresses, answered for good (F54 as amended).
    "/settings/vault",
    "/settings/vault/requests/:id",
  ]);
  expect(legacyVaultPaths).toEqual([
    "/settings/vault",
    "/settings/vault/requests/:id",
  ]);
});

// Trezor is a page of the Apps column (F53's addendum of 2026-10-18), and an
// agent's secret request its own page below it (decision F54 as amended).
test("Trezor is a page of the Apps column, an agent's secret request has its page below it, and any other path below it opens Trezor", () => {
  const id = "abcdefghijklmnopqrstuvwx";
  const request = { view: "vault", request: id } as const;
  expect(vaultPath).toBe("/vault");
  for (const path of ["/vault", "/vault/"])
    expect([path, pageRoute(path)]).toEqual([path, { view: "vault" }]);
  expect(routePath({ view: "vault" })).toBe("/vault");
  expect(routeFrame({ view: "vault" })).toBe("vault");
  expect(pageFrame("/vault")).toEqual({ frame: "vault", section: null });
  expect(pageRoute(`/vault/requests/${id}`)).toEqual(request);
  expect(pageRoute(`/vault/requests/${id}/`)).toEqual(request);
  expect(routePath(request)).toBe(`/vault/requests/${id}`);
  // The link `lazurio vault request` prints is the request's route.
  expect(secretRequestPath(id)).toBe(`/vault/requests/${id}`);
  expect(pageRoute(secretRequestPath(id))).toEqual(request);
  expect(routeFrame(request)).toBe("vault");
  for (const path of [
    "/vault/requests",
    "/vault/requests/",
    "/vault/requests/x",
    "/vault/requests/ABCDEFGHIJKLMNOPQRSTUVWX",
    `/vault/requests/${id}/extra`,
    `/vault/requests/${id.slice(0, 23)}%2F`,
    "/vault/elsewhere",
  ])
    expect([path, pageRoute(path)]).toEqual([path, { view: "vault" }]);
  // Not Trezor: a path that only starts like it.
  expect(pageRoute("/vaultx")).toEqual({ view: "home" });
  // No Settings section: Trezor is not in Settings any more.
  expect((settingsSections as readonly string[]).includes("vault")).toBe(false);
  // Its title is its own, never under Settings.
  expect(routeTitle({ view: "vault" }, messages("cs"))).toEqual({
    heading: "Trezor",
    document: "Trezor — Lazurio",
  });
  expect(routeTitle({ view: "vault" }, messages("en"))).toEqual({
    heading: "Vault",
    document: "Vault — Lazurio Launchpad",
  });
  expect(routeTitle(request, messages("cs"))).toEqual({
    heading: "Trezor",
    document: "Žádost agenta · Trezor — Lazurio",
  });
  expect(routeTitle(request, messages("en"))).toEqual({
    heading: "Vault",
    document: "Agent's request · Vault — Lazurio Launchpad",
  });
});

// Trezor's old addresses in Settings stay for good (F54 as amended on
// 2026-10-18): `lazurio vault request` printed them into agents' threads,
// which keep them. Each opens the same route as its new address, whose
// canonical path the page then writes into the address bar.
test("Trezor's old addresses in Settings open the same page, an agent's old request link the same request, under the new path", () => {
  const id = "abcdefghijklmnopqrstuvwx";
  for (const [old, now] of [
    ["/settings/vault", "/vault"],
    ["/settings/vault/", "/vault"],
    ["/settings/vault/requests", "/vault"],
    ["/settings/vault/requests/", "/vault"],
    [`/settings/vault/requests/${id}`, `/vault/requests/${id}`],
    [`/settings/vault/requests/${id}/`, `/vault/requests/${id}`],
    // An unknown or malformed id opens Trezor itself, as before.
    ["/settings/vault/requests/x", "/vault"],
    ["/settings/vault/requests/ABCDEFGHIJKLMNOPQRSTUVWX", "/vault"],
    [`/settings/vault/requests/${id}/extra`, "/vault"],
    [`/settings/vault/requests/${id.slice(0, 23)}%2F`, "/vault"],
  ] as const) {
    expect([old, pageRoute(old)]).toEqual([old, pageRoute(now)]);
    expect([old, routePath(pageRoute(old))]).toEqual([old, now]);
    expect([old, pageFrame(old)]).toEqual([
      old,
      { frame: "vault", section: null },
    ]);
  }
  // Anything else below it was never Trezor's and stays a Settings path.
  expect(pageRoute("/settings/vault/x")).toEqual({
    view: "settings",
    section: "general",
  });
  expect(pageRoute("/settings/vaultx")).toEqual({
    view: "settings",
    section: "general",
  });
});

test("the heading and document title follow the route in both languages", () => {
  expect(routeTitle({ view: "home" }, messages("en"))).toEqual({
    heading: "Launchpad",
    document: "Lazurio Launchpad",
  });
  expect(
    routeTitle({ view: "settings", section: "tools" }, messages("en")),
  ).toEqual({
    heading: "Tools",
    document: "Tools · Settings — Lazurio Launchpad",
  });
  expect(
    routeTitle({ view: "settings", section: "machine" }, messages("cs")),
  ).toEqual({
    heading: "Toto Prostředí",
    document: "Toto Prostředí · Nastavení — Lazurio",
  });
  // In the Environment it is shown in, Toto Prostředí names its kind, and on
  // your own computer it is Tento počítač (F28's addendum of 2026-10-18).
  for (const [kind, czech, english] of [
    ["personal", "Toto Osobní Prostředí", "This Personal Environment"],
    ["work", "Toto Pracovní Prostředí", "This Work Environment"],
    ["team", "Toto Týmové Prostředí", "This Team Environment"],
    ["automated", "Toto Pracovní Prostředí", "This Work Environment"],
    ["workstation", "Tento počítač", "This computer"],
  ] as const) {
    expect(
      routeTitle(
        { view: "settings", section: "machine" },
        messages("cs", kind),
      ),
    ).toEqual({
      heading: czech,
      document: `${czech} · Nastavení — Lazurio`,
    });
    expect(
      routeTitle({ view: "settings", section: "machine" }, messages("en", kind))
        .heading,
    ).toBe(english);
  }
  // SSH from your devices (decision F49).
  expect(pageRoute("/settings/ssh")).toEqual({
    view: "settings",
    section: "ssh",
  });
  expect(
    routeTitle({ view: "settings", section: "ssh" }, messages("en")),
  ).toEqual({
    heading: "SSH from your devices",
    document: "SSH from your devices · Settings — Lazurio Launchpad",
  });
  expect(
    routeTitle({ view: "settings", section: "ssh" }, messages("cs")).heading,
  ).toBe("SSH ze zařízení");
  // Settings keep their order without Trezor: SSH follows the tools, and
  // Nastavení → Buddy comes last (decision F65), shown only with Buddy.
  expect(settingsSections).toEqual([
    "start",
    "general",
    "communication",
    "machine",
    "tools",
    "ssh",
    "recovery",
    "buddy",
  ]);
  expect(pageRoute("/settings/buddy")).toEqual({
    view: "settings",
    section: "buddy",
  });
  expect(
    routeTitle({ view: "settings", section: "buddy" }, messages("cs")),
  ).toEqual({
    heading: "Buddy",
    document: "Buddy · Nastavení — Lazurio",
  });
});

test("the catalog routes: an Organization and a module, deep-linkable, one canonical path", () => {
  expect(pageRoute("/o/alpha")).toEqual({
    view: "organization",
    organization: "alpha",
  });
  expect(pageRoute("/o/alpha/")).toEqual({
    view: "organization",
    organization: "alpha",
  });
  expect(pageRoute("/o/alpha/web")).toEqual({
    view: "module",
    organization: "alpha",
    module: "web",
  });
  // Encoded segments are decoded once and encoded again for the address bar.
  expect(pageRoute("/o/Alpha%20Co/web")).toEqual({
    view: "module",
    organization: "Alpha Co",
    module: "web",
  });
  expect(routePath(pageRoute("/o/Alpha%20Co/web"))).toBe("/o/Alpha%20Co/web");
  expect(organizationPath("a/b")).toBe("/o/a%2Fb");
  expect(modulePath("alpha", "web")).toBe("/o/alpha/web");
  // Anything else under /o is the home, never a guessed route.
  for (const path of [
    "/o",
    "/o/",
    "/o/alpha/web/extra",
    "/o/%E0%A4%A",
    "/o/a%2Fb",
    "/o//web",
    "/ox/alpha",
  ])
    expect(pageRoute(path)).toEqual({ view: "home" });
  for (const route of [
    { view: "home" },
    { view: "organization", organization: "alpha" },
    { view: "module", organization: "alpha", module: "web" },
  ] as const) {
    expect(pageRoute(routePath(route))).toEqual(route);
    expect(routeFrame(route)).toBe("catalog");
  }
  expect(routeFrame({ view: "settings", section: "tools" })).toBe("settings");
});

test("a catalog title names the Organization by its display name once known", () => {
  const copy = messages("en");
  expect(
    routeTitle({ view: "organization", organization: "alpha" }, copy),
  ).toEqual({ heading: "alpha", document: "alpha — Lazurio Launchpad" });
  const names = (slug: string) =>
    slug === "alpha" ? "Alpha Company" : undefined;
  expect(
    routeTitle({ view: "organization", organization: "alpha" }, copy, names),
  ).toEqual({
    heading: "Alpha Company",
    document: "Alpha Company — Lazurio Launchpad",
  });
  expect(
    routeTitle(
      { view: "module", organization: "alpha", module: "web" },
      messages("cs"),
      names,
    ),
  ).toEqual({
    heading: "web",
    document: "web · Alpha Company — Lazurio",
  });
});

// Decision F35: the Files page is a route of the same page, a folder of the
// Documents folder per path, read by the same rules as the server's.
test("the Files routes: the Documents folder and the folders below it, one canonical path", () => {
  expect(pageRoute("/files")).toEqual({ view: "files", path: [] });
  expect(pageRoute("/files/")).toEqual({ view: "files", path: [] });
  expect(pageRoute("/files/%C3%9Akol/podklady/")).toEqual({
    view: "files",
    path: ["Úkol", "podklady"],
  });
  expect(routePath({ view: "files", path: ["Úkol", "Q3 (final)"] })).toBe(
    "/files/%C3%9Akol/Q3%20%28final%29",
  );
  expect(routePath(pageRoute("/files/%C3%9Akol"))).toBe("/files/%C3%9Akol");
  // A path the rules refuse opens the Documents folder itself.
  for (const path of ["/files/.ssh", "/files/a%2Fb", "/files/%E0%A4%A"])
    expect(pageRoute(path)).toEqual({ view: "files", path: [] });
  expect(pageRoute("/filesx")).toEqual({ view: "home" });
  expect(routeFrame({ view: "files", path: [] })).toBe("files");
  expect(routeTitle({ view: "files", path: [] }, messages("en"))).toEqual({
    heading: "Files",
    document: "Files — Lazurio Launchpad",
  });
  expect(routeTitle({ view: "files", path: ["Úkol"] }, messages("cs"))).toEqual(
    {
      heading: "Soubory",
      document: "Úkol · Soubory — Lazurio",
    },
  );
});
