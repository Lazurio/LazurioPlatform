import { expect, test } from "bun:test";
import {
  parseModuleManifest,
  selectModuleApplication,
} from "../src/modules/manifest";

const fixture = () => ({
  schema_version: "lazurio.module.v1",
  id: "example",
  company: "ExampleOrg",
  tcp_port_policy: { mode: "single" },
  port_leases: [{ id: "main", host: "127.0.0.1", port: 4100 }],
  apps: ["app/package.json", "tools/package.json"],
  default_app: "app/package.json",
});
test("existing module contract selects only explicit declared applications", () => {
  const input = fixture();
  const parsed = parseModuleManifest(input);
  expect(selectModuleApplication(input)).toEqual({
    kind: "selected",
    company: "ExampleOrg",
    module: "example",
    package: "app/package.json",
  });
  expect(selectModuleApplication(input, "tools/package.json").kind).toBe(
    "selected",
  );
  expect(selectModuleApplication(input, "other/package.json").kind).toBe(
    "blocked",
  );
  input.apps.push("changed/package.json");
  expect(parsed.apps).toEqual(["app/package.json", "tools/package.json"]);
  expect(Object.isFrozen(parsed.port_leases[0])).toBe(true);
});
test("legacy missing apps differ from an explicitly app-less module", () => {
  const { apps: _apps, default_app: _default, ...legacy } = fixture();
  expect(parseModuleManifest(legacy).app_declaration_state).toBe(
    "legacy-missing",
  );
  expect(selectModuleApplication(legacy)).toEqual({
    kind: "blocked",
    reason: "explicit-apps-required",
  });
  expect(
    selectModuleApplication({
      ...legacy,
      tcp_port_policy: { mode: "none" },
      port_leases: [],
      apps: [],
    }),
  ).toEqual({ kind: "no-app" });
});
test("module schema rejects ambiguous or unsafe declarations", () => {
  for (const patch of [
    { schema_version: "unknown" },
    { extra: true },
    { company: "../Org" },
    { apps: ["../package.json"] },
    { apps: ["app\\package.json"] },
    { apps: ["/package.json"] },
    { apps: ["app/package.json", "app/package.json"] },
    { default_app: "undeclared/package.json" },
    { tcp_port_policy: { mode: "none" } },
    { tcp_port_policy: { mode: "single", reason: "not allowed" } },
    { port_leases: [{ id: "main", host: "0.0.0.0", port: 4100 }] },
    { port_leases: [{ id: "main", host: "localhost", port: 80 }] },
    { tcp_port_policy: { mode: "exception", reason: "Too short" } },
  ])
    expect(() => parseModuleManifest({ ...fixture(), ...patch })).toThrow();
  let invoked = false;
  const accessor = {
    ...fixture(),
    get id() {
      invoked = true;
      return "example";
    },
  };
  expect(() => parseModuleManifest(accessor)).toThrow();
  expect(invoked).toBe(false);
  const inherited = Object.create(fixture());
  expect(() => parseModuleManifest(inherited)).toThrow();
});
test("exception leases require unique identities and ports", () => {
  const input = {
    ...fixture(),
    tcp_port_policy: {
      mode: "exception",
      reason: "Separate HTTP and auxiliary listener",
    },
    port_leases: [
      { id: "main", host: "127.0.0.1", port: 4100 },
      { id: "aux", host: "::1", port: 4101 },
    ],
  };
  expect(parseModuleManifest(input).port_leases.length).toBe(2);
  expect(() =>
    parseModuleManifest({
      ...input,
      port_leases: [input.port_leases[0], input.port_leases[0]],
    }),
  ).toThrow();
});

test("module reader does not coerce mode objects or invoke array accessors", () => {
  let invoked = false;
  const mode = {
    toString() {
      invoked = true;
      return "single";
    },
  };
  expect(() =>
    parseModuleManifest({ ...fixture(), tcp_port_policy: { mode } }),
  ).toThrow();
  const apps = ["app/package.json"];
  Object.defineProperty(apps, "0", {
    get() {
      invoked = true;
      return "app/package.json";
    },
  });
  expect(() => parseModuleManifest({ ...fixture(), apps })).toThrow();
  expect(() =>
    parseModuleManifest({ ...fixture(), apps: new Array(1) }),
  ).toThrow();
  expect(() =>
    parseModuleManifest({ ...fixture(), id: "example\n" }),
  ).toThrow();
  expect(invoked).toBe(false);
});
