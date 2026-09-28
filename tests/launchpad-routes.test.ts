import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  pagePaths,
  pageRoute,
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
    "/settings",
    "/settings/general",
    "/settings/machine",
    "/settings/tools",
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
    heading: "Tahle Mašina",
    document: "Tahle Mašina · Nastavení — Lazurio Launchpad",
  });
});
