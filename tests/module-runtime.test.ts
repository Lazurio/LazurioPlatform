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
test("runtime secrets are names only: absent, or a non-empty list of unique upper-case names, never both required and optional (decision F46)", () => {
  // Absent: nothing declared, and the declaration still starts.
  const absent = parseAppRuntime(runtime());
  expect(absent.secrets).toEqual([]);
  expect(absent.optional_secrets).toEqual([]);
  // Declared: exposed on the plan in declaration order, frozen.
  const plan = planModuleRuntime(
    module,
    {
      ...runtime(),
      secrets: ["EXTERNAL_API_KEY", "SECOND_TOKEN_2"],
      optional_secrets: ["OPTIONAL_KEY"],
    },
    "app/package.json",
    { dev: "fixture" },
  );
  expect(plan.runtime.secrets).toEqual(["EXTERNAL_API_KEY", "SECOND_TOKEN_2"]);
  expect(plan.runtime.optional_secrets).toEqual(["OPTIONAL_KEY"]);
  expect(Object.isFrozen(plan.runtime.secrets)).toBe(true);
  expect(
    parseAppRuntime({ ...runtime(), optional_secrets: ["ONLY_OPTIONAL"] })
      .optional_secrets,
  ).toEqual(["ONLY_OPTIONAL"]);
  for (const key of ["secrets", "optional_secrets"])
    for (const refused of [
      [],
      ["EXTERNAL_API_KEY", "EXTERNAL_API_KEY"],
      ["external_api_key"],
      ["1_KEY"],
      ["_KEY"],
      ["KEY-NAME"],
      ["KEY NAME"],
      ["KEY\n"],
      [""],
      [42],
      "EXTERNAL_API_KEY",
      { EXTERNAL_API_KEY: true },
      null,
    ])
      expect(() => parseAppRuntime({ ...runtime(), [key]: refused })).toThrow();
  // One name is either required or optional.
  expect(() =>
    parseAppRuntime({
      ...runtime(),
      secrets: ["EXTERNAL_API_KEY"],
      optional_secrets: ["EXTERNAL_API_KEY"],
    }),
  ).toThrow();
  // A value never belongs in the declaration: an object entry is refused.
  expect(() =>
    parseAppRuntime({
      ...runtime(),
      secrets: [{ name: "EXTERNAL_API_KEY", value: "fake-value" }],
    }),
  ).toThrow();
});
test("a static app declares its build output beside its build script: one HTTP listener, no runtime secrets (decision F58)", () => {
  const built = (extra: Record<string, unknown>) =>
    parseAppRuntime({ ...runtime(), build_script: "build", ...extra });
  // Without `build_output` an app runs its development script only.
  expect(parseAppRuntime(runtime()).static).toBeNull();
  expect(built({}).static).toBeNull();
  expect(built({ build_output: "dist" }).static).toEqual({
    build_script: "build",
    output: "dist",
    fallback: "404",
  });
  expect(
    built({ build_output: "build/client", static_fallback: "spa" }).static,
  ).toEqual({ build_script: "build", output: "build/client", fallback: "spa" });
  for (const output of [
    "",
    "/dist",
    "../dist",
    "dist/../x",
    "./dist",
    "a\\b",
    ".hidden",
    7,
  ])
    expect(() => built({ build_output: output })).toThrow();
  expect(() =>
    built({ build_output: "dist", static_fallback: "index" }),
  ).toThrow();
  expect(() => built({ static_fallback: "spa" })).toThrow();
  expect(() =>
    parseAppRuntime({ ...runtime(), build_output: "dist" }),
  ).toThrow();
  expect(() =>
    built({ build_output: "dist", secrets: ["EXTERNAL_API_KEY"] }),
  ).toThrow();
  expect(() =>
    built({ build_output: "dist", optional_secrets: ["OPTIONAL_KEY"] }),
  ).toThrow();
  const base = runtime();
  const [listener] = base.listeners;
  expect(() =>
    built({
      build_output: "dist",
      listeners: [
        listener,
        { ...listener, id: "api", role: "auxiliary", lease: "api" },
      ],
    }),
  ).toThrow();
  expect(() =>
    built({
      build_output: "dist",
      listeners: [{ ...listener, protocol: "https" }],
    }),
  ).toThrow();
  // The build script must be one of the package's scripts.
  expect(() =>
    planModuleRuntime(
      module,
      { ...runtime(), build_script: "build", build_output: "dist" },
      "app/package.json",
      { dev: "fixture" },
    ),
  ).toThrow("Declared build script missing");
  expect(
    planModuleRuntime(
      module,
      { ...runtime(), build_script: "build", build_output: "dist" },
      "app/package.json",
      { dev: "fixture", build: "fixture build" },
    ).runtime.static?.output,
  ).toBe("dist");
});

test("an app with its own server declares start_script, and its client build_output beside build_script: any listeners and secrets, no static fallback (decision F58, addendum of 2026-10-21)", () => {
  const server = (extra: Record<string, unknown>) =>
    parseAppRuntime({ ...runtime(), start_script: "start", ...extra });
  // Without `start_script` an app has no server run.
  expect(parseAppRuntime(runtime()).server).toBeNull();
  // A server without a client: it builds nothing.
  expect(server({})).toMatchObject({
    static: null,
    server: { start_script: "start", build: null },
  });
  // The same script as the development one, when that is the server.
  expect(server({ start_script: "dev" }).server?.start_script).toBe("dev");
  // Its client: neither one listener nor no secrets is required, because
  // its own process gets them as its development run does.
  const [listener] = runtime().listeners;
  const withClient = server({
    build_script: "build",
    build_output: "dist",
    secrets: ["EXTERNAL_API_KEY"],
    optional_secrets: ["OPTIONAL_KEY"],
    listeners: [
      listener,
      {
        ...listener,
        id: "events",
        role: "auxiliary",
        lease: "events",
        protocol: "tcp",
        health: { kind: "tcp" },
      },
    ],
  });
  expect(withClient.static).toBeNull();
  expect(withClient.server).toEqual({
    start_script: "start",
    build: { output: "dist", build_script: "build" },
  });
  // It routes its own requests; a client still needs its build script and
  // a valid output.
  expect(() =>
    server({
      build_script: "build",
      build_output: "dist",
      static_fallback: "spa",
    }),
  ).toThrow();
  expect(() => server({ static_fallback: "404" })).toThrow();
  expect(() => server({ build_output: "dist" })).toThrow();
  expect(() =>
    server({ build_script: "build", build_output: "../dist" }),
  ).toThrow();
  for (const start of ["", " ", "a\nb", 7, null])
    expect(() => server({ start_script: start })).toThrow();
  // Both scripts must be the package's.
  const plan = (scripts: Record<string, string>, extra = {}) =>
    planModuleRuntime(
      module,
      { ...runtime(), start_script: "start", ...extra },
      "app/package.json",
      scripts,
    );
  expect(() => plan({ dev: "fixture" })).toThrow(
    "Declared start script missing",
  );
  expect(() =>
    plan(
      { dev: "fixture", start: "fixture start" },
      { build_script: "build", build_output: "dist" },
    ),
  ).toThrow("Declared build script missing");
  expect(
    plan(
      { dev: "fixture", start: "fixture start", build: "fixture build" },
      { build_script: "build", build_output: "dist" },
    ).runtime.server?.build?.output,
  ).toBe("dist");
});
