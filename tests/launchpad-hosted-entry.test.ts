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

test("a module id is the label the gateway serves: the gateway catalog's own normalization", () => {
  for (const [id, label] of [
    ["website", "website"],
    ["notes-2", "notes-2"],
    ["0", "0"],
    ["my--notes", "my-notes"],
    ["My Notes", "my-notes"],
    ["web_site", "web-site"],
    ["web.site", "web-site"],
    ["-website-", "website"],
    ["--a--b--", "a-b"],
    ["wébsite", "w-bsite"],
    ["xn--website", "xn-website"],
    ["API-v2", "api-v2"],
  ] as const)
    expect(moduleLabel(id)).toBe(label);
  // Cut to the gateway's 63 characters, then a trailing dash stripped again.
  expect(moduleLabel("m".repeat(70))).toBe("m".repeat(63));
  expect(moduleLabel(`${"m".repeat(62)}-x`)).toBe("m".repeat(62));
});

test("an id without a label, or one the gateway reserves for itself, is refused", () => {
  for (const id of ["", "---", "_", "..", "ščř"])
    expect(refusal(() => moduleLabel(id))).toBe("module-label-empty");
  for (const id of ["oauth2", "API", "well-known", "Well_Known", "-api-"])
    expect(refusal(() => moduleLabel(id))).toBe("module-label-reserved");
  expect(refusal(() => moduleLabel(42 as unknown as string))).toBe(
    "module-label-empty",
  );
});

test("moduleOrigin fills the one {module} slot with that label, on both lanes", () => {
  expect(moduleOrigin(organization, "website")).toBe(
    "https://website.workspace.example.lazurio.io",
  );
  expect(moduleOrigin(organization, "my--notes")).toBe(
    "https://my-notes.workspace.example.lazurio.io",
  );
  expect(moduleOrigin(personal, "My Notes")).toBe(
    "https://my-notes.example.lazurio.io",
  );
  expect(refusal(() => moduleOrigin(personal, "oauth2"))).toBe(
    "module-label-reserved",
  );
  expect(refusal(() => moduleOrigin(personal, "---"))).toBe(
    "module-label-empty",
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
