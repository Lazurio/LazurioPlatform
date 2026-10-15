import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  modulePath,
  organizationPath,
  pagePaths,
  pageRoute,
  routeFrame,
  routePath,
  routeTitle,
  settingsSections,
} from "../src/launchpad/routes";

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
    "/marketplace",
    "/settings",
    "/settings/general",
    "/settings/communication",
    "/settings/machine",
    "/settings/tools",
    "/settings/vault",
    "/settings/ssh",
    "/settings/recovery",
    "/settings/vault/requests/:id",
  ]);
});

test("an agent's secret request has its page in Trezor; any other path below it opens Trezor", () => {
  const id = "abcdefghijklmnopqrstuvwx";
  const route = { view: "settings", section: "vault", request: id } as const;
  expect(pageRoute(`/settings/vault/requests/${id}`)).toEqual(route);
  expect(pageRoute(`/settings/vault/requests/${id}/`)).toEqual(route);
  expect(routePath(route)).toBe(`/settings/vault/requests/${id}`);
  expect(routeFrame(route)).toBe("settings");
  for (const path of [
    "/settings/vault",
    "/settings/vault/requests",
    "/settings/vault/requests/",
    "/settings/vault/requests/x",
    "/settings/vault/requests/ABCDEFGHIJKLMNOPQRSTUVWX",
    `/settings/vault/requests/${id}/extra`,
    `/settings/vault/requests/${id.slice(0, 23)}%2F`,
  ])
    expect([path, pageRoute(path)]).toEqual([
      path,
      { view: "settings", section: "vault" },
    ]);
  expect(routeTitle(route, messages("cs"))).toEqual({
    heading: "Trezor",
    document: "Žádost agenta · Trezor · Nastavení — Lazurio",
  });
  expect(
    routeTitle({ view: "settings", section: "vault" }, messages("en")),
  ).toEqual({
    heading: "Vault",
    document: "Vault · Settings — Lazurio Launchpad",
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
  // Nastavení → Trezor (root decision 0198 point 5), right after the tools.
  expect(pageRoute("/settings/vault")).toEqual({
    view: "settings",
    section: "vault",
  });
  expect(
    settingsSections.indexOf("vault") - settingsSections.indexOf("tools"),
  ).toBe(1);
  expect(
    routeTitle({ view: "settings", section: "vault" }, messages("cs")),
  ).toEqual({
    heading: "Trezor",
    document: "Trezor · Nastavení — Lazurio",
  });
  expect(
    routeTitle({ view: "settings", section: "vault" }, messages("en")).heading,
  ).toBe("Vault");
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
