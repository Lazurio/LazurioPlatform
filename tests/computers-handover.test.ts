import { expect, test } from "bun:test";
import {
  machineIdentity,
  parseMachineBinding,
} from "../src/folder/machine-binding";
import {
  MachineContextError,
  parseMachineContext,
} from "../src/machine/context";
import schema from "../src/machine/lazurio-machine.v1.schema.json";
import { binding } from "./fixtures/machine-bindings";
import organization from "./fixtures/machine-context.json";
import personal from "./fixtures/machine-context-personal.json";

// The handover member of the device channel (HumanAndMachine-ai/Auth
// docs/device-channel-entry.md; HumanAndMachine-ai/Machines#1370):
// `computers: {session_check_url, assigned_subject}` on an Organization's work
// VM only. The Platform takes exactly those values, by the wire rules, into
// the Machine's binding; without the member it declares no channel and the
// attach route stays closed. Every fixture is synthetic.

type Json = Record<string, unknown>;
const value = {
  session_check_url: "http://127.0.0.1:4182/computers/session",
  assigned_subject: "00000000-0000-4000-8000-0000000000c1",
};
const declared = (document: Json, member: unknown = value) => ({
  ...document,
  computers: member,
});
const parse = (document: unknown) =>
  parseMachineContext(Buffer.from(JSON.stringify(document)));

test("the vendored schema carries computers, closed, on the work branch only", () => {
  const defs = (
    schema as unknown as {
      $defs: Record<
        string,
        { properties?: Record<string, unknown> } & Record<string, unknown>
      >;
    }
  ).$defs;
  expect(defs.organization_workspace_vm?.properties?.computers).toEqual({
    $ref: "#/$defs/computers",
  });
  expect(defs.personal_vm?.properties?.computers).toBeUndefined();
  expect(defs.computers?.additionalProperties).toBe(false);
  expect(defs.computers?.required).toEqual([
    "session_check_url",
    "assigned_subject",
  ]);
});

test("a work VM's computers binds exactly and reads back; without it the binding is as before", () => {
  const bound = binding(declared(organization as Json));
  expect(bound.computers).toEqual({
    sessionCheckUrl: value.session_check_url,
    assignedSubject: value.assigned_subject,
  });
  // Declaration, not identity: the Machine is the same one.
  expect(machineIdentity(bound)).toEqual(
    machineIdentity(binding(organization as Json)),
  );
  expect(parseMachineBinding(JSON.parse(JSON.stringify(bound)))).toEqual(bound);
  expect(binding(organization as Json)).not.toHaveProperty("computers");
});

for (const [why, member] of [
  [
    "a check off loopback",
    { ...value, session_check_url: "http://10.0.0.1:4182/x" },
  ],
  [
    "a check over https",
    { ...value, session_check_url: "https://127.0.0.1:4182/x" },
  ],
  [
    "a check without a path",
    { ...value, session_check_url: "http://127.0.0.1:4182" },
  ],
  [
    "an uppercase subject",
    { ...value, assigned_subject: value.assigned_subject.toUpperCase() },
  ],
  [
    "a subject with its issuer",
    {
      ...value,
      assigned_subject: `https://auth.example/${value.assigned_subject}`,
    },
  ],
  ["an extra member", { ...value, token: "x" }],
  ["a missing member", { session_check_url: value.session_check_url }],
] as const)
  test(`a handover with ${why} in computers is refused`, () => {
    expect(() => parse(declared(organization as Json, member))).toThrow(
      MachineContextError,
    );
  });

test("a personal VM never carries computers, neither in its handover nor in a stored binding", () => {
  expect(() => parse(declared(personal as Json))).toThrow(MachineContextError);
  const stored = JSON.parse(JSON.stringify(binding(personal as Json)));
  stored.computers = {
    sessionCheckUrl: value.session_check_url,
    assignedSubject: value.assigned_subject,
  };
  expect(() => parseMachineBinding(stored)).toThrow();
});
