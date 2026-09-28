import { expect, test } from "bun:test";
import {
  isModuleOriginTemplate,
  ModuleOriginError,
  moduleLabel,
  moduleOrigin,
} from "../src/launchpad/hosted-entry";
import { bindings } from "./fixtures/machine-bindings";

const organization = "https://{module}.workspace.example.lazurio.io";
const personal = "https://{module}.example.lazurio.io";

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof ModuleOriginError) return error.code;
    throw error;
  }
  return null;
};

test("the recorded templates of both lanes are the ones a module origin is filled into", () => {
  expect(bindings.organizationEntry.entry?.moduleOriginTemplate).toBe(
    organization,
  );
  expect(bindings.personalEntry.entry?.moduleOriginTemplate).toBe(personal);
});

test("a valid module id is the label the gateway serves: the gateway catalog's label()", () => {
  for (const [id, label] of [
    ["website", "website"],
    ["notes-2", "notes-2"],
    ["0", "0"],
    ["my--notes", "my-notes"],
    ["a--b--c-", "a-b-c"],
    ["website-", "website"],
    ["xn--website", "xn-website"],
    ["api-v2", "api-v2"],
  ] as const)
    expect(moduleLabel(id)).toBe(label);
  // Cut to the gateway's 63 characters, then a trailing dash stripped again.
  expect(moduleLabel("m".repeat(70))).toBe("m".repeat(63));
  expect(moduleLabel(`${"m".repeat(62)}-x`)).toBe("m".repeat(62));
  expect(moduleLabel("m".repeat(128))).toBe("m".repeat(63));
});

test("an id that is not a lazurio.module.v1 id is refused, never lowercased or rewritten", () => {
  for (const id of [
    "",
    "Legacy",
    "My Notes",
    "my notes",
    "web_site",
    "web.site",
    "-lead",
    "---",
    "wébsite",
    "m".repeat(129),
  ])
    expect(refusal(() => moduleLabel(id))).toBe("module-label-invalid");
  for (const id of [42, null, undefined, ["website"]])
    expect(refusal(() => moduleLabel(id))).toBe("module-label-invalid");
});

test("a name the gateway reserves for itself is refused", () => {
  for (const id of ["oauth2", "api", "well-known", "well--known", "api-"])
    expect(refusal(() => moduleLabel(id))).toBe("module-label-reserved");
});

test("moduleOrigin fills the one {module} slot with that label, on both lanes", () => {
  expect(moduleOrigin(organization, "website")).toBe(
    "https://website.workspace.example.lazurio.io",
  );
  expect(moduleOrigin(organization, "my--notes")).toBe(
    "https://my-notes.workspace.example.lazurio.io",
  );
  expect(moduleOrigin(personal, "a--b--c-")).toBe(
    "https://a-b-c.example.lazurio.io",
  );
  expect(refusal(() => moduleOrigin(personal, "Legacy"))).toBe(
    "module-label-invalid",
  );
  expect(refusal(() => moduleOrigin(personal, "oauth2"))).toBe(
    "module-label-reserved",
  );
  expect(refusal(() => moduleOrigin(personal, "---"))).toBe(
    "module-label-invalid",
  );
});

test("a template that is not the declared rule is refused before any substitution", () => {
  for (const template of [
    "https://workspace.example.lazurio.io",
    "http://{module}.workspace.example.lazurio.io",
    "https://{module}",
    "https://app-{module}.workspace.example.lazurio.io",
    "https://{module}-app.workspace.example.lazurio.io",
    "https://workspace.{module}.example.lazurio.io",
    "https://{module}.{module}.example.lazurio.io",
    "https://{module}.workspace.example.lazurio.io/",
    "https://{module}.workspace.example.lazurio.io:8443",
    "https://{module}.Workspace.example.lazurio.io",
    "https://{Module}.workspace.example.lazurio.io",
  ]) {
    expect(isModuleOriginTemplate(template)).toBe(false);
    expect(refusal(() => moduleOrigin(template, "website"))).toBe(
      "module-origin-template-invalid",
    );
  }
});

test("a filled origin longer than a DNS hostname is refused", () => {
  // Three labels of 63 after the module label: over 253 characters of hostname.
  const tail = Array.from({ length: 3 }, () => "l".repeat(63)).join(".");
  const template = `https://{module}.${tail}`;
  expect(isModuleOriginTemplate(template)).toBe(true);
  expect(refusal(() => moduleOrigin(template, "m".repeat(63)))).toBe(
    "module-origin-too-long",
  );
  expect(moduleOrigin(template, "m")).toBe(`https://m.${tail}`);
});
