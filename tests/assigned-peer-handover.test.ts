import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import {
  type MachineBinding,
  parseMachineBinding,
} from "../src/folder/machine-binding";
import { presetProfile } from "../src/folder/presets";
import { renderOutputs } from "../src/folder/preview";
import { environmentFacts, peerText } from "../src/launchpad/machine-view";
import { messages } from "../src/launchpad/messages";
import { parseMachineContext } from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import provenance from "../src/machine/schema-provenance.json";
import { bindingValues, contextValues } from "../src/recover/private-values";
import { createSanitizer } from "../src/recover/sanitize";
import { binding, bindings } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import handover from "./fixtures/machine-context-personal-assigned.json";

// Root decision 0192, addendum of 2026-10-26, points (d) and (e), plan
// DEV-6676 P1: SSH from the Osobní Prostředí into every Pracovní Prostředí
// assigned to its Owner in the same tailnet is always on. Machines #948 gives
// such a peer of the personal VM's relationships its Environment id, `access:
// "assigned"` and the host keys from the Organization's records. The Platform
// reads and records them exactly and uses them for nothing yet. The fixture is
// the personal VM of the reference Organization's Bob (synthetic values).

type Json = Record<string, unknown>;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const [laptop, assigned] = handover.relationships.peers as unknown as [
  Json,
  Json,
];
const link = assigned.ssh as Json;
const hostKey =
  "AAAAC3NzaC1lZDI1NTE5AAAAIOosFYFA3vTPDE3z8629wlmF0Qecl1enPwpEjCjOsnfj";
const otherHostKey =
  "AAAAC3NzaC1lZDI1NTE5AAAAIIFygZVmr1cFYx//JrQ0yWhRLdAwCbc1XS4H6ktOFDTx";
// A key of the same shape with its last character changed.
const variant = (character: string) => `${hostKey.slice(0, -1)}${character}`;
const keyed = (...keys: unknown[]) => ({ ...link, host_keys: keys });
const ed25519 = (key: string) => ({ type: "ssh-ed25519", key });
const without = (value: Json, ...keys: string[]) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
// The same work VM as Machines writes it to a Platform below the gate.
const unassigned = {
  ...without(assigned, "environment", "access"),
  ssh: without(link, "host_keys"),
};

test("the vendored schema is Machines #948's: a peer's environment, access and ssh.host_keys, only together", () => {
  // Pending the merge of #948 (schema-provenance.json): its head's bytes.
  expect(provenance.sha256).toBe(
    "ca5cdb767888826fe028e589ea120628a6d830552256cc0d141c0681e038addc",
  );
  expect(provenance.pending).toContain(
    "9e18cd26e7160da6b2ca586851aa5287dbfea4e8",
  );
  expect(provenance.pending).toContain(
    "https://github.com/HumanAndMachine-ai/Machines/pull/948",
  );
  const item = (
    schema as unknown as {
      $defs: {
        relationships: {
          properties: {
            peers: {
              items: {
                additionalProperties: boolean;
                required: string[];
                dependentRequired: unknown;
                if: unknown;
                then: unknown;
                else: unknown;
                properties: Record<string, unknown> & {
                  ssh: {
                    anyOf: [unknown, { properties: Record<string, unknown> }];
                  };
                };
              };
            };
          };
        };
      };
    }
  ).$defs.relationships.properties.peers.items;
  expect(item.additionalProperties).toBe(false);
  // Optional: today's peers are unchanged.
  expect(item.required).toEqual([
    "name",
    "kind",
    "zone",
    "organization",
    "ssh",
    "https",
  ]);
  expect(item.dependentRequired).toEqual({
    access: ["environment"],
    environment: ["access"],
  });
  expect(item.properties.environment).toMatchObject({
    type: "string",
    maxLength: 96,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*\\.[a-z0-9]+(?:-[a-z0-9]+)*$",
  });
  expect(item.properties.access).toMatchObject({ const: "assigned" });
  expect(item.properties.ssh.anyOf[1].properties.host_keys).toMatchObject({
    type: "array",
    minItems: 1,
    maxItems: 4,
    uniqueItems: true,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["type", "key"],
      properties: {
        type: { const: "ssh-ed25519" },
        key: {
          type: "string",
          pattern: "^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$",
        },
      },
    },
  });
  expect(item.if).toEqual({
    properties: { access: { const: "assigned" } },
    required: ["access"],
  });
  expect(item.then).toEqual({
    properties: {
      kind: { const: "workspace-vm" },
      zone: { const: "work" },
      organization: { type: "string" },
      ssh: {
        type: "object",
        required: ["host", "user", "direction", "host_keys"],
        properties: {
          host: true,
          user: { type: "string" },
          direction: { const: "outbound" },
          host_keys: true,
        },
      },
    },
  });
  expect(item.else).toEqual({
    properties: {
      ssh: {
        anyOf: [
          { type: "null" },
          { type: "object", properties: { host_keys: false } },
        ],
      },
    },
  });
  // The reader compiles it strictly (src/machine/context.ts).
  expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow();
});

// The serialized bindings of the existing fixtures at bbad4adf, the base of
// this change, before any peer could carry the members.
const before = {
  personalRelated:
    '{"contextDigest":"543472db4acebce2da98a1b4317f5663fd3b3a5d585898a51b31ca1f82dd30d0","kind":"personal-vm","name":"example","owner":{"kind":"principal","githubLogin":"example","githubId":12345},"network":{"headscaleHostname":"example"},"host":{"kind":"provider-estate","id":"example-estate"},"relationships":{"zone":"personal","peers":[{"name":"example-laptop","kind":"client-device","zone":"personal","organization":null,"ssh":{"host":"example-laptop.tailnet.example.invalid","user":null,"direction":"both"},"https":[]},{"name":"example-workspace","kind":"workspace-vm","zone":"work","organization":"example","ssh":{"host":"example-workspace.tailnet.example.invalid","user":"operator","direction":"outbound"},"https":["launchpad.example-workspace.example.lazurio.io"]}]}}',
  related:
    '{"contextDigest":"3944801c71da3bcec3938cffebf81d14a515fa77e08475233af1c701031a99bb","kind":"workspace-vm","name":"workspace","owner":{"kind":"organization","organization":"example","team":null},"network":{"headscaleHostname":"example-workspace"},"host":{"kind":"virtualization-host","id":"example-host"},"relationships":{"zone":"work","peers":[{"name":"example-laptop","kind":"client-device","zone":"personal","organization":null,"ssh":{"host":"example-laptop.tailnet.example.invalid","user":null,"direction":"inbound"},"https":[]},{"name":"example","kind":"personal-vm","zone":"personal","organization":null,"ssh":{"host":"example.tailnet.example.invalid","user":"operator","direction":"inbound"},"https":[]},{"name":"example-gateway","kind":"conglomerate-host","zone":null,"organization":"example","ssh":null,"https":["auth.example.lazurio.io"]}]}}',
} as const;
test("a handover without the members projects, records and reads back byte for byte as before", () => {
  for (const name of ["personalRelated", "related"] as const) {
    expect(JSON.stringify(bindings[name])).toBe(before[name]);
    expect(JSON.stringify(parseMachineBinding(JSON.parse(before[name])))).toBe(
      before[name],
    );
  }
});

test("with the members the handover reads exactly, and the binding records them exactly and round-trips", () => {
  expect(JSON.stringify(parseMachineContext(bytes(handover)))).toBe(
    JSON.stringify(handover),
  );
  const recorded = bindings.personalAssigned;
  const peers = recorded.relationships?.peers ?? [];
  expect(peers[1]).toEqual({
    name: "lazurioexampleorganization-lazurio-bob-vm",
    kind: "workspace-vm",
    zone: "work",
    organization: "lazurioexampleorganization",
    environment: "lazurio-bob.lazurioexampleorganization",
    access: "assigned",
    ssh: {
      host: "lazurioexampleorganization-lazurio-bob-vm.tailnet.lazurioexampleorganization.lazurio.io",
      user: "lazurio-bob",
      direction: "outbound",
      hostKeys: [{ type: "ssh-ed25519", key: hostKey }],
    },
    https: [],
  });
  // In the parser's order, and no member where the handover has none.
  expect(Object.keys(peers[1] ?? {})).toEqual([
    "name",
    "kind",
    "zone",
    "organization",
    "environment",
    "access",
    "ssh",
    "https",
  ]);
  expect(Object.keys(peers[1]?.ssh ?? {})).toEqual([
    "host",
    "user",
    "direction",
    "hostKeys",
  ]);
  expect(Object.keys(peers[0] ?? {})).toEqual([
    "name",
    "kind",
    "zone",
    "organization",
    "ssh",
    "https",
  ]);
  expect(Object.keys(peers[0]?.ssh ?? {})).toEqual([
    "host",
    "user",
    "direction",
  ]);
  // parse → serialize → parse: the same bytes and the same frozen value.
  const text = JSON.stringify(recorded);
  const read = parseMachineBinding(JSON.parse(text));
  expect(JSON.stringify(read)).toBe(text);
  expect(read).toEqual(recorded);
  expect(parseMachineBinding(JSON.parse(JSON.stringify(read)))).toEqual(read);
  const keys = read?.relationships?.peers[1]?.ssh?.hostKeys;
  expect(Object.isFrozen(keys)).toBe(true);
  expect(Object.isFrozen(keys?.[0])).toBe(true);
});

// How the binding records a handover peer: `ssh.host_keys` as
// `ssh.hostKeys`, everything else under its own name.
function recordedPeer(peer: Json): Json {
  const ssh = peer.ssh;
  if (ssh === null || typeof ssh !== "object" || !("host_keys" in ssh))
    return peer;
  const { host_keys, ...rest } = ssh as Json;
  return { ...peer, ssh: { ...rest, hostKeys: host_keys } };
}
// A handover with this one peer on the personal or the work branch, and the
// stored binding of the same branch with it.
function documentWith(peer: Json, branch: "personal" | "work") {
  return branch === "personal"
    ? { ...handover, relationships: { zone: "personal", peers: [peer] } }
    : { ...organization, relationships: { zone: "work", peers: [peer] } };
}
function storedWith(peer: Json, branch: "personal" | "work") {
  const base: MachineBinding =
    branch === "personal" ? bindings.personalAssigned : bindings.related;
  return {
    ...base,
    relationships: { zone: branch, peers: [recordedPeer(peer)] },
  };
}
const accepts = (read: () => unknown) => {
  try {
    read();
    return true;
  } catch {
    return false;
  }
};

// Every rule of the schema with a mutation it refuses, and the shapes at its
// edges it accepts: the reader and the stored binding's parser agree on each.
const cases: readonly (readonly [
  name: string,
  peer: Json,
  valid: boolean,
  branch?: "personal" | "work",
])[] = [
  ["an assigned work VM with one host key", assigned, true],
  [
    "an assigned work VM with four distinct host keys",
    {
      ...assigned,
      ssh: keyed(
        ed25519(hostKey),
        ed25519(otherHostKey),
        ed25519(variant("A")),
        ed25519(variant("/")),
      ),
    },
    true,
  ],
  [
    "an Environment id of 96 characters",
    { ...assigned, environment: `${"a".repeat(47)}.${"b".repeat(48)}` },
    true,
  ],
  ["the same work VM without the members, as before", unassigned, true],
  // The schema does not tie the members to the personal branch.
  ["an assigned peer on a work VM", assigned, true, "work"],
  ["access without environment", without(assigned, "environment"), false],
  ["environment without access", without(assigned, "access"), false],
  ["access on a client device", { ...assigned, kind: "client-device" }, false],
  ["access on a personal VM", { ...assigned, kind: "personal-vm" }, false],
  [
    "access on a Conglomerate Host",
    { ...assigned, kind: "conglomerate-host" },
    false,
  ],
  [
    "access on a peer of the personal zone",
    { ...assigned, zone: "personal" },
    false,
  ],
  ["access on a peer of no known zone", { ...assigned, zone: null }, false],
  [
    "access without an Organization",
    { ...assigned, organization: null },
    false,
  ],
  ["access other than assigned", { ...assigned, access: "shared" }, false],
  ["a null access", { ...assigned, access: null }, false],
  ["access with no SSH", { ...assigned, ssh: null }, false],
  [
    "access with no account",
    { ...assigned, ssh: { ...link, user: null } },
    false,
  ],
  [
    "access with SSH both ways",
    { ...assigned, ssh: { ...link, direction: "both" } },
    false,
  ],
  [
    "access with SSH inbound",
    { ...assigned, ssh: { ...link, direction: "inbound" } },
    false,
  ],
  [
    "access without host keys",
    { ...assigned, ssh: without(link, "host_keys") },
    false,
  ],
  [
    "host keys without access",
    { ...unassigned, ssh: keyed(ed25519(hostKey)) },
    false,
  ],
  ["empty host keys", { ...assigned, ssh: keyed() }, false],
  [
    "five host keys",
    {
      ...assigned,
      ssh: keyed(
        ed25519(hostKey),
        ed25519(otherHostKey),
        ed25519(variant("A")),
        ed25519(variant("B")),
        ed25519(variant("/")),
      ),
    },
    false,
  ],
  [
    "a duplicate host key",
    { ...assigned, ssh: keyed(ed25519(hostKey), ed25519(hostKey)) },
    false,
  ],
  [
    "a host key with its comment",
    { ...assigned, ssh: keyed(ed25519(`${hostKey} lazurio-bob@example`)) },
    false,
  ],
  [
    "a host key as the whole public key line",
    { ...assigned, ssh: keyed(ed25519(`ssh-ed25519 ${hostKey}`)) },
    false,
  ],
  [
    "a host key of another type",
    { ...assigned, ssh: keyed({ type: "ssh-rsa", key: hostKey }) },
    false,
  ],
  [
    "an ECDSA key blob",
    {
      ...assigned,
      ssh: keyed(
        ed25519(
          "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEXAMPLEEXAMPLE",
        ),
      ),
    },
    false,
  ],
  [
    "a blob one character short",
    { ...assigned, ssh: keyed(ed25519(hostKey.slice(0, -1))) },
    false,
  ],
  [
    "a blob one character long",
    { ...assigned, ssh: keyed(ed25519(`${hostKey}A`)) },
    false,
  ],
  [
    "a blob with padding",
    { ...assigned, ssh: keyed(ed25519(variant("="))) },
    false,
  ],
  [
    "a host key with an unknown member",
    { ...assigned, ssh: keyed({ ...ed25519(hostKey), comment: "laptop" }) },
    false,
  ],
  [
    "a host key without its type",
    { ...assigned, ssh: keyed({ key: hostKey }) },
    false,
  ],
  [
    "host keys that are not a list",
    { ...assigned, ssh: { ...link, host_keys: ed25519(hostKey) } },
    false,
  ],
  [
    "an Environment id of one label",
    { ...assigned, environment: "lazurio-bob" },
    false,
  ],
  [
    "an Environment id of three labels",
    { ...assigned, environment: "lazurio-bob.lazurioexampleorganization.io" },
    false,
  ],
  [
    "an uppercase Environment id",
    { ...assigned, environment: "Lazurio-Bob.lazurioexampleorganization" },
    false,
  ],
  [
    "an Environment id with a doubled hyphen",
    { ...assigned, environment: "lazurio--bob.lazurioexampleorganization" },
    false,
  ],
  [
    "an Environment id of 97 characters",
    { ...assigned, environment: `${"a".repeat(48)}.${"b".repeat(48)}` },
    false,
  ],
  [
    "an unknown member on an assigned peer",
    { ...assigned, grant: "ssh" },
    false,
  ],
];
for (const [name, peer, valid, branch = "personal"] of cases)
  test(`the reader and the stored binding both ${valid ? "accept" : "refuse"} ${name}`, () => {
    const document = documentWith(peer, branch);
    expect([
      accepts(() => parseMachineContext(bytes(document))),
      accepts(() => parseMachineBinding(storedWith(peer, branch))),
    ]).toEqual([valid, valid]);
    if (!valid) return;
    // What the reader accepts projects into a binding that reads back as the
    // same bytes, and that is what the stored binding's parser makes of it.
    const projected = binding(document);
    const text = JSON.stringify(projected);
    expect(JSON.stringify(parseMachineBinding(JSON.parse(text)))).toBe(text);
    expect(projected.relationships?.peers[0]).toEqual(
      parseMachineBinding(storedWith(peer, branch))?.relationships?.peers[0],
    );
  });

test("the members are used by nothing yet: the generated Folder and Toto Prostředí are the same without them", () => {
  const plain = binding({
    ...handover,
    relationships: { zone: "personal", peers: [laptop, unassigned] },
  });
  expect(plain.relationships?.peers[1]).not.toHaveProperty("access");
  for (const locale of ["cs", "en"] as const) {
    const render = (machine: MachineBinding) =>
      renderOutputs({
        preset: "hosted-personal",
        machine,
        profile: presetProfile("hosted-personal", "linux", { locale }),
      });
    expect(render(bindings.personalAssigned)).toEqual(render(plain));
    const copy = messages(locale);
    const facts = (machine: MachineBinding) =>
      environmentFacts(
        {
          preset: "hosted-personal",
          machine,
          organization: () => null,
          team: null,
        },
        copy,
      );
    expect(facts(bindings.personalAssigned)).toEqual(facts(plain));
    const [, pinned] = bindings.personalAssigned.relationships?.peers ?? [];
    const [, bare] = plain.relationships?.peers ?? [];
    if (pinned === undefined || bare === undefined) throw new Error("peers");
    expect(peerText(pinned, copy)).toBe(peerText(bare, copy));
  }
});

// The Environment id is one more name of the peer, `<machine>.<organization>`:
// recovery evidence withholds it whole, from the Folder's binding and from
// the handover alike, not as a login and an Organization joined by a dot.
test("an assigned peer's Environment id is withheld from recovery evidence as the peer's name", () => {
  const environment = {
    kind: "peer",
    value: "lazurio-bob.lazurioexampleorganization",
  } as const;
  expect(bindingValues(bindings.personalAssigned)).toContainEqual(environment);
  expect(contextValues(parseMachineContext(bytes(handover)))).toContainEqual(
    environment,
  );
  const sanitizer = createSanitizer({
    values: bindingValues(bindings.personalAssigned),
  });
  expect(
    sanitizer.sanitize("ssh lazurio-bob.lazurioexampleorganization true"),
  ).toMatch(/^ssh <peer-\d+> true$/);
});
