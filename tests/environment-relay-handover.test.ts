import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../src/folder/initialize-folder";
import {
  machineIdentity,
  parseMachineBinding,
} from "../src/folder/machine-binding";
import { executionOs } from "../src/folder/platform";
import { presetProfile } from "../src/folder/presets";
import { refreshFolder } from "../src/folder/update-profile";
import { publicEntry } from "../src/launchpad/chat";
import { machineBinding } from "../src/machine/binding";
import {
  type MachineContext,
  parseMachineContext,
} from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import provenance from "../src/machine/schema-provenance.json";
import {
  binding,
  bindings,
  entries,
  environmentRelaySocket,
  withEnvironmentRelay,
} from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// Root decision 0194 point 3, DEV-6653 contract C3: Machines writes
// `entry.environment_relay = { socket }` on an Organization work VM that
// declares its own identity at the Lazurio issuer (Machines #449), and the
// Launchpad asks the Dashboard as the Environment through that socket. The
// Platform reads exactly what Machines writes: the member is optional,
// closed, and absent means no relay on this Machine.

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const { team: _, ...withoutTeam } = organization.owner;
const workVm = { ...organization, owner: withoutTeam };

test("the vendored schema is Machines #449's, which adds only entry.environment_relay", () => {
  expect(provenance.source_pull_request).toBe(
    "https://github.com/HumanAndMachine-ai/Machines/pull/449",
  );
  const relay = (
    schema as unknown as {
      $defs: {
        entry: { properties: Record<string, unknown> };
      };
    }
  ).$defs.entry.properties.environment_relay;
  expect(relay).toEqual({
    description: expect.any(String),
    type: "object",
    additionalProperties: false,
    required: ["socket"],
    properties: {
      socket: {
        description: "Absolute path of the relay's unix socket.",
        type: "string",
        maxLength: 100,
        pattern: "^/run/[a-z0-9-]+/[a-z0-9-]+\\.sock$",
      },
    },
  });
});

test("a work VM's relay is read exactly as written and projected into the binding", () => {
  const input = {
    ...workVm,
    entry: withEnvironmentRelay(entries.organization),
  };
  const context = parseMachineContext(bytes(input));
  expect(JSON.stringify(context)).toBe(JSON.stringify(input));
  expect(context.entry?.environment_relay).toEqual({
    socket: environmentRelaySocket,
  });
  expect(bindings.organizationRelay.entry?.environmentRelaySocket).toBe(
    environmentRelaySocket,
  );
  // Everything else of the entry is what it was without the relay.
  const { environmentRelaySocket: __, ...rest } = bindings.organizationRelay
    .entry as NonNullable<typeof bindings.organizationRelay.entry>;
  expect(rest).toEqual(bindings.organizationEntry.entry as typeof rest);
  // The relay is a declaration, outside the Machine's identity.
  expect(machineIdentity(bindings.organizationRelay)).toEqual(
    machineIdentity(bindings.organizationEntry),
  );
  // The recorded binding reads back as itself.
  expect(
    parseMachineBinding(JSON.parse(JSON.stringify(bindings.organizationRelay))),
  ).toEqual(bindings.organizationRelay);
});

test("without the relay, the entry and the binding are byte for byte what they were", () => {
  expect(Object.keys(bindings.organizationEntry.entry ?? {})).not.toContain(
    "environmentRelaySocket",
  );
  expect(JSON.stringify(bindings.organizationEntry)).not.toContain(
    "environmentRelay",
  );
});

for (const [name, relay] of Object.entries({
  "a socket outside /run": { socket: "/tmp/lazurio-environment/relay.sock" },
  "a relative socket": { socket: "run/lazurio-environment/relay.sock" },
  "a socket in a nested directory": {
    socket: "/run/lazurio/environment/relay.sock",
  },
  "a socket with upper-case letters": {
    socket: "/run/Lazurio-environment/relay.sock",
  },
  "a socket without .sock": { socket: "/run/lazurio-environment/relay" },
  "a socket longer than 100 characters": {
    socket: `/run/${"a".repeat(90)}/relay.sock`,
  },
  "a relay with another member": {
    socket: environmentRelaySocket,
    token: "never",
  },
  "a relay without its socket": {},
  "a null relay": null,
}))
  test(`the schema refuses ${name}, and no binding records it`, () => {
    expect(() =>
      parseMachineContext(
        bytes({
          ...workVm,
          entry: { ...entries.organization, environment_relay: relay },
        }),
      ),
    ).toThrow("machine-context-invalid");
    const recorded = bindings.organizationEntry.entry;
    // The binding records the socket alone: a relay of any other shape can
    // only arrive there as something that is not a socket path.
    const socket =
      relay !== null &&
      typeof relay === "object" &&
      Object.keys(relay).length === 1 &&
      "socket" in relay
        ? relay.socket
        : relay;
    expect(() =>
      parseMachineBinding({
        ...bindings.organizationEntry,
        entry: { ...recorded, environmentRelaySocket: socket },
      }),
    ).toThrow();
  });

test("a projection that would not read back refuses the handover", () => {
  const context = {
    ...workVm,
    entry: withEnvironmentRelay(entries.organization, "/run/x/../relay.sock"),
  } as unknown as MachineContext;
  expect(() => machineBinding(context, "a".repeat(64))).toThrow(
    "machine-context-invalid",
  );
});

test("the relay socket never reaches the Launchpad's public entry", () => {
  const entry = bindings.organizationRelay.entry ?? null;
  expect(JSON.stringify(publicEntry(entry))).not.toContain("relay");
});

test.skipIf(process.platform === "win32")(
  "a refresh records the relay the handover gained, though no generated text changes",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "environment-relay-handover-")),
    );
    const folder = join(parent, "Lazurio");
    try {
      await mkdir(folder, { mode: 0o700 });
      await mkdir(join(folder, "organizations"), { mode: 0o700 });
      await initializeHandoverFolder(folder, {
        preset: "hosted-organization-personal",
        machine: bindings.organizationEntry,
        profile: presetProfile(
          "hosted-organization-personal",
          executionOs(process.platform),
        ),
      });
      const before = await readFile(join(folder, "AGENTS.md"), "utf8");
      const gained = binding({
        ...workVm,
        entry: withEnvironmentRelay(entries.organization),
      });
      expect(await refreshFolder(folder, gained)).toEqual({
        kind: "refreshed",
        revision: 2,
      });
      const preferences = JSON.parse(
        await readFile(join(folder, ".lazurio", "preferences.json"), "utf8"),
      );
      expect(preferences.machine.entry.environmentRelaySocket).toBe(
        environmentRelaySocket,
      );
      // Agents are not told about the relay; the Folder renders the same text.
      const after = await readFile(join(folder, "AGENTS.md"), "utf8");
      expect(createHash("sha256").update(after).digest("hex")).toBe(
        createHash("sha256").update(before).digest("hex"),
      );
      // The same handover again is unchanged.
      expect(await refreshFolder(folder, gained)).toEqual({
        kind: "unchanged",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("a personal VM's handover may carry the member, and its binding records it", () => {
  // Machines refuses the declaration on a personal VM; the schema's `entry`
  // is shared by both branches, so the reader accepts what it may carry. A
  // personal Environment ignores Organization settings whatever it records.
  const context = parseMachineContext(
    bytes({ ...personal, entry: withEnvironmentRelay(entries.personal) }),
  );
  expect(context.entry?.environment_relay?.socket).toBe(environmentRelaySocket);
  expect(bindings.personalRelay.entry?.environmentRelaySocket).toBe(
    environmentRelaySocket,
  );
});
