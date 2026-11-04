import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MachineBinding,
  machineIdentity,
  parseMachineBinding,
} from "../src/folder/machine-binding";
import { withEnvironmentSsh } from "../src/machine/cli";
import {
  MachineContextError,
  parseMachineContext,
} from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import provenance from "../src/machine/schema-provenance.json";
import { bindingValues, contextValues } from "../src/recover/private-values";
import {
  type AccessServiceFetch,
  accessServiceOf,
} from "../src/ssh-access/access-service";
import { routesSourceOf } from "../src/ssh-access/routes";
import { runTool } from "../src/tools/status";
import { binding } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";
import { vendoredSchemaPullRequest } from "./fixtures/machine-schema-pin";

// The handover member that says where the home access service answers
// (decision F70 point 1, root decision 0224; HumanAndMachine-ai/Machines#1040):
// `access_service: {origin: "http://<host node>.<MagicDNS domain>:8444"}` on
// both branches. The Platform takes exactly that origin and nothing looser;
// without the member it declares no service, as before. Every fixture is
// synthetic.

type Json = Record<string, unknown>;
const origin = "http://example-conglomerate-host.tailnet.example.invalid:8444";
const declared = (document: Json, value: unknown = { origin }) => ({
  ...document,
  access_service: value,
});
const parse = (document: unknown) =>
  parseMachineContext(Buffer.from(JSON.stringify(document)));

test("the vendored schema carries Machines #1051's access_service, closed, on both branches", () => {
  // Then to the auth-sourced handover of a free Environment
  // (tests/free-environment-handover.test.ts).
  expect(provenance.source_pull_request).toBe(vendoredSchemaPullRequest);
  expect(provenance.source_sha256).toBe(provenance.sha256);
  const defs = (
    schema as unknown as {
      $defs: Record<
        string,
        { properties?: Record<string, unknown> } & Record<string, unknown>
      >;
    }
  ).$defs;
  for (const branch of ["organization_workspace_vm", "personal_vm"])
    expect(defs[branch]?.properties?.access_service).toEqual({
      $ref: "#/$defs/access_service",
    });
  expect(defs.access_service?.additionalProperties).toBe(false);
  expect(defs.access_service?.required).toEqual(["origin"]);
});

test("a handover with access_service binds its origin on either kind; one without binds the same bytes as before", () => {
  for (const document of [organization, personal] as Json[]) {
    const bound = binding(declared(document));
    expect(bound.accessService).toEqual({ origin });
    expect(accessServiceOf(bound)).toEqual({ origin });
    // Declaration, not identity: the Machine is the same one.
    expect(machineIdentity(bound)).toEqual(machineIdentity(binding(document)));
    // A recorded binding reads back exactly.
    expect(parseMachineBinding(JSON.parse(JSON.stringify(bound)))).toEqual(
      bound,
    );
    const without = binding(document);
    expect(without).not.toHaveProperty("accessService");
    expect(accessServiceOf(without)).toBeNull();
    expect(
      JSON.stringify(parseMachineBinding(JSON.parse(JSON.stringify(without)))),
    ).toBe(JSON.stringify(without));
  }
  expect(accessServiceOf(null)).toBeNull();
  expect(accessServiceOf(undefined)).toBeNull();
});

test("an origin that is not exactly http://, a tailnet DNS name and port 8444 refuses the handover and is never bound", () => {
  const refused = [
    "https://example-conglomerate-host.tailnet.example.invalid:8444",
    "http://example-conglomerate-host.tailnet.example.invalid",
    "http://example-conglomerate-host.tailnet.example.invalid:8443",
    "http://example-conglomerate-host.tailnet.example.invalid:8444/",
    "http://example-conglomerate-host.tailnet.example.invalid:8444/v1/targets",
    "http://user@example-conglomerate-host.tailnet.example.invalid:8444",
    "http://Example-Conglomerate-Host.tailnet.example.invalid:8444",
    "http://example-conglomerate-host:8444",
    "http://100.64.0.1:8444",
    "http://[fd7a:115c:a1e0::1]:8444",
    "http://host.example.123:8444",
    42,
  ];
  for (const document of [organization, personal] as Json[]) {
    for (const value of refused)
      expect(() => parse(declared(document, { origin: value }))).toThrow(
        MachineContextError,
      );
    for (const value of [{}, { origin, token: "x" }, origin, null])
      expect(() => parse(declared(document, value))).toThrow(
        MachineContextError,
      );
  }
  // A stored binding is held to the same rule, and so is a binding built
  // without the parser: such an origin is never asked.
  const bound = binding(declared(organization as Json));
  for (const value of refused) {
    const stored = {
      ...JSON.parse(JSON.stringify(bound)),
      accessService: { origin: value },
    };
    expect(() => parseMachineBinding(stored)).toThrow();
    expect(
      accessServiceOf({
        ...bound,
        accessService: { origin: value },
      } as unknown as MachineBinding),
    ).toBeNull();
  }
  expect(() =>
    parseMachineBinding({
      ...JSON.parse(JSON.stringify(bound)),
      accessService: { origin, token: "x" },
    }),
  ).toThrow();
});

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

test("the machine commands ask the declared origin itself, and without the member a personal Machine keeps its assigned peers", async () => {
  const uid = process.getuid?.();
  const now = Date.parse("2026-11-03T12:00:00Z");
  const calls: string[] = [];
  const fetchImpl: AccessServiceFetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (new URL(url).pathname === "/v1/source-key")
      return new Response(
        JSON.stringify({
          schema_version: "machines.access-source-key-receipt.v1",
          changed: true,
        }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({
        schema_version: "machines.access-targets.v1",
        targets: [],
      }),
      { status: 200 },
    );
  };
  // The live handover declares what each binding declares (decision F70's
  // amendment, point 5).
  const seams = {
    run: runTool,
    now: () => now,
    fetch: fetchImpl,
    current: async () => ({ origin }),
  };
  for (const document of [organization, personal] as Json[]) {
    const home = await mkdtemp(join(tmpdir(), "lazurio-access-handover-"));
    homes.push(home);
    calls.length = 0;
    // No service passed: the commands take it from the binding.
    const result = await withEnvironmentSsh(
      { kind: "refreshed", revision: 2 },
      binding(declared(document)),
      { home, uid },
      undefined,
      seams,
    );
    expect(result).toMatchObject({
      kind: "refreshed",
      environmentRoutes: { targets: "answered" },
    });
    expect(calls).toEqual([
      `PUT ${origin}/v1/source-key`,
      `GET ${origin}/v1/targets`,
    ]);
  }
  // Without the member nothing is asked; a personal Machine keeps the
  // handover's assigned peers (`environmentSsh`).
  const home = await mkdtemp(join(tmpdir(), "lazurio-access-handover-"));
  homes.push(home);
  calls.length = 0;
  const kept = await withEnvironmentSsh(
    { kind: "refreshed", revision: 2 },
    binding(personal),
    { home, uid },
    undefined,
    { ...seams, current: async () => routesSourceOf(binding(personal)) },
  );
  expect(calls).toEqual([]);
  expect(kept).not.toHaveProperty("environmentRoutes");
  expect(kept).toHaveProperty("environmentSsh");
});

// The host's tailnet name is one more internal name: recovery evidence
// withholds it, from the Folder's binding and from the handover alike.
test("the home host's tailnet name is withheld from recovery evidence", () => {
  const host = {
    kind: "hostname",
    value: "example-conglomerate-host.tailnet.example.invalid",
  } as const;
  for (const document of [organization, personal] as Json[]) {
    expect(bindingValues(binding(declared(document)))).toContainEqual(host);
    expect(contextValues(parse(declared(document)))).toContainEqual(host);
    expect(bindingValues(binding(document))).not.toContainEqual(host);
  }
});
