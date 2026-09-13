import { expect, test } from "bun:test";
import { parseAppRuntime, planModuleRuntime } from "../src/modules/runtime";

const module = {
  schema_version: "lazurio.module.v1",
  id: "example",
  company: "ExampleOrg",
  tcp_port_policy: { mode: "single" },
  port_leases: [{ id: "main", host: "127.0.0.1", port: 4100 }],
  apps: ["app/package.json"],
  default_app: "app/package.json",
};
const runtime = () => ({
  schema_version: "lazurio.runtime.v1",
  id: "example-web",
  title: "Example",
  company: "ExampleOrg",
  module: "example",
  surface: "internal",
  dev_script: "dev",
  tags: ["example"],
  listeners: [
    {
      id: "web",
      role: "entrypoint",
      lease: "main",
      protocol: "http",
      health: { kind: "http", path: "/health" },
    },
  ],
});

test("runtime plan resolves module-owned lease and declared package script", () => {
  const input = runtime();
  const plan = planModuleRuntime(module, input, "app/package.json", {
    dev: "fixture command",
  });
  expect(plan.listeners[0]).toMatchObject({
    host: "127.0.0.1",
    port: 4100,
    lease: "main",
  });
  expect(plan.runtime.dev_script).toBe("dev");
  const listener = input.listeners[0];
  if (!listener) throw new Error("Missing fixture listener");
  listener.health.path = "/changed";
  expect(plan.listeners[0]?.health).toEqual({ kind: "http", path: "/health" });
  expect(Object.isFrozen(plan.listeners[0])).toBe(true);
});
test("runtime cannot select undeclared app, foreign module or absent script", () => {
  for (const patch of [
    { company: "OtherOrg" },
    { module: "other" },
    { dev_script: "missing" },
  ])
    expect(() =>
      planModuleRuntime(
        module,
        { ...runtime(), ...patch },
        "app/package.json",
        { dev: "fixture" },
      ),
    ).toThrow();
  expect(() =>
    planModuleRuntime(module, runtime(), "other/package.json", {
      dev: "fixture",
    }),
  ).toThrow();
  let invoked = false;
  expect(() =>
    planModuleRuntime(module, runtime(), "app/package.json", {
      get dev() {
        invoked = true;
        return "fixture";
      },
    }),
  ).toThrow();
  expect(invoked).toBe(false);
});
test("runtime listener constraints reject ambiguous leases and unsafe health origins", () => {
  const base = runtime();
  const listener = base.listeners[0];
  if (!listener) throw new Error("Missing fixture listener");
  for (const path of [
    "//external.example/health",
    "/\\external.example",
    "/\t/external.example",
    "https://external.example",
    "/health\n",
  ]) {
    expect(() =>
      parseAppRuntime({
        ...base,
        listeners: [{ ...listener, health: { kind: "http", path } }],
      }),
    ).toThrow();
  }
  expect(() => parseAppRuntime({ ...base, listeners: [] })).toThrow();
  expect(() =>
    parseAppRuntime({ ...base, listeners: [listener, listener] }),
  ).toThrow();
  expect(() =>
    parseAppRuntime({ ...base, listeners: [{ ...listener, protocol: "tcp" }] }),
  ).toThrow();
  expect(() =>
    planModuleRuntime(
      module,
      { ...base, listeners: [{ ...listener, lease: "absent" }] },
      "app/package.json",
      { dev: "fixture" },
    ),
  ).toThrow();
  expect(() =>
    parseAppRuntime({
      ...base,
      listeners: [{ ...listener, host: "external.example" }],
    }),
  ).toThrow();
});
test("runtime optional module requirements are retained without claiming availability", () => {
  const parsed = parseAppRuntime({
    ...runtime(),
    required_module_slots: ["workspace/data"],
    description: "Example description",
    build_script: "build",
  });
  expect(parsed.optional.required_module_slots).toEqual(["workspace/data"]);
  expect(parsed.optional.build_script).toBe("build");
  expect(() =>
    parseAppRuntime({ ...runtime(), required_module_slots: ["../data"] }),
  ).toThrow();
  expect(() => parseAppRuntime({ ...runtime(), unknown: "value" })).toThrow();
});
