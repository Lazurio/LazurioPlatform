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
  expect(pagePaths).toEqual([
    "/",
    "/o/:organization",
    "/o/:organization/:module",
    "/settings",
    "/settings/general",
    "/settings/machine",
    "/settings/tools",
    "/settings/recovery",
  ]);
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
    heading: "Tenhle Environment",
    document: "Tenhle Environment · Nastavení — Lazurio Launchpad",
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
    document: "web · Alpha Company — Lazurio Launchpad",
  });
});
